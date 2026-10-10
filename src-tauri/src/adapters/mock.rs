use super::{AdapterError, EditRequest, GenerateRequest, ImageAdapter, ProviderConfig};
use base64::Engine;

pub struct MockAdapter;

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
                    "auth" => AdapterError::AuthInvalid { message },
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
            let svg = placeholder_svg(
                &format!("{} [{}]", req.prompt, marker),
                req.width,
                req.height,
                seed,
            );
            Ok(format!(
                "data:image/svg+xml;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(svg.as_bytes())
            ))
        })
    }
}
