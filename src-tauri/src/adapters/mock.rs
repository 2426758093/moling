use super::{
    wants_gif, AdapterError, EditRequest, GenerateRequest, ImageAdapter, ProviderConfig,
    TransformRequest,
};
use base64::Engine;

pub struct MockAdapter;

impl MockAdapter {
    /// 通过提示词注入错误，便于联调错误分类 UI：
    /// "mock:error:auth" / "mock:error:quota" / "mock:error:timeout" / "mock:error:blocked"。
    /// 生成与编辑共用，否则分区重绘的部分失败/可能已计费路径无法在 GUI 里验收。
    fn injected_error(prompt: &str) -> Option<AdapterError> {
        let injected = prompt.strip_prefix("mock:error:")?;
        let message = format!("Mock 注入错误: {injected}");
        Some(match injected {
            // 注入鉴权错误按 401 处理，便于验证多 Key 轮换
            "auth" => AdapterError::AuthInvalid {
                message,
                status: 401,
            },
            "quota" => AdapterError::QuotaExceeded {
                message,
                retry_after: None,
            },
            "timeout" => AdapterError::Timeout { message },
            "blocked" => AdapterError::ContentBlocked { message },
            _ => AdapterError::Network { message },
        })
    }

    /// 本地真实放大（Lanczos3），让放大链路不联网也能完整验收。
    /// detail 模式额外做轻微 unsharpen；`restyle` 用通道轮换模拟换风格（Mock 没有风格模型）。
    fn upscale_data_url(
        image_b64: &str,
        scale: u32,
        mode: &str,
        restyle: bool,
    ) -> Result<String, AdapterError> {
        let raw = crate::image_store::strip_data_url(image_b64);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(raw)
            .map_err(|e| AdapterError::Other {
                message: format!("图片 base64 解码失败: {e}"),
            })?;
        let img = image::load_from_memory(&bytes).map_err(|e| AdapterError::Other {
            message: format!("图片解码失败: {e}"),
        })?;
        let w = img.width().saturating_mul(scale.max(1)).max(1);
        let h = img.height().saturating_mul(scale.max(1)).max(1);
        let resized = img.resize_exact(w, h, image::imageops::FilterType::Lanczos3);
        let mut out_img = if mode == "detail" {
            resized.unsharpen(0.8, 1)
        } else {
            resized
        };
        if restyle {
            let mut rgba = out_img.to_rgba8();
            for px in rgba.pixels_mut() {
                px.0.swap(0, 2);
                px.0[1] = px.0[1].saturating_add(20);
            }
            out_img = image::DynamicImage::ImageRgba8(rgba);
        }
        let mut cursor = std::io::Cursor::new(Vec::new());
        out_img
            .write_to(&mut cursor, image::ImageFormat::Png)
            .map_err(|e| AdapterError::Other {
                message: format!("放大结果编码失败: {e}"),
            })?;
        Ok(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(cursor.into_inner())
        ))
    }

    /// 内部 `output_format="png"` 提示下的编辑结果：真实 PNG，尺寸与请求一致。
    /// 单帧修复与分区重绘的产出必须能被本地位图管线解码（SVG 占位图不行）。
    /// 有蒙版时按 alpha-hole 口径只重涂透明区域、保留不透明像素，
    /// 便于肉眼确认蒙版与合成链路。
    fn edit_raster(req: &EditRequest) -> Result<String, AdapterError> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(crate::image_store::strip_data_url(&req.image_b64))
            .map_err(|e| AdapterError::Other {
                message: format!("图片 base64 解码失败: {e}"),
            })?;
        let img = image::load_from_memory(&bytes).map_err(|e| AdapterError::Other {
            message: format!("图片解码失败: {e}"),
        })?;
        let (w, h) = mock_size(req.width, req.height);
        let mut base = if (img.width(), img.height()) == (w, h) {
            img.to_rgba8()
        } else {
            img.resize_exact(w, h, image::imageops::FilterType::Lanczos3)
                .to_rgba8()
        };
        let hash = req.prompt.bytes().fold(0u64, |acc, b| {
            acc.wrapping_mul(31).wrapping_add(u64::from(b))
        });
        let (r, g, b) = hsl_to_rgb((hash % 360) as f32, 0.85, 0.6);
        let mask = match req.mask_b64.as_deref() {
            Some(mask_b64) => {
                let mask_bytes = base64::engine::general_purpose::STANDARD
                    .decode(crate::image_store::strip_data_url(mask_b64))
                    .map_err(|e| AdapterError::Other {
                        message: format!("蒙版 base64 解码失败: {e}"),
                    })?;
                let mask_img = image::load_from_memory(&mask_bytes)
                    .map_err(|e| AdapterError::Other {
                        message: format!("蒙版解码失败: {e}"),
                    })?
                    .to_rgba8();
                Some(if (mask_img.width(), mask_img.height()) == (w, h) {
                    mask_img
                } else {
                    image::imageops::resize(&mask_img, w, h, image::imageops::FilterType::Nearest)
                })
            }
            None => None,
        };
        for (x, y, px) in base.enumerate_pixels_mut() {
            let coverage = match &mask {
                // 分区蒙版是 alpha-hole 口径：透明处才是选中区域
                Some(mask) => 1.0 - f32::from(mask.get_pixel(x, y).0[3]) / 255.0,
                // 整帧重绘：全局叠 35% 同色，肉眼可辨且不破坏构图
                None => 0.35,
            };
            if coverage <= 0.0 {
                continue;
            }
            for (channel, target) in px.0.iter_mut().zip([r, g, b]) {
                *channel = (f32::from(*channel) * (1.0 - coverage * 0.85)
                    + f32::from(target) * coverage * 0.85)
                    .round()
                    .clamp(0.0, 255.0) as u8;
            }
        }
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(base)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .map_err(|e| AdapterError::Other {
                message: format!("编辑结果编码失败: {e}"),
            })?;
        Ok(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(cursor.into_inner())
        ))
    }
}

fn placeholder_svg(prompt: &str, width: u32, height: u32, seed: u64) -> String {
    let hue = (seed % 360) as f32;
    let hue2 = (hue + 120.0) % 360.0;
    let label: String = prompt
        .chars()
        .take(24)
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl({h1},70%,55%)"/>
      <stop offset="1" stop-color="hsl({h2},70%,35%)"/>
    </linearGradient>
  </defs>
  <rect width="{w}" height="{h}" fill="url(#g)"/>
  <circle cx="{cx}" cy="{cy}" r="{r}" fill="hsla({h2},80%,75%,0.5)"/>
  <text x="50%" y="50%" fill="rgba(255,255,255,0.9)" font-size="{fs}"
        font-family="sans-serif" text-anchor="middle">{label}</text>
  <text x="50%" y="{ty}" fill="rgba(255,255,255,0.6)" font-size="{fs2}"
        font-family="sans-serif" text-anchor="middle">Mock · seed {seed}</text>
</svg>"#,
        w = width,
        h = height,
        h1 = hue,
        h2 = hue2,
        cx = width / 2,
        cy = height / 3,
        r = width.min(height) / 5,
        fs = (width.min(height) as f32 * 0.045).max(14.0),
        fs2 = (width.min(height) as f32 * 0.03).max(10.0),
        ty = height * 55 / 100,
        label = label,
        seed = seed,
    )
}

/// 逐帧变化的占位动图：色相随帧推进，圆点横向移动，便于肉眼确认帧序与帧数。
fn gif_frames(width: u32, height: u32, seed: u64, count: u32) -> Vec<image::RgbaImage> {
    let count = count.clamp(2, 16);
    (0..count)
        .map(|i| {
            let mut img = image::RgbaImage::new(width, height);
            let t = i as f32 / count as f32;
            let hue = ((seed % 360) as f32 + t * 120.0) % 360.0;
            let (br, bg, bb) = hsl_to_rgb(hue, 0.7, 0.55);
            let (dr, dg, db) = hsl_to_rgb((hue + 120.0) % 360.0, 0.8, 0.75);
            let cx = (width as f32 * (0.15 + 0.7 * t)) as i64;
            let cy = height as i64 / 2;
            let radius = (width.min(height) / 6).max(4) as i64;
            for (x, y, px) in img.enumerate_pixels_mut() {
                let vertical = y as f32 / height.max(1) as f32;
                let base = [
                    (f32::from(br) * (1.0 - vertical * 0.35)) as u8,
                    (f32::from(bg) * (1.0 - vertical * 0.35)) as u8,
                    (f32::from(bb) * (1.0 - vertical * 0.35)) as u8,
                ];
                let dx = x as i64 - cx;
                let dy = y as i64 - cy;
                let inside = dx * dx + dy * dy <= radius * radius;
                px.0 = if inside {
                    [dr, dg, db, 255]
                } else {
                    [base[0], base[1], base[2], 255]
                };
            }
            img
        })
        .collect()
}

fn hsl_to_rgb(h: f32, s: f32, l: f32) -> (u8, u8, u8) {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = h / 60.0;
    let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
    let (r, g, b) = match hp as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    (
        ((r + m) * 255.0).round() as u8,
        ((g + m) * 255.0).round() as u8,
        ((b + m) * 255.0).round() as u8,
    )
}

/// 编辑结果动图：以原图为首帧底，按帧做水平轻微偏移与亮度呼吸，帧内像素全部来自真实输入。
fn gif_frames_from_base(base: &image::RgbaImage, count: u32) -> Vec<image::RgbaImage> {
    let count = count.clamp(2, 16);
    let (w, h) = (base.width(), base.height());
    (0..count)
        .map(|i| {
            let t = i as f32 / count as f32;
            let shift = ((t * std::f32::consts::TAU).sin() * (w as f32 * 0.03)) as i64;
            let pulse = 0.92 + 0.08 * (t * std::f32::consts::TAU).cos();
            let mut img = image::RgbaImage::new(w, h);
            for y in 0..h {
                for x in 0..w {
                    let sx = (x as i64 - shift).clamp(0, i64::from(w) - 1) as u32;
                    let mut px = base.get_pixel(sx, y).0;
                    for channel in px.iter_mut().take(3) {
                        *channel = (f32::from(*channel) * pulse).round().clamp(0.0, 255.0) as u8;
                    }
                    img.put_pixel(x, y, image::Rgba(px));
                }
            }
            img
        })
        .collect()
}

fn gif_data_url(frame_ms: u32, frames: Vec<image::RgbaImage>) -> String {
    let delays = vec![frame_ms; frames.len()];
    let bytes =
        crate::animation::encode_fast(&frames, &delays, gif::Repeat::Infinite).unwrap_or_default();
    format!(
        "data:image/gif;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

fn mock_size(width: u32, height: u32) -> (u32, u32) {
    if super::openai::is_auto_size(width, height) {
        (1024, 1024)
    } else {
        (width, height)
    }
}

impl ImageAdapter for MockAdapter {
    fn list_models<'a>(
        &'a self,
        _config: &'a ProviderConfig,
    ) -> super::BoxFuture<'a, Result<Vec<String>, AdapterError>> {
        Box::pin(async move { Ok(vec!["mock-draw-v1".to_string(), "mock-draw-v2".to_string()]) })
    }

    fn generate<'a>(
        &'a self,
        _config: &'a ProviderConfig,
        req: &'a GenerateRequest,
    ) -> super::BoxFuture<'a, Result<Vec<String>, AdapterError>> {
        Box::pin(async move {
            if let Some(err) = Self::injected_error(&req.prompt) {
                return Err(err);
            }
            let mut out = Vec::new();
            let gif = wants_gif(req.output_format.as_deref());
            let frame_count = req.frame_count.unwrap_or(9).clamp(2, 16);
            let frame_ms = req.frame_duration_ms.unwrap_or(200).clamp(20, 2000);
            for i in 0..req.count.max(1) {
                let seed = req.seed.unwrap_or_else(|| rand::random::<u64>() % 100_000);
                let seed = seed.wrapping_add(i as u64);
                // 参考图影响色相，便于验证参考图链路
                let hue_shift = req
                    .images
                    .first()
                    .map(|img| {
                        let bytes = base64::engine::general_purpose::STANDARD
                            .decode(img)
                            .unwrap_or_default();
                        bytes.iter().take(256).map(|b| *b as u64).sum::<u64>() % 180
                    })
                    .unwrap_or(0);
                let label = if req.images.is_empty() {
                    req.prompt.clone()
                } else {
                    format!("[参考图x{}] {}", req.images.len(), req.prompt)
                };
                // 回显负向词，便于在 GUI 里确认整条参数链路生效
                let label = match req
                    .negative_prompt
                    .as_deref()
                    .map(str::trim)
                    .filter(|n| !n.is_empty())
                {
                    Some(neg) => format!("{label} [负向] {neg}"),
                    None => label,
                };
                // 自动尺寸（0×0）在 Mock 里回退到 1024，保证占位 SVG 有合法宽高
                let (w, h) = mock_size(req.width, req.height);
                if gif {
                    let frames = gif_frames(w, h, seed.wrapping_add(hue_shift), frame_count);
                    out.push(gif_data_url(frame_ms, frames));
                    continue;
                }
                let svg = placeholder_svg(&label, w, h, seed.wrapping_add(hue_shift));
                let b64 = base64::engine::general_purpose::STANDARD.encode(svg.as_bytes());
                out.push(format!("data:image/svg+xml;base64,{}", b64));
            }
            Ok(out)
        })
    }

    fn edit<'a>(
        &'a self,
        _config: &'a ProviderConfig,
        req: &'a EditRequest,
    ) -> super::BoxFuture<'a, Result<String, AdapterError>> {
        Box::pin(async move {
            if let Some(err) = Self::injected_error(&req.prompt) {
                return Err(err);
            }
            if wants_gif(req.output_format.as_deref()) {
                // 官方 GIF 编辑不支持蒙版：Mock 与真实适配器保持同一约束，避免 GUI 误判可用
                if req.mask_b64.is_some() {
                    return Err(AdapterError::Unsupported {
                        message: "服务商不支持带蒙版的 GIF 编辑".into(),
                    });
                }
                let raw = crate::image_store::strip_data_url(&req.image_b64);
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(raw)
                    .map_err(|e| AdapterError::Other {
                        message: format!("图片 base64 解码失败: {e}"),
                    })?;
                let base = image::load_from_memory(&bytes)
                    .map_err(|e| AdapterError::Other {
                        message: format!("图片解码失败: {e}"),
                    })?
                    .to_rgba8();
                let (w, h) = mock_size(req.width, req.height);
                let base = if (base.width(), base.height()) == (w, h) {
                    base
                } else {
                    image::imageops::resize(&base, w, h, image::imageops::FilterType::Lanczos3)
                };
                let count = req.frame_count.unwrap_or(9).clamp(2, 16);
                let frame_ms = req.frame_duration_ms.unwrap_or(200).clamp(20, 2000);
                let frames = gif_frames_from_base(&base, count);
                return Ok(gif_data_url(frame_ms, frames));
            }
            // 内部位图提示：单帧修复 / 分区重绘需要下游可解码的真实 PNG
            if req
                .output_format
                .as_deref()
                .is_some_and(|f| f.trim().eq_ignore_ascii_case("png"))
            {
                return Self::edit_raster(req);
            }
            let seed = rand::random::<u64>() % 100_000;
            let marker = if req.mask_b64.is_some() {
                "inpainted"
            } else {
                "edited"
            };
            let label = match req
                .negative_prompt
                .as_deref()
                .map(str::trim)
                .filter(|n| !n.is_empty())
            {
                Some(neg) => format!("{} [{}] [负向] {}", req.prompt, marker, neg),
                None => format!("{} [{}]", req.prompt, marker),
            };
            let svg = placeholder_svg(&label, req.width, req.height, seed);
            Ok(format!(
                "data:image/svg+xml;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(svg.as_bytes())
            ))
        })
    }

    fn transform<'a>(
        &'a self,
        _config: &'a ProviderConfig,
        req: &'a TransformRequest,
    ) -> super::BoxFuture<'a, Result<String, AdapterError>> {
        Box::pin(async move {
            let restyle = req.scale <= 1 && !req.prompt.trim().is_empty();
            Self::upscale_data_url(&req.image_b64, req.scale, &req.mode, restyle)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_b64(w: u32, h: u32) -> String {
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::new(w, h))
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        base64::engine::general_purpose::STANDARD.encode(cursor.into_inner())
    }

    /// Mock 放大是真实 resize：尺寸必须严格翻倍（支持 data URL 与裸 base64 两种入参）
    #[test]
    fn upscale_doubles_dimensions() {
        let b64 = png_b64(64, 32);
        let out = MockAdapter::upscale_data_url(
            &format!("data:image/png;base64,{b64}"),
            2,
            "detail",
            false,
        )
        .unwrap();
        let raw = out.split_once(',').expect("必须返回 data URL").1;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(raw)
            .unwrap();
        let img = image::load_from_memory(&bytes).unwrap();
        assert_eq!((img.width(), img.height()), (128, 64));

        let out = MockAdapter::upscale_data_url(&b64, 4, "faithful", false).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(out.split_once(',').unwrap().1)
            .unwrap();
        let img = image::load_from_memory(&bytes).unwrap();
        assert_eq!((img.width(), img.height()), (256, 128));
    }

    /// 风格转换（restyle）必须真的改变像素，否则界面上看不出任何差别
    #[test]
    fn upscale_restyle_changes_pixels() {
        let b64 = png_b64(16, 16);
        let plain = MockAdapter::upscale_data_url(&b64, 1, "faithful", false).unwrap();
        let styled = MockAdapter::upscale_data_url(&b64, 1, "faithful", true).unwrap();
        assert_ne!(plain, styled, "restyle 必须改变输出");
    }

    /// 坏图给出可读错误，不 panic
    #[test]
    fn upscale_rejects_broken_base64() {
        let err =
            MockAdapter::upscale_data_url("!!!not-base64!!!", 2, "detail", false).unwrap_err();
        assert!(err.message().contains("解码失败"), "{}", err.message());
    }

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }

    fn config() -> ProviderConfig {
        ProviderConfig {
            id: None,
            name: "mock".into(),
            base_url: String::new(),
            api_key: String::new(),
            kind: "mock".into(),
            models_json: String::new(),
            default_model: "mock-draw-v1".into(),
            timeout_secs: 60,
            template_url: String::new(),
            template_body: String::new(),
            template_response_path: String::new(),
            edit_template: None,
            transform_template: None,
            extra_params: String::new(),
        }
    }

    fn gif_bytes(data_url: &str) -> Vec<u8> {
        assert!(data_url.starts_with("data:image/gif;base64,"), "{data_url}");
        base64::engine::general_purpose::STANDARD
            .decode(data_url.split_once(',').unwrap().1)
            .unwrap()
    }

    /// 动图生成必须尊重帧数 / 帧时长 / 尺寸，否则 UI 的「N 帧」全是假的
    #[test]
    fn generate_gif_matches_requested_shape() {
        let req = GenerateRequest {
            prompt: "一只跳跃的猫".into(),
            model: "mock-draw-v1".into(),
            width: 64,
            height: 48,
            count: 2,
            output_format: Some("gif".into()),
            frame_count: Some(5),
            frame_duration_ms: Some(120),
            ..Default::default()
        };
        let out = block_on(MockAdapter.generate(&config(), &req)).unwrap();
        assert_eq!(out.len(), 2);
        for item in out {
            let info = crate::animation::probe(&gif_bytes(&item)).unwrap();
            assert_eq!((info.width, info.height), (64, 48));
            assert_eq!(info.frames, 5);
            assert_eq!(info.durations_ms, vec![120; 5]);
            assert_eq!(info.loop_count, 0);
        }
    }

    /// 帧数超过官方上限时收敛到 16，而不是把请求原样放大
    #[test]
    fn generate_gif_clamps_frame_count() {
        let req = GenerateRequest {
            prompt: "长动图".into(),
            model: "mock-draw-v1".into(),
            width: 32,
            height: 32,
            count: 1,
            output_format: Some("gif".into()),
            frame_count: Some(99),
            ..Default::default()
        };
        let out = block_on(MockAdapter.generate(&config(), &req)).unwrap();
        assert_eq!(
            crate::animation::probe(&gif_bytes(&out[0])).unwrap().frames,
            16
        );
    }

    /// 带图动图编辑：输出真实 GIF，且首帧像素来自输入图
    #[test]
    fn edit_gif_uses_source_image() {
        let src = image::RgbaImage::from_pixel(8, 8, image::Rgba([200, 30, 60, 255]));
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(src)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        let b64 = base64::engine::general_purpose::STANDARD.encode(cursor.into_inner());
        let req = EditRequest {
            prompt: "动起来".into(),
            model: "mock-draw-v1".into(),
            image_b64: b64,
            width: 8,
            height: 8,
            output_format: Some("gif".into()),
            frame_count: Some(3),
            ..Default::default()
        };
        let out = block_on(MockAdapter.edit(&config(), &req)).unwrap();
        let frames = crate::animation::decode_frames(&gif_bytes(&out), 0).unwrap();
        assert_eq!(frames.len(), 3);
        assert_eq!(frames[0].get_pixel(0, 0).0, [200, 30, 60, 255]);
    }

    fn rgba_png(w: u32, h: u32, px: [u8; 4]) -> String {
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(w, h, image::Rgba(px)))
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        base64::engine::general_purpose::STANDARD.encode(cursor.into_inner())
    }

    fn decode_png(data_url: &str) -> image::RgbaImage {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data_url.split_once(',').expect("必须返回 data URL").1)
            .unwrap();
        image::load_from_memory(&bytes).unwrap().to_rgba8()
    }

    /// 内部 png 提示必须返回可解码的真实位图：单帧修复与分区重绘的硬前提
    #[test]
    fn edit_png_hint_returns_raster() {
        let req = EditRequest {
            prompt: "修复这一帧".into(),
            model: "mock-draw-v1".into(),
            image_b64: rgba_png(16, 12, [10, 20, 30, 255]),
            width: 16,
            height: 12,
            output_format: Some("png".into()),
            ..Default::default()
        };
        let out = block_on(MockAdapter.edit(&config(), &req)).unwrap();
        assert!(out.starts_with("data:image/png;base64,"), "{out}");
        let img = decode_png(&out);
        assert_eq!((img.width(), img.height()), (16, 12));
        assert_ne!(
            img.get_pixel(0, 0).0,
            [10, 20, 30, 255],
            "整帧重绘必须改变像素"
        );
    }

    /// 有蒙版时只重涂 alpha-hole 的透明区域，不透明像素必须原样保留
    #[test]
    fn edit_png_hint_respects_mask() {
        // 全不透明底 + 左上角 4×4 挖透明孔（与 MaskCanvas 的 alpha 导出同口径）
        let mut mask = image::RgbaImage::from_pixel(8, 8, image::Rgba([0, 0, 0, 255]));
        for y in 0..4 {
            for x in 0..4 {
                mask.put_pixel(x, y, image::Rgba([0, 0, 0, 0]));
            }
        }
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(mask)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        let mask_b64 = base64::engine::general_purpose::STANDARD.encode(cursor.into_inner());
        let req = EditRequest {
            prompt: "换一块天空".into(),
            model: "mock-draw-v1".into(),
            image_b64: rgba_png(8, 8, [10, 20, 30, 255]),
            mask_b64: Some(mask_b64),
            width: 8,
            height: 8,
            output_format: Some("png".into()),
            ..Default::default()
        };
        let img = decode_png(&block_on(MockAdapter.edit(&config(), &req)).unwrap());
        assert_ne!(img.get_pixel(0, 0).0, [10, 20, 30, 255], "蒙版内必须重绘");
        assert_eq!(img.get_pixel(7, 7).0, [10, 20, 30, 255], "蒙版外必须保留");
    }

    /// 官方 GIF 编辑不支持蒙版：Mock 必须同样拒绝，避免 GUI 误以为可以蒙版动图
    #[test]
    fn edit_gif_rejects_mask() {
        let req = EditRequest {
            prompt: "局部动图".into(),
            model: "mock-draw-v1".into(),
            image_b64: png_b64(8, 8),
            mask_b64: Some(png_b64(8, 8)),
            width: 8,
            height: 8,
            output_format: Some("gif".into()),
            ..Default::default()
        };
        let err = block_on(MockAdapter.edit(&config(), &req)).unwrap_err();
        assert!(matches!(err, AdapterError::Unsupported { .. }));
    }

    /// 编辑路径同样支持错误注入：分区重绘的部分失败 / 可能已计费必须能在 GUI 验收
    #[test]
    fn edit_injects_errors() {
        let req = |prompt: &str| EditRequest {
            prompt: prompt.into(),
            model: "mock-draw-v1".into(),
            image_b64: png_b64(8, 8),
            width: 8,
            height: 8,
            output_format: Some("png".into()),
            ..Default::default()
        };
        let timeout =
            block_on(MockAdapter.edit(&config(), &req("mock:error:timeout"))).unwrap_err();
        assert!(matches!(timeout, AdapterError::Timeout { .. }));
        let quota = block_on(MockAdapter.edit(&config(), &req("mock:error:quota"))).unwrap_err();
        assert!(matches!(quota, AdapterError::QuotaExceeded { .. }));
        assert!(block_on(MockAdapter.edit(&config(), &req("普通提示词"))).is_ok());
    }
}
