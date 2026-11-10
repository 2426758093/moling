//! 本地主体分割：u2netp（320×320 显著性模型）+ ONNX Runtime。
//!
//! 只做「生成可继续修改的蒙版」这一件事：输入的 RGB 图 → 概率图 → 连通域 /
//! 形态学 / 羽化 → 与原图同尺寸的灰度蒙版（255 = 选中）。所有纯函数都可单测，
//! 模型推理放在 `SegmentEngine` 里，前端拿不到原始概率图。

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use image::{GrayImage, Luma, RgbImage};
use ort::session::Session;
use ort::value::Tensor;

/// u2netp 的固定输入边长（模型图里 shape 写死 320）。
pub const MODEL_EDGE: u32 = 320;
/// 显著性阈值：u2net 输出已过 sigmoid，0.5 是常用分界。
pub const THRESHOLD: f32 = 0.5;
/// 点选时允许的「最近前景像素」搜索半径（输出图像素）。
pub const PICK_MISS_PX: u32 = 64;

/// 模型输出的概率图（固定 MODEL_EDGE²）。
pub struct ProbMap {
    pub probs: Vec<f32>,
}

pub struct SegmentInputs {
    pub dll: PathBuf,
    pub model: PathBuf,
}

struct EngineSlot {
    session: Option<Session>,
    error: Option<String>,
}

static INPUTS: OnceLock<SegmentInputs> = OnceLock::new();
static ENGINE: OnceLock<Mutex<EngineSlot>> = OnceLock::new();

/// 记录随包分发的 dll / 模型路径；必须在第一次分割前调用。
pub fn configure(dll: PathBuf, model: PathBuf) {
    let _ = INPUTS.set(SegmentInputs { dll, model });
}

/// 智能蒙版是否可用：文件存在 + 尚未出现加载错误。
/// 返回 `Err(reason)` 时前端把入口置灰并给出可读原因。
pub fn availability() -> Result<(), String> {
    let Some(inputs) = INPUTS.get() else {
        return Err("智能蒙版未初始化".into());
    };
    if !inputs.dll.is_file() {
        return Err("缺少 onnxruntime.dll，智能蒙版不可用".into());
    }
    if !inputs.model.is_file() {
        return Err("缺少分割模型，智能蒙版不可用".into());
    }
    let slot = ENGINE.get_or_init(|| {
        Mutex::new(EngineSlot {
            session: None,
            error: None,
        })
    });
    let guard = slot.lock().map_err(|_| "智能蒙版状态损坏".to_string())?;
    if let Some(err) = &guard.error {
        return Err(err.clone());
    }
    Ok(())
}

pub fn is_loaded() -> bool {
    ENGINE
        .get()
        .and_then(|cell| cell.lock().ok())
        .map(|guard| guard.session.is_some())
        .unwrap_or(false)
}

fn intra_threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| (n.get() / 2).clamp(1, 4))
        .unwrap_or(1)
}

/// 懒加载：应用启动不碰 ORT，首次分割才加载 dll + 模型。
fn with_session<T>(f: impl FnOnce(&mut Session) -> Result<T, String>) -> Result<T, String> {
    availability()?;
    let inputs = INPUTS.get().expect("availability 已确认初始化");
    let cell = ENGINE.get().expect("availability 已确认初始化");
    let mut guard = cell.lock().map_err(|_| "智能蒙版状态损坏".to_string())?;
    if let Some(err) = &guard.error {
        return Err(err.clone());
    }
    if guard.session.is_none() {
        let loaded = (|| -> Result<Session, String> {
            let env = ort::init_from(&inputs.dll)
                .map_err(|e| format!("onnxruntime.dll 加载失败: {e}"))?
                .with_name("moling")
                .build()
                .map_err(|e| format!("ONNX Runtime 初始化失败: {e}"))?;
            let session = Session::builder(&env)
                .map_err(|e| format!("ONNX Runtime 会话创建失败: {e}"))?
                .with_intra_threads(intra_threads())
                .map_err(|e| format!("ONNX Runtime 线程配置失败: {e}"))?
                .commit_from_file(&inputs.model)
                .map_err(|e| format!("分割模型加载失败: {e}"))?;
            Ok(session)
        })();
        match loaded {
            Ok(session) => {
                tracing::info!("分割引擎已加载（{} 线程）", intra_threads());
                guard.session = Some(session);
            }
            Err(e) => {
                tracing::warn!("分割引擎不可用: {e}");
                guard.error = Some(e.clone());
                return Err(e);
            }
        }
    }
    f(guard.session.as_mut().expect("刚确认 session 存在"))
}

/// 对整张图跑一次分割，得到 320×320 概率图。
///
/// `Tensor` 构造会触碰 ORT API，必须放在 `with_session` 里——否则会先按
/// 默认 DLL 名初始化运行时，`init_from` 指定的随包 dll 就再也用不上。
pub fn infer(rgb: &RgbImage) -> Result<ProbMap, String> {
    let input = preprocess(rgb);
    with_session(|session| {
        let tensor = Tensor::from_array(([1i64, 3, MODEL_EDGE as i64, MODEL_EDGE as i64], input))
            .map_err(|e| format!("分割输入构造失败: {e}"))?;
        let outputs = session
            .run(ort::inputs![tensor])
            .map_err(|e| format!("分割推理失败: {e}"))?;
        let (shape, data) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("分割输出读取失败: {e}"))?;
        let expected = (MODEL_EDGE * MODEL_EDGE) as usize;
        if data.len() < expected {
            return Err(format!(
                "分割输出尺寸异常: shape={shape:?} len={}",
                data.len()
            ));
        }
        Ok(ProbMap {
            probs: data[..expected].to_vec(),
        })
    })
}

/// 整图主体蒙版：去噪、补洞、羽化后放大到输出尺寸。
/// 覆盖面积过小视为未识别（宁可不给结果，也不要给一张全黑蒙版）。
pub fn subject_mask(probs: &ProbMap, out_w: u32, out_h: u32) -> Option<GrayImage> {
    let n = (MODEL_EDGE * MODEL_EDGE) as usize;
    let mut bin = binarize(&probs.probs, THRESHOLD);
    if bin.len() != n {
        return None;
    }
    bin = morph(&bin, MODEL_EDGE as usize, MODEL_EDGE as usize, 1, true);
    bin = morph(&bin, MODEL_EDGE as usize, MODEL_EDGE as usize, 1, false);
    keep_large_components(
        &mut bin,
        MODEL_EDGE as usize,
        MODEL_EDGE as usize,
        (n / 1000).max(32),
    );
    let model_mask = feather_binary(&bin, MODEL_EDGE as usize, MODEL_EDGE as usize, 1);
    let out = upscale(&model_mask, out_w, out_h);
    let covered = covered_ratio(&out);
    if covered < 0.002 {
        return None;
    }
    Some(out)
}

/// 点选蒙版：取点击坐标所在的连通域；点在物体外时取半径内最近的前景像素。
pub fn point_mask(
    probs: &ProbMap,
    x: u32,
    y: u32,
    out_w: u32,
    out_h: u32,
    miss_px: u32,
) -> Result<Option<GrayImage>, String> {
    let mw = MODEL_EDGE as usize;
    let mh = MODEL_EDGE as usize;
    let bin = binarize(&probs.probs, THRESHOLD);
    if bin.len() != mw * mh {
        return Err("分割输出尺寸异常".into());
    }
    let sx = ((x as u64 * mw as u64) / out_w.max(1) as u64) as usize;
    let sy = ((y as u64 * mh as u64) / out_h.max(1) as u64) as usize;
    let radius = ((miss_px as u64 * mw as u64) / out_w.max(1) as u64).max(2) as usize;
    let Some(component) = pick_component(&bin, mw, mh, sx.min(mw - 1), sy.min(mh - 1), radius)
    else {
        return Ok(None);
    };
    let model_mask = feather_binary(&component, mw, mh, 1);
    let out = upscale(&model_mask, out_w, out_h);
    if covered_ratio(&out) < 0.0005 {
        return Ok(None);
    }
    Ok(Some(out))
}

/// RGB → 320×320 → NCHW 平面 + ImageNet 归一化（与 rembg 的 u2net 口径一致）。
pub fn preprocess(rgb: &RgbImage) -> Box<[f32]> {
    const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
    const STD: [f32; 3] = [0.229, 0.224, 0.225];
    let resized = image::imageops::resize(
        rgb,
        MODEL_EDGE,
        MODEL_EDGE,
        image::imageops::FilterType::Triangle,
    );
    let plane = (MODEL_EDGE * MODEL_EDGE) as usize;
    let mut out = vec![0f32; plane * 3];
    for (i, px) in resized.pixels().enumerate() {
        for c in 0..3 {
            let v = px[c] as f32 / 255.0;
            out[c * plane + i] = (v - MEAN[c]) / STD[c];
        }
    }
    out.into_boxed_slice()
}

pub fn binarize(probs: &[f32], threshold: f32) -> Vec<bool> {
    probs.iter().map(|p| *p >= threshold).collect()
}

pub fn covered_ratio(mask: &GrayImage) -> f32 {
    if mask.width() == 0 || mask.height() == 0 {
        return 0.0;
    }
    let hit = mask.pixels().filter(|p| p[0] > 0).count();
    hit as f32 / (mask.width() as f32 * mask.height() as f32)
}

/// 灰度蒙版取反（主体 → 背景），保持尺寸与边缘灰度。
pub fn invert(mask: &GrayImage) -> GrayImage {
    let mut out = mask.clone();
    for px in out.pixels_mut() {
        px[0] = 255 - px[0];
    }
    out
}

/// 二值图的膨胀 / 腐蚀（方形结构元，半径 1–2px 足够去掉 320px 网格上的毛刺）。
pub fn morph(bin: &[bool], w: usize, h: usize, radius: usize, dilate: bool) -> Vec<bool> {
    if radius == 0 || bin.len() != w * h {
        return bin.to_vec();
    }
    let mut horizontal = vec![false; bin.len()];
    for y in 0..h {
        for x in 0..w {
            let from = x.saturating_sub(radius);
            let to = (x + radius).min(w - 1);
            let mut hit = !dilate;
            for xx in from..=to {
                let v = bin[y * w + xx];
                if dilate && v {
                    hit = true;
                    break;
                }
                if !dilate && !v {
                    hit = false;
                    break;
                }
            }
            horizontal[y * w + x] = hit;
        }
    }
    let mut out = vec![false; bin.len()];
    for y in 0..h {
        for x in 0..w {
            let from = y.saturating_sub(radius);
            let to = (y + radius).min(h - 1);
            let mut hit = !dilate;
            for yy in from..=to {
                let v = horizontal[yy * w + x];
                if dilate && v {
                    hit = true;
                    break;
                }
                if !dilate && !v {
                    hit = false;
                    break;
                }
            }
            out[y * w + x] = hit;
        }
    }
    out
}

/// 4 邻域连通域标记；label 0 = 背景。
fn label_components(bin: &[bool], w: usize, h: usize) -> (Vec<u32>, Vec<usize>, u32) {
    let mut labels = vec![0u32; bin.len()];
    let mut areas = vec![0usize];
    let mut next = 1u32;
    let mut stack = Vec::new();
    for start in 0..bin.len() {
        if !bin[start] || labels[start] != 0 {
            continue;
        }
        let label = next;
        next += 1;
        let mut area = 0usize;
        labels[start] = label;
        stack.push(start);
        while let Some(idx) = stack.pop() {
            area += 1;
            let x = idx % w;
            let y = idx / w;
            if x > 0 && bin[idx - 1] && labels[idx - 1] == 0 {
                labels[idx - 1] = label;
                stack.push(idx - 1);
            }
            if x + 1 < w && bin[idx + 1] && labels[idx + 1] == 0 {
                labels[idx + 1] = label;
                stack.push(idx + 1);
            }
            if y > 0 && bin[idx - w] && labels[idx - w] == 0 {
                labels[idx - w] = label;
                stack.push(idx - w);
            }
            if y + 1 < h && bin[idx + w] && labels[idx + w] == 0 {
                labels[idx + w] = label;
                stack.push(idx + w);
            }
        }
        areas.push(area);
    }
    (labels, areas, next)
}

/// 丢掉面积过小的连通域（噪点），保留真实前景斑块。
pub fn keep_large_components(bin: &mut [bool], w: usize, h: usize, min_area: usize) {
    let (labels, areas, next) = label_components(bin, w, h);
    if next <= 1 {
        return;
    }
    for i in 0..bin.len() {
        let label = labels[i] as usize;
        if bin[i] && (label >= areas.len() || areas[label] < min_area) {
            bin[i] = false;
        }
    }
}

/// 从 (x, y) 取所在连通域；落在背景时向外找最近的前景像素（半径 `max_radius`）。
pub fn pick_component(
    bin: &[bool],
    w: usize,
    h: usize,
    x: usize,
    y: usize,
    max_radius: usize,
) -> Option<Vec<bool>> {
    if w == 0 || h == 0 || x >= w || y >= h {
        return None;
    }
    let seed = (if bin[y * w + x] {
        Some(y * w + x)
    } else {
        let mut found = None;
        for r in 1..=max_radius {
            // 只扫方环，避免重复检查内部
            for xx in x.saturating_sub(r)..=(x + r).min(w - 1) {
                for yy in [y.saturating_sub(r), (y + r).min(h - 1)] {
                    if bin[yy * w + xx] {
                        found = Some(yy * w + xx);
                        break;
                    }
                }
                if found.is_some() {
                    break;
                }
            }
            if found.is_some() {
                break;
            }
            for yy in y.saturating_sub(r) + 1..(y + r).min(h - 1) {
                for xx in [x.saturating_sub(r), (x + r).min(w - 1)] {
                    if bin[yy * w + xx] {
                        found = Some(yy * w + xx);
                        break;
                    }
                }
                if found.is_some() {
                    break;
                }
            }
            if found.is_some() {
                break;
            }
        }
        found
    })?;
    let (labels, _areas, _next) = label_components(bin, w, h);
    let target = labels[seed];
    if target == 0 {
        return None;
    }
    Some(
        labels
            .iter()
            .map(|label| *label == target)
            .collect::<Vec<bool>>(),
    )
}

fn feather_binary(bin: &[bool], w: usize, h: usize, radius: u32) -> GrayImage {
    let raw = GrayImage::from_fn(w as u32, h as u32, |x, y| {
        Luma([if bin[y as usize * w + x as usize] {
            255
        } else {
            0
        }])
    });
    crate::background::feather(&raw, radius)
}

fn upscale(mask: &GrayImage, out_w: u32, out_h: u32) -> GrayImage {
    let resized = if mask.width() == out_w && mask.height() == out_h {
        mask.clone()
    } else {
        image::imageops::resize(mask, out_w, out_h, image::imageops::FilterType::Triangle)
    };
    // 输出分辨率上的轻羽化：半径随短边缩放，避免高分辨率下出现硬边
    let radius = (out_w.min(out_h) / 600).clamp(1, 6);
    crate::background::feather(&resized, radius)
}

/// 从 data URL 解码（信任边界：前端剪贴板 / 文件），复用统一解码上限。
pub fn decode_data_url(data_url: &str) -> Result<image::DynamicImage, String> {
    use base64::Engine;
    let raw = crate::image_store::strip_data_url(data_url);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw)
        .map_err(|e| format!("图片 base64 解码失败: {e}"))?;
    crate::exif::decode_oriented(&bytes)
}

pub fn mask_to_png_data_url(mask: &GrayImage) -> Result<String, String> {
    use base64::Engine;
    let mut cursor = std::io::Cursor::new(Vec::new());
    mask.write_to(&mut cursor, image::ImageFormat::Png)
        .map_err(|e| format!("蒙版编码失败: {e}"))?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(cursor.into_inner())
    ))
}

/// dll / 模型是否存在于候选路径（命令层用于拼装状态）。
pub fn find_first(paths: &[PathBuf]) -> Option<PathBuf> {
    paths.iter().find(|p| p.is_file()).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid_probs(w: usize, h: usize, f: impl Fn(usize, usize) -> f32) -> ProbMap {
        let mut probs = vec![0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                probs[y * w + x] = f(x, y);
            }
        }
        ProbMap { probs }
    }

    fn square_probs(size: usize, x0: usize, y0: usize, x1: usize, y1: usize) -> ProbMap {
        solid_probs(size, size, |x, y| {
            if x >= x0 && x < x1 && y >= y0 && y < y1 {
                0.9
            } else {
                0.1
            }
        })
    }

    #[test]
    fn preprocess_is_planar_and_normalized() {
        let mut rgb = RgbImage::new(64, 32);
        for px in rgb.pixels_mut() {
            *px = image::Rgb([255, 0, 0]);
        }
        let data = preprocess(&rgb);
        assert_eq!(data.len(), (MODEL_EDGE * MODEL_EDGE * 3) as usize);
        let plane = (MODEL_EDGE * MODEL_EDGE) as usize;
        // 红色：R 通道归一化为 (1-0.485)/0.229 ≈ 2.25，G/B 为负
        assert!((data[0] - (1.0 - 0.485) / 0.229).abs() < 1e-5);
        assert!(data[plane] < 0.0);
        assert!(data[plane * 2] < 0.0);
    }

    #[test]
    fn binarize_uses_inclusive_threshold() {
        let bin = binarize(&[0.49, 0.5, 0.51], 0.5);
        assert_eq!(bin, vec![false, true, true]);
    }

    #[test]
    fn morph_open_removes_single_pixel_speck() {
        let mut bin = vec![false; 9 * 9];
        bin[4 * 9 + 4] = true;
        let opened = morph(&morph(&bin, 9, 9, 1, false), 9, 9, 1, true);
        assert!(!opened.iter().any(|v| *v));
    }

    #[test]
    fn morph_close_fills_single_pixel_hole() {
        let mut bin = vec![true; 9 * 9];
        bin[4 * 9 + 4] = false;
        let closed = morph(&morph(&bin, 9, 9, 1, true), 9, 9, 1, false);
        assert!(closed[4 * 9 + 4]);
    }

    #[test]
    fn morph_keeps_rectangle_stable() {
        let mut bin = vec![false; 20 * 20];
        for y in 5..15 {
            for x in 5..15 {
                bin[y * 20 + x] = true;
            }
        }
        let closed = morph(&morph(&bin, 20, 20, 1, true), 20, 20, 1, false);
        assert_eq!(closed, bin);
    }

    #[test]
    fn keep_components_drops_specks_and_keeps_blob() {
        let (w, h) = (20usize, 20usize);
        let mut bin = vec![false; w * h];
        for y in 5..12 {
            for x in 5..12 {
                bin[y * w + x] = true;
            }
        }
        bin[18 * w + 18] = true;
        keep_large_components(&mut bin, w, h, 4);
        assert!(bin[8 * w + 8]);
        assert!(!bin[18 * w + 18]);
    }

    #[test]
    fn pick_component_returns_clicked_blob_only() {
        let (w, h) = (10usize, 10usize);
        let mut bin = vec![false; w * h];
        for y in 1..4 {
            for x in 1..4 {
                bin[y * w + x] = true;
            }
        }
        for y in 6..9 {
            for x in 6..9 {
                bin[y * w + x] = true;
            }
        }
        let picked = pick_component(&bin, w, h, 2, 2, 3).expect("命中");
        assert!(picked[2 * w + 2]);
        assert!(!picked[7 * w + 7]);
    }

    #[test]
    fn pick_component_falls_back_to_nearest_foreground() {
        let (w, h) = (10usize, 10usize);
        let mut bin = vec![false; w * h];
        bin[5 * w + 5] = true;
        let picked = pick_component(&bin, w, h, 7, 7, 4).expect("半径内找到前景");
        assert!(picked[5 * w + 5]);
    }

    #[test]
    fn pick_component_gives_up_beyond_radius() {
        let (w, h) = (20usize, 20usize);
        let mut bin = vec![false; w * h];
        bin[0] = true;
        assert!(pick_component(&bin, w, h, 19, 19, 4).is_none());
    }

    #[test]
    fn feather_softens_edge_and_preserves_core() {
        let mut bin = vec![false; 40 * 40];
        for y in 10..30 {
            for x in 10..30 {
                bin[y * 40 + x] = true;
            }
        }
        let mask = feather_binary(&bin, 40, 40, 2);
        assert_eq!(mask.get_pixel(20, 20)[0], 255);
        assert_eq!(mask.get_pixel(0, 0)[0], 0);
        let edge = mask.get_pixel(10, 20)[0];
        assert!(edge > 0 && edge < 255, "边缘应被羽化，实际 {edge}");
    }

    #[test]
    fn invert_flips_values() {
        let mask = GrayImage::from_pixel(2, 2, Luma([200]));
        assert_eq!(invert(&mask).get_pixel(0, 0)[0], 55);
    }

    #[test]
    fn upscale_returns_requested_size() {
        let mask = GrayImage::from_pixel(320, 320, Luma([255]));
        let out = upscale(&mask, 1000, 750);
        assert_eq!(out.dimensions(), (1000, 750));
    }

    #[test]
    fn covered_ratio_counts_nonzero() {
        let mut mask = GrayImage::from_pixel(10, 10, Luma([0]));
        mask.put_pixel(0, 0, Luma([255]));
        assert!((covered_ratio(&mask) - 0.01).abs() < 1e-6);
    }

    #[test]
    fn subject_mask_ignores_empty_prediction() {
        let probs = solid_probs(320, 320, |_, _| 0.0);
        assert!(subject_mask(&probs, 640, 480).is_none());
    }

    #[test]
    fn subject_mask_finds_square_subject() {
        let probs = square_probs(320, 80, 60, 240, 260);
        let mask = subject_mask(&probs, 640, 480).expect("应识别到主体");
        assert_eq!(mask.dimensions(), (640, 480));
        assert!(mask.get_pixel(320, 240)[0] > 200);
        assert_eq!(mask.get_pixel(4, 4)[0], 0);
        let ratio = covered_ratio(&mask);
        assert!(ratio > 0.2 && ratio < 0.6, "覆盖率异常: {ratio}");
    }

    #[test]
    fn point_mask_maps_output_coords_to_model_grid() {
        let probs = square_probs(320, 80, 60, 240, 260);
        let mask = point_mask(&probs, 320, 240, 640, 480, PICK_MISS_PX)
            .expect("不应报错")
            .expect("点中主体");
        assert_eq!(mask.dimensions(), (640, 480));
        assert!(mask.get_pixel(320, 240)[0] > 200);
        assert_eq!(mask.get_pixel(8, 8)[0], 0);
    }

    #[test]
    fn point_mask_misses_without_nearby_foreground() {
        let probs = square_probs(320, 0, 0, 40, 40);
        let mask = point_mask(&probs, 500, 500, 640, 480, PICK_MISS_PX).expect("不应报错");
        assert!(mask.is_none(), "远离前景时应视为未命中");
    }

    /// 真实模型冒烟：验证 dll 加载、模型输入输出形状与概率范围。
    /// 默认忽略（不拖慢常规测试）；发布前用
    /// `cargo test --lib segment::tests::real_model_runs -- --ignored` 跑一次。
    #[test]
    #[ignore = "需要随包 onnxruntime.dll 与 u2netp.onnx"]
    fn real_model_runs() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        configure(
            root.join("onnxruntime.dll"),
            root.join("models").join("u2netp.onnx"),
        );
        let rgb = RgbImage::from_fn(64, 64, |x, y| {
            image::Rgb([(x * 4) as u8, (y * 4) as u8, 128])
        });
        let probs = infer(&rgb).expect("模型应能完成推理");
        assert_eq!(probs.probs.len(), (MODEL_EDGE * MODEL_EDGE) as usize);
        assert!(
            probs
                .probs
                .iter()
                .all(|p| p.is_finite() && *p >= -0.01 && *p <= 1.01),
            "概率图应落在 [0,1]"
        );
        assert!(is_loaded());
        availability().expect("资源就绪时不应报不可用");
    }
}
