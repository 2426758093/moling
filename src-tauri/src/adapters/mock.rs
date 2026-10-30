use super::{
    AdapterError, EditRequest, GenerateRequest, ImageAdapter, ProviderConfig, TransformRequest,
};
use base64::Engine;

pub struct MockAdapter;

impl MockAdapter {
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
            // 支持通过提示词注入错误，便于联调错误分类 UI：
            //   "mock:error:auth" / "mock:error:quota" / "mock:error:timeout" / "mock:error:blocked"
            if let Some(injected) = req.prompt.strip_prefix("mock:error:") {
                let message = format!("Mock 注入错误: {}", injected);
                return Err(match injected {
                    // 注入鉴权错误按 401 处理，便于验证多 Key 轮换
                    "auth" => AdapterError::AuthInvalid {
                        message,
                        status: 401,
                    },
                    "quota" => AdapterError::QuotaExceeded { message },
                    "timeout" => AdapterError::Timeout { message },
                    "blocked" => AdapterError::ContentBlocked { message },
                    _ => AdapterError::Network { message },
                });
            }
            let mut out = Vec::new();
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
                let svg =
                    placeholder_svg(&label, req.width, req.height, seed.wrapping_add(hue_shift));
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
}
