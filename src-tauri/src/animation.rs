//! GIF 动图的探测、解码、编码与本地编辑。
//!
//! 只做像素与容器层面的工作，不碰网络：上传下载与计费语义留在适配器 / 命令层。
//! 解码统一走 `image` 的 GIF 解码器（会按 disposal 合成整帧），读元数据走
//! `gif` 的 `skip_frame_decoding`（不付解码像素的代价），编码用 `gif` 直接
//! 控制循环次数与 NeuQuant 速度。

use image::{AnimationDecoder, RgbaImage};
use serde::Serialize;
use std::io::{Cursor, Read};

/// 单张 GIF 的帧数上限（防 GIF 炸弹，也覆盖官方 16 帧上限的宽松余量）
pub const MAX_FRAMES: usize = 64;
/// 单帧像素上限
pub const MAX_FRAME_PIXELS: u64 = 40_000_000;
/// 所有帧合计像素上限
pub const MAX_TOTAL_PIXELS: u64 = 200_000_000;
/// 原始字节上限
pub const MAX_BYTES: usize = 64 * 1024 * 1024;

const DEFAULT_FRAME_MS: u32 = 100;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AnimationInfo {
    pub width: u32,
    pub height: u32,
    pub frames: u32,
    /// GIF 的 Netscape 循环次数：0 = 无限循环；`play_once` 时为 1
    pub loop_count: u32,
    /// 没有 Netscape 循环扩展：播放器只播一遍
    pub play_once: bool,
    pub total_ms: u64,
    pub durations_ms: Vec<u32>,
    pub bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StickerPreset {
    pub name: &'static str,
    pub size: u32,
    pub max_bytes: usize,
    pub frame_ms: u32,
    pub max_frames: usize,
}

pub const STICKER_WECHAT: StickerPreset = StickerPreset {
    name: "wechat",
    size: 240,
    max_bytes: 500 * 1024,
    frame_ms: 80,
    max_frames: 12,
};

pub const STICKER_320: StickerPreset = StickerPreset {
    name: "320",
    size: 320,
    max_bytes: 1024 * 1024,
    frame_ms: 100,
    max_frames: 24,
};

pub const STICKER_512: StickerPreset = StickerPreset {
    name: "512",
    size: 512,
    max_bytes: 2 * 1024 * 1024,
    frame_ms: 100,
    max_frames: 32,
};

pub fn sticker_preset(name: &str) -> Result<StickerPreset, String> {
    match name {
        "wechat" => Ok(STICKER_WECHAT),
        "320" => Ok(STICKER_320),
        "512" => Ok(STICKER_512),
        other => Err(format!("未知的表情包预设: {other}")),
    }
}

fn budget_check(width: u32, height: u32, frames: usize, bytes: usize) -> Result<(), String> {
    if bytes > MAX_BYTES {
        return Err(format!(
            "GIF 体积 {} MB 超过上限 {} MB",
            bytes / (1024 * 1024),
            MAX_BYTES / (1024 * 1024)
        ));
    }
    if frames == 0 {
        return Err("GIF 没有可读取的帧".into());
    }
    if frames > MAX_FRAMES {
        return Err(format!("GIF 帧数 {frames} 超过上限 {MAX_FRAMES}"));
    }
    let frame_pixels = u64::from(width) * u64::from(height);
    if frame_pixels > MAX_FRAME_PIXELS {
        return Err(format!(
            "GIF 单帧像素 {} 超过上限 {}",
            frame_pixels, MAX_FRAME_PIXELS
        ));
    }
    if frame_pixels.saturating_mul(frames as u64) > MAX_TOTAL_PIXELS {
        return Err(format!(
            "GIF 总像素超过上限 {}（{width}×{height} × {frames} 帧）",
            MAX_TOTAL_PIXELS
        ));
    }
    Ok(())
}

fn decoder_options(skip_pixels: bool) -> gif::DecodeOptions {
    let mut opts = gif::DecodeOptions::new();
    opts.set_color_output(gif::ColorOutput::RGBA);
    // 只读元数据时必须跳过 LZW，否则「探测」会退化成一次完整解码
    opts.skip_frame_decoding(skip_pixels);
    opts
}

pub fn probe(bytes: &[u8]) -> Result<AnimationInfo, String> {
    if bytes.len() > MAX_BYTES {
        return Err(format!(
            "GIF 体积 {} MB 超过上限 {} MB",
            bytes.len() / (1024 * 1024),
            MAX_BYTES / (1024 * 1024)
        ));
    }
    probe_reader(Cursor::new(bytes), bytes.len())
}

/// 从磁盘探测：用 BufReader 流式读，不为元数据把整文件载入内存。
/// 画廊列表一次几十条 GIF，逐条整读会明显拖慢首屏。
pub fn probe_path(path: &std::path::Path) -> Result<AnimationInfo, String> {
    let len = std::fs::metadata(path)
        .map_err(|e| format!("读取 GIF 信息失败: {e}"))?
        .len() as usize;
    if len > MAX_BYTES {
        return Err(format!(
            "GIF 体积 {} MB 超过上限 {} MB",
            len / (1024 * 1024),
            MAX_BYTES / (1024 * 1024)
        ));
    }
    let file = std::fs::File::open(path).map_err(|e| format!("读取 GIF 信息失败: {e}"))?;
    probe_reader(std::io::BufReader::new(file), len)
}

/// 循环扩展出现在帧数据之前；只扫头部一小段即可判断有没有写循环扩展。
/// 解码器把「没有扩展」也读成 `Infinite`，所以「播一次」必须自己认。
const LOOP_EXT_SCAN: usize = 8192;

fn has_loop_extension(prefix: &[u8]) -> bool {
    prefix
        .windows(11)
        .any(|w| w == b"NETSCAPE2.0" || w == b"ANIMEXTS1.0")
}

fn probe_reader<R: std::io::Read>(mut reader: R, bytes: usize) -> Result<AnimationInfo, String> {
    let mut head = vec![0u8; LOOP_EXT_SCAN];
    let mut filled = 0;
    while filled < head.len() {
        match reader.read(&mut head[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) => return Err(format!("GIF 解析失败: {e}")),
        }
    }
    head.truncate(filled);
    let play_once = !has_loop_extension(&head);
    let mut decoder = decoder_options(true)
        .read_info(Cursor::new(head).chain(reader))
        .map_err(|e| format!("GIF 解析失败: {e}"))?;
    let width = u32::from(decoder.width());
    let height = u32::from(decoder.height());
    let mut durations_ms = Vec::new();
    while let Some(frame) = decoder
        .next_frame_info()
        .map_err(|e| format!("GIF 帧解析失败: {e}"))?
    {
        // GIF 的 0 延时在浏览器里按 100ms 处理，这里用同一口径
        let delay_cs = u32::from(frame.delay);
        durations_ms.push(if delay_cs == 0 {
            DEFAULT_FRAME_MS
        } else {
            delay_cs * 10
        });
        if durations_ms.len() > MAX_FRAMES {
            return Err(format!(
                "GIF 帧数 {} 超过上限 {MAX_FRAMES}",
                durations_ms.len()
            ));
        }
    }
    budget_check(width, height, durations_ms.len(), bytes)?;
    let total_ms = durations_ms.iter().map(|d| u64::from(*d)).sum();
    // Netscape 循环扩展在读完帧块之后才会被解析出来，必须放在循环之后取
    let loop_count = if play_once {
        1
    } else {
        match decoder.repeat() {
            gif::Repeat::Infinite => 0,
            gif::Repeat::Finite(n) => u32::from(n),
        }
    };
    Ok(AnimationInfo {
        width,
        height,
        frames: durations_ms.len() as u32,
        loop_count,
        play_once,
        total_ms,
        durations_ms,
        bytes,
    })
}

pub fn decode_frames(bytes: &[u8], max_edge: u32) -> Result<Vec<RgbaImage>, String> {
    let info = probe(bytes)?;
    let decoder = image::codecs::gif::GifDecoder::new(Cursor::new(bytes))
        .map_err(|e| format!("GIF 解码器初始化失败: {e}"))?;
    let mut out = Vec::with_capacity(info.frames as usize);
    for frame in decoder.into_frames() {
        let frame = frame.map_err(|e| format!("GIF 帧解码失败: {e}"))?;
        let mut img = frame.into_buffer();
        if max_edge > 0 {
            let longest = img.width().max(img.height());
            if longest > max_edge {
                let scale = max_edge as f32 / longest as f32;
                let w = ((img.width() as f32 * scale).round() as u32).max(1);
                let h = ((img.height() as f32 * scale).round() as u32).max(1);
                img = image::imageops::resize(&img, w, h, image::imageops::FilterType::Lanczos3);
            }
        }
        out.push(img);
        if out.len() > MAX_FRAMES {
            return Err(format!("GIF 帧数超过上限 {MAX_FRAMES}"));
        }
    }
    if out.is_empty() {
        return Err("GIF 没有可读取的帧".into());
    }
    Ok(out)
}

fn encode_with_speed(
    frames: &[RgbaImage],
    delays_ms: &[u32],
    repeat: gif::Repeat,
    speed: i32,
) -> Result<Vec<u8>, String> {
    if frames.is_empty() {
        return Err("没有可编码的帧".into());
    }
    if frames.len() != delays_ms.len() {
        return Err("帧数与帧时长数量不一致".into());
    }
    let (width, height) = (frames[0].width(), frames[0].height());
    if width == 0 || height == 0 {
        return Err("帧尺寸不能为 0".into());
    }
    if width > u16::MAX as u32 || height > u16::MAX as u32 {
        return Err("帧尺寸超过 GIF 上限 65535".into());
    }
    if frames
        .iter()
        .any(|f| f.width() != width || f.height() != height)
    {
        return Err("所有帧必须同尺寸".into());
    }
    let mut buf = Vec::new();
    {
        let mut encoder = gif::Encoder::new(&mut buf, width as u16, height as u16, &[])
            .map_err(|e| format!("GIF 编码器初始化失败: {e}"))?;
        encoder
            .set_repeat(repeat)
            .map_err(|e| format!("GIF 循环设置失败: {e}"))?;
        for (frame, delay_ms) in frames.iter().zip(delays_ms.iter()) {
            let mut rgba = frame.as_raw().clone();
            let mut gif_frame =
                gif::Frame::from_rgba_speed(width as u16, height as u16, &mut rgba, speed);
            // GIF 延时单位是 1/100 秒，四舍五入到最近 10ms
            gif_frame.delay = ((*delay_ms + 5) / 10).min(u32::from(u16::MAX)) as u16;
            encoder
                .write_frame(&gif_frame)
                .map_err(|e| format!("GIF 帧写入失败: {e}"))?;
        }
    }
    Ok(buf)
}

pub fn encode(
    frames: &[RgbaImage],
    delays_ms: &[u32],
    repeat: gif::Repeat,
) -> Result<Vec<u8>, String> {
    if frames.len() > MAX_FRAMES {
        return Err(format!("帧数 {} 超过上限 {MAX_FRAMES}", frames.len()));
    }
    encode_with_speed(frames, delays_ms, repeat, 10)
}

/// 低质量快速编码（Mock 与预览用）：NeuQuant 速度拉满，牺牲色带换编码时间。
pub fn encode_fast(
    frames: &[RgbaImage],
    delays_ms: &[u32],
    repeat: gif::Repeat,
) -> Result<Vec<u8>, String> {
    if frames.len() > MAX_FRAMES {
        return Err(format!("帧数 {} 超过上限 {MAX_FRAMES}", frames.len()));
    }
    encode_with_speed(frames, delays_ms, repeat, 30)
}

fn resize_frames(frames: &[RgbaImage], scale: f32) -> Vec<RgbaImage> {
    frames
        .iter()
        .map(|frame| {
            let w = ((frame.width() as f32 * scale).round() as u32).max(1);
            let h = ((frame.height() as f32 * scale).round() as u32).max(1);
            image::imageops::resize(frame, w, h, image::imageops::FilterType::Lanczos3)
        })
        .collect()
}

fn pick_frames(frames: &[RgbaImage], delays: &[u32], target: usize) -> (Vec<RgbaImage>, Vec<u32>) {
    if frames.len() <= target {
        return (frames.to_vec(), delays.to_vec());
    }
    let step = frames.len() as f32 / target as f32;
    let mut out = Vec::with_capacity(target);
    let mut out_delays = Vec::with_capacity(target);
    for i in 0..target {
        let idx = (i as f32 * step).round() as usize;
        let idx = idx.min(frames.len() - 1);
        out.push(frames[idx].clone());
        out_delays.push(delays[idx]);
    }
    (out, out_delays)
}

/// 按原文件还原循环语义：`Finite(0)` 不写 Netscape 扩展，即「播一次」。
fn repeat_of(info: &AnimationInfo) -> gif::Repeat {
    if info.play_once {
        gif::Repeat::Finite(0)
    } else if info.loop_count == 0 {
        gif::Repeat::Infinite
    } else {
        gif::Repeat::Finite(info.loop_count as u16)
    }
}

/// 依次尝试「降量化 → 缩放 → 减帧」，最多 6 轮；达不到目标时返回最小的一份。
pub fn optimize(bytes: &[u8], target_bytes: usize) -> Result<Vec<u8>, String> {
    let info = probe(bytes)?;
    let frames = decode_frames(bytes, 2048)?;
    let mut best: Option<Vec<u8>> = None;
    let keep = |encoded: Vec<u8>, best: &mut Option<Vec<u8>>| {
        let smaller = best
            .as_ref()
            .map(|b| encoded.len() < b.len())
            .unwrap_or(true);
        if smaller {
            *best = Some(encoded);
        }
    };
    let plans: [(i32, f32, usize); 6] = [
        (10, 1.0, info.frames as usize),
        (20, 1.0, info.frames as usize),
        (30, 1.0, info.frames as usize),
        (20, 0.75, info.frames as usize),
        (30, 0.5, info.frames as usize),
        (30, 0.5, (info.frames as usize / 2).max(2)),
    ];
    for (speed, scale, frame_target) in plans {
        let scaled = if (scale - 1.0).abs() < f32::EPSILON {
            frames.clone()
        } else {
            resize_frames(&frames, scale)
        };
        let (picked, delays) = pick_frames(&scaled, &info.durations_ms, frame_target);
        let encoded = encode_with_speed(&picked, &delays, repeat_of(&info), speed)?;
        let reached = encoded.len() <= target_bytes;
        keep(encoded, &mut best);
        if reached {
            break;
        }
    }
    best.ok_or_else(|| "GIF 优化失败".to_string())
}

pub fn replace_frame(bytes: &[u8], index: usize, frame: &RgbaImage) -> Result<Vec<u8>, String> {
    let info = probe(bytes)?;
    if index >= info.frames as usize {
        return Err(format!("帧序号 {index} 超出范围（共 {} 帧）", info.frames));
    }
    let mut frames = decode_frames(bytes, 0)?;
    let (w, h) = (frames[0].width(), frames[0].height());
    if frame.width() != w || frame.height() != h {
        return Err(format!(
            "替换帧尺寸 {}×{} 与原 GIF {}×{} 不一致",
            frame.width(),
            frame.height(),
            w,
            h
        ));
    }
    frames[index] = frame.clone();
    encode(&frames, &info.durations_ms, repeat_of(&info))
}

fn fit_into_square(frame: &RgbaImage, size: u32) -> RgbaImage {
    let scale = (size as f32 / frame.width() as f32).min(size as f32 / frame.height() as f32);
    let w = ((frame.width() as f32 * scale).round() as u32)
        .max(1)
        .min(size);
    let h = ((frame.height() as f32 * scale).round() as u32)
        .max(1)
        .min(size);
    let resized = image::imageops::resize(frame, w, h, image::imageops::FilterType::Lanczos3);
    let mut canvas = RgbaImage::new(size, size);
    let ox = (size - w) / 2;
    let oy = (size - h) / 2;
    image::imageops::overlay(&mut canvas, &resized, i64::from(ox), i64::from(oy));
    canvas
}

pub fn render_sticker(bytes: &[u8], preset: StickerPreset) -> Result<Vec<u8>, String> {
    let info = probe(bytes)?;
    let frames = decode_frames(bytes, 0)?;
    let (picked, _) = pick_frames(&frames, &info.durations_ms, preset.max_frames);
    let sized: Vec<RgbaImage> = picked
        .iter()
        .map(|f| fit_into_square(f, preset.size))
        .collect();
    let delays = vec![preset.frame_ms; sized.len()];
    let encoded = encode_with_speed(&sized, &delays, gif::Repeat::Infinite, 10)?;
    if encoded.len() <= preset.max_bytes {
        return Ok(encoded);
    }
    optimize(&encoded, preset.max_bytes)
}

pub fn first_frame_png(bytes: &[u8]) -> Result<Vec<u8>, String> {
    probe(bytes)?;
    // 只取迭代器第一项：整段解码会把 16 帧的图白白解一遍
    let decoder = image::codecs::gif::GifDecoder::new(Cursor::new(bytes))
        .map_err(|e| format!("GIF 解码器初始化失败: {e}"))?;
    let first = decoder
        .into_frames()
        .next()
        .ok_or_else(|| "GIF 没有可读取的帧".to_string())?
        .map_err(|e| format!("GIF 帧解码失败: {e}"))?;
    let mut cursor = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(first.into_buffer())
        .write_to(&mut cursor, image::ImageFormat::Png)
        .map_err(|e| format!("首帧编码失败: {e}"))?;
    Ok(cursor.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(color: [u8; 4], w: u32, h: u32) -> RgbaImage {
        RgbaImage::from_pixel(w, h, image::Rgba(color))
    }

    fn sample_gif(frames: usize, delay_ms: u32) -> Vec<u8> {
        let imgs: Vec<RgbaImage> = (0..frames)
            .map(|i| solid([(i * 20) as u8, 40, 200, 255], 16, 16))
            .collect();
        let delays = vec![delay_ms; frames];
        encode(&imgs, &delays, gif::Repeat::Infinite).unwrap()
    }

    #[test]
    fn encode_probe_roundtrip() {
        let bytes = sample_gif(5, 120);
        let info = probe(&bytes).unwrap();
        assert_eq!(info.frames, 5);
        assert_eq!(info.width, 16);
        assert_eq!(info.height, 16);
        assert_eq!(info.loop_count, 0);
        assert_eq!(info.total_ms, 600);
        assert_eq!(info.durations_ms, vec![120; 5]);
        assert_eq!(info.bytes, bytes.len());
    }

    #[test]
    fn probe_rejects_bad_header() {
        assert!(probe(b"not a gif at all").is_err());
    }

    #[test]
    fn probe_reads_finite_loop() {
        let imgs = vec![solid([1, 2, 3, 255], 8, 8), solid([4, 5, 6, 255], 8, 8)];
        let bytes = encode(&imgs, &[200, 200], gif::Repeat::Finite(3)).unwrap();
        assert_eq!(probe(&bytes).unwrap().loop_count, 3);
    }

    #[test]
    fn probe_distinguishes_play_once() {
        let imgs = vec![solid([1, 2, 3, 255], 8, 8), solid([4, 5, 6, 255], 8, 8)];
        let once = encode(&imgs, &[100, 100], gif::Repeat::Finite(0)).unwrap();
        let info = probe(&once).unwrap();
        assert!(info.play_once);
        assert_eq!(info.loop_count, 1);

        let looping = encode(&imgs, &[100, 100], gif::Repeat::Infinite).unwrap();
        let info = probe(&looping).unwrap();
        assert!(!info.play_once);
        assert_eq!(info.loop_count, 0);
    }

    #[test]
    fn replace_frame_keeps_play_once() {
        let imgs = vec![solid([1, 2, 3, 255], 8, 8), solid([4, 5, 6, 255], 8, 8)];
        let once = encode(&imgs, &[100, 100], gif::Repeat::Finite(0)).unwrap();
        let out = replace_frame(&once, 0, &solid([9, 9, 9, 255], 8, 8)).unwrap();
        assert!(probe(&out).unwrap().play_once);
    }

    #[test]
    fn encode_rejects_mismatch() {
        let a = solid([0, 0, 0, 255], 8, 8);
        let b = solid([0, 0, 0, 255], 8, 8);
        assert!(encode(&[a], &[100, 100], gif::Repeat::Infinite).is_err());
        let c = solid([0, 0, 0, 255], 9, 8);
        assert!(encode(&[b, c], &[100, 100], gif::Repeat::Infinite).is_err());
    }

    #[test]
    fn decode_frames_honors_max_edge() {
        let bytes = sample_gif(3, 100);
        let frames = decode_frames(&bytes, 8).unwrap();
        assert_eq!(frames.len(), 3);
        assert_eq!(frames[0].width(), 8);
        assert_eq!(frames[0].height(), 8);
    }

    #[test]
    fn decode_frames_rejects_too_many_frames() {
        let imgs: Vec<RgbaImage> = (0..MAX_FRAMES + 1)
            .map(|_| solid([0, 0, 0, 255], 2, 2))
            .collect();
        let delays = vec![100; imgs.len()];
        // 编码器本身允许写入，探测阶段必须拒绝
        let bytes = encode_with_speed(&imgs, &delays, gif::Repeat::Infinite, 30).unwrap();
        assert!(probe(&bytes).is_err());
        let _ = decode_frames(&bytes, 0).unwrap_err();
    }

    #[test]
    fn optimize_meets_target_or_returns_smallest() {
        let bytes = sample_gif(16, 100);
        let best = optimize(&bytes, 1024).unwrap();
        assert!(!best.is_empty());
        assert!(probe(&best).unwrap().frames >= 2);
    }

    #[test]
    fn replace_frame_keeps_shape() {
        let bytes = sample_gif(4, 150);
        let before = probe(&bytes).unwrap();
        let replacement = solid([250, 0, 0, 255], 16, 16);
        let out = replace_frame(&bytes, 2, &replacement).unwrap();
        let after = probe(&out).unwrap();
        assert_eq!(after.frames, before.frames);
        assert_eq!(after.durations_ms, before.durations_ms);
        assert_eq!(after.width, before.width);
        let frames = decode_frames(&out, 0).unwrap();
        assert_eq!(frames[2].get_pixel(0, 0).0, [250, 0, 0, 255]);
    }

    #[test]
    fn replace_frame_rejects_wrong_size() {
        let bytes = sample_gif(2, 100);
        let wrong = solid([0, 0, 0, 255], 8, 8);
        assert!(replace_frame(&bytes, 0, &wrong).is_err());
        assert!(replace_frame(&bytes, 99, &wrong).is_err());
    }

    #[test]
    fn sticker_preset_shape_and_delay() {
        let bytes = sample_gif(16, 100);
        let out = render_sticker(&bytes, STICKER_WECHAT).unwrap();
        let info = probe(&out).unwrap();
        assert_eq!(info.width, 240);
        assert_eq!(info.height, 240);
        assert_eq!(info.frames, 12);
        assert_eq!(info.loop_count, 0);
        assert!(info.durations_ms.iter().all(|d| *d == 80));
        assert!(out.len() <= STICKER_WECHAT.max_bytes);
    }

    #[test]
    fn first_frame_png_is_decodable() {
        let bytes = sample_gif(3, 100);
        let png = first_frame_png(&bytes).unwrap();
        let img = image::load_from_memory(&png).unwrap();
        assert_eq!((img.width(), img.height()), (16, 16));
    }
}
