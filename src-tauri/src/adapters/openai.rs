use super::{
    classify_http, classify_reqwest, download_image_bytes, http_client, prompt_with_negative,
    AdapterError, EditRequest, GenerateRequest, ImageAdapter, ProviderConfig, TransformRequest,
};
use base64::Engine;

pub struct OpenAiAdapter;

#[derive(serde::Deserialize)]
struct ModelListResponse {
    data: Vec<ModelEntry>,
}

#[derive(serde::Deserialize)]
struct ModelEntry {
    id: String,
}

#[derive(serde::Serialize)]
struct GenerationBody {
    model: String,
    prompt: String,
    n: u32,
    /// None = 自动尺寸：让服务商自己决定，不发 size 字段
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<String>,
    /// None = auto：不发 quality 字段，保持与服务商默认一致
    #[serde(skip_serializing_if = "Option::is_none")]
    quality: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<String>,
}

/// 自动尺寸的约定：宽高同时为 0 表示交给服务商（OpenAI 的 size=auto 等价于省略）。
pub(crate) fn is_auto_size(width: u32, height: u32) -> bool {
    width == 0 && height == 0
}

/// 质量档位映射：DALL·E 3 只认 standard / hd，其余 gpt-image 兼容档位原样发送。
/// auto 与不支持 quality 的 DALL·E 2 一律不发字段，避免严格网关 400。
pub(crate) fn map_quality(model: &str, quality: Option<&str>) -> Option<String> {
    let quality = quality?.trim();
    if quality.is_empty() || quality == "auto" {
        return None;
    }
    let model = model.to_ascii_lowercase();
    if model.contains("dall-e-3") {
        return Some(if quality == "high" { "hd" } else { "standard" }.into());
    }
    if model.contains("dall-e") {
        return None;
    }
    Some(quality.to_string())
}

/// gpt-image / dall-e 系列只支持这几种尺寸，按宽高比吸附到最近档位
pub(crate) fn snap_size(width: u32, height: u32) -> String {
    const PRESETS: [(u32, u32); 3] = [(1024, 1024), (1536, 1024), (1024, 1536)];
    let req_aspect = width as f64 / height.max(1) as f64;
    let mut best = "1024x1024";
    let mut best_dist = f64::MAX;
    for (w, h) in PRESETS {
        let aspect = w as f64 / h as f64;
        let dist = (aspect - req_aspect).abs();
        if dist < best_dist {
            best_dist = dist;
            best = match (w, h) {
                (1536, 1024) => "1536x1024",
                (1024, 1536) => "1024x1536",
                _ => "1024x1024",
            };
        }
    }
    best.to_string()
}

/// 按字符边界截断预览文本（RA-03：按字节切片可能切在多字节字符中间导致 panic）
pub(crate) fn truncate_preview(body: &str, max_chars: usize) -> String {
    match body.char_indices().nth(max_chars) {
        Some((idx, _)) => format!("{}…", &body[..idx]),
        None => body.to_string(),
    }
}

/// 把服务商的「透传参数」JSON 合并进请求体（顶层键覆盖默认值）
pub(crate) fn merge_extra_params(body: &mut serde_json::Value, config: &ProviderConfig) {
    if config.extra_params.trim().is_empty() {
        return;
    }
    if let Ok(extra) = serde_json::from_str::<serde_json::Value>(&config.extra_params) {
        if let (Some(body), Some(extra)) = (body.as_object_mut(), extra.as_object()) {
            for (k, v) in extra {
                body.insert(k.clone(), v.clone());
            }
        }
    }
}

#[derive(serde::Deserialize)]
struct ImageResponse {
    data: Vec<ImageEntry>,
}

#[derive(serde::Deserialize)]
struct ImageEntry {
    b64_json: Option<String>,
    url: Option<String>,
}

impl OpenAiAdapter {
    fn base(config: &ProviderConfig) -> String {
        config.base_url.trim_end_matches('/').to_string()
    }

    fn timeout(config: &ProviderConfig) -> std::time::Duration {
        std::time::Duration::from_secs(config.timeout_secs)
    }

    /// 构造并发送 /images/edits 请求（编辑与变换共用同一端点）。
    async fn post_edit(
        config: &ProviderConfig,
        model: &str,
        prompt: &str,
        image_bytes: Vec<u8>,
        mask_bytes: Option<Vec<u8>>,
        size: Option<String>,
    ) -> Result<ImageResponse, AdapterError> {
        let mut form = reqwest::multipart::Form::new()
            .text("model", model.to_string())
            .text("prompt", prompt.to_string());
        // RA-02：编辑分支同样吸附到服务商支持的尺寸档位，与 generate 保持一致
        if let Some(size) = size {
            form = form.text("size", size);
        }
        form = form.part(
            "image",
            reqwest::multipart::Part::bytes(image_bytes)
                .file_name("image.png")
                .mime_str("image/png")
                .map_err(|e| AdapterError::Other {
                    message: e.to_string(),
                })?,
        );
        if let Some(mask_bytes) = mask_bytes {
            form = form.part(
                "mask",
                reqwest::multipart::Part::bytes(mask_bytes)
                    .file_name("mask.png")
                    .mime_str("image/png")
                    .map_err(|e| AdapterError::Other {
                        message: e.to_string(),
                    })?,
            );
        }
        let resp = http_client()
            .post(format!("{}/images/edits", Self::base(config)))
            .timeout(Self::timeout(config))
            .bearer_auth(&config.api_key)
            .multipart(form)
            .send()
            .await
            .map_err(|e| classify_reqwest(&e))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(classify_http(status, &text));
        }
        super::parse_json_body(resp, "/images/edits").await
    }

    async fn first_image_b64(
        parsed: ImageResponse,
        timeout: std::time::Duration,
    ) -> Result<String, AdapterError> {
        let entry = parsed.data.first().ok_or_else(|| AdapterError::Other {
            message: "API 未返回图片".into(),
        })?;
        Self::fetch_image_b64(entry, timeout).await
    }

    /// F-012：服务商返回 200 但 data 为空时，上抛可读错误而不是成功返回 0 张图
    fn ensure_generated(out: Vec<String>) -> Result<Vec<String>, AdapterError> {
        if out.is_empty() {
            return Err(AdapterError::Other {
                message: "API 未返回图片".into(),
            });
        }
        Ok(out)
    }

    /// 下载图片 URL（RA-05：必须带服务商超时，避免下载阶段无限挂起）
    async fn fetch_image_b64(
        entry: &ImageEntry,
        timeout: std::time::Duration,
    ) -> Result<String, AdapterError> {
        if let Some(b64) = &entry.b64_json {
            return Ok(b64.clone());
        }
        if let Some(url) = &entry.url {
            // F-011：统一走带状态码 / 体积上限 / 魔数校验的下载函数
            let bytes = download_image_bytes(url, timeout).await?;
            return Ok(base64::engine::general_purpose::STANDARD.encode(&bytes));
        }
        Err(AdapterError::Other {
            message: "API 返回的图片缺少 b64_json 与 url 字段".into(),
        })
    }
}

/// 无原生超分端点时，用指令化编辑表达放大：faithful 保真、detail 加细节。
/// 风格转换（scale ≤ 1 且带风格描述）换用换风格措辞，不出现无意义的 "1x"。
pub(crate) fn transform_prompt(mode: &str, scale: u32, extra: &str) -> String {
    let extra = extra.trim();
    if scale <= 1 && !extra.is_empty() {
        return format!(
            "Restyle this image following the description below. Keep the subject, composition, \
             identity and layout intact; only change the rendering style.\n\n{extra}"
        );
    }
    let base = if mode == "faithful" {
        format!(
            "Upscale this image to {scale}x resolution. Preserve the exact composition, colors, \
             identity and text; do not add, remove or restyle any element."
        )
    } else {
        format!(
            "Upscale this image to {scale}x resolution. Enhance fine details, texture and \
             sharpness while keeping composition and colors faithful."
        )
    };
    if extra.is_empty() {
        base
    } else {
        format!("{base}\n\n{extra}")
    }
}

/// 按原图尺寸 × 倍数得到服务商支持的尺寸档位；图片无法解码时不带 size 字段。
/// 风格转换（scale ≤ 1）不带 size：让服务商保持原尺寸，只换风格。
fn scaled_size(bytes: &[u8], scale: u32) -> Option<String> {
    if scale <= 1 {
        return None;
    }
    let img = image::load_from_memory(bytes).ok()?;
    Some(snap_size(
        img.width().saturating_mul(scale.max(1)),
        img.height().saturating_mul(scale.max(1)),
    ))
}

impl ImageAdapter for OpenAiAdapter {
    fn list_models<'a>(
        &'a self,
        config: &'a ProviderConfig,
    ) -> super::BoxFuture<'a, Result<Vec<String>, AdapterError>> {
        Box::pin(async move {
            let resp = http_client()
                .get(format!("{}/models", Self::base(config)))
                .timeout(Self::timeout(config))
                .bearer_auth(&config.api_key)
                .send()
                .await
                .map_err(|e| classify_reqwest(&e))?;
            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(classify_http(status, &body));
            }
            let body = resp.text().await.map_err(|e| classify_reqwest(&e))?;
            if let Ok(list) = serde_json::from_str::<ModelListResponse>(&body) {
                return Ok(list.data.into_iter().map(|m| m.id).collect());
            }
            Err(AdapterError::Other {
                message: format!("/models 返回格式无法解析: {}", truncate_preview(&body, 300)),
            })
        })
    }

    fn generate<'a>(
        &'a self,
        config: &'a ProviderConfig,
        req: &'a GenerateRequest,
    ) -> super::BoxFuture<'a, Result<Vec<String>, AdapterError>> {
        Box::pin(async move {
            let mut body = serde_json::to_value(GenerationBody {
                model: req.model.clone(),
                prompt: prompt_with_negative(&req.prompt, req.negative_prompt.as_deref()),
                // count 映射为 OpenAI n 参数；多图返回在下方按 data 数组逐项解析
                n: req.count.max(1),
                size: if is_auto_size(req.width, req.height) {
                    None
                } else {
                    Some(snap_size(req.width, req.height))
                },
                quality: map_quality(&req.model, req.quality.as_deref()),
                response_format: Some("b64_json".into()),
            })
            .map_err(|e| AdapterError::Other {
                message: e.to_string(),
            })?;
            merge_extra_params(&mut body, config);
            let resp = if req.images.is_empty() {
                // 纯文生图：JSON 请求 /images/generations
                http_client()
                    .post(format!("{}/images/generations", Self::base(config)))
                    .timeout(Self::timeout(config))
                    .bearer_auth(&config.api_key)
                    .json(&body)
                    .send()
                    .await
                    .map_err(|e| classify_reqwest(&e))?
            } else {
                // 参考图（图生图/编辑）：gpt-image 规范走 multipart /images/edits；
                // RA-01：此前只搬运字符串字段，导致数字型 n 丢失，这里按标量统一转文本，
                // 覆盖 model/prompt/n/size/response_format 以及透传的标量参数。
                let mut form = reqwest::multipart::Form::new();
                if let Some(obj) = body.as_object() {
                    for (key, value) in obj {
                        let text = match value {
                            serde_json::Value::String(s) => s.clone(),
                            serde_json::Value::Number(n) => n.to_string(),
                            serde_json::Value::Bool(b) => b.to_string(),
                            // 嵌套对象/数组无法作为表单文本字段，跳过
                            _ => continue,
                        };
                        form = form.text(key.clone(), text);
                    }
                }
                for (i, img_b64) in req.images.iter().enumerate() {
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(img_b64)
                        .map_err(|e| AdapterError::Other {
                            message: format!("参考图 base64 解码失败: {}", e),
                        })?;
                    // 文件名与 MIME 按真实格式上报：压缩后的参考图多为 JPEG，
                    // 谎报 image/png 会被严格网关拒绝
                    let (ext, mime) = crate::image_store::sniff_image_mime(&bytes);
                    form = form.part(
                        "image[]",
                        reqwest::multipart::Part::bytes(bytes)
                            // 文件名必须带扩展名，否则服务商可能按二进制拒绝
                            .file_name(format!("ref.{}.{}", i, ext))
                            .mime_str(mime)
                            .map_err(|e| AdapterError::Other {
                                message: e.to_string(),
                            })?,
                    );
                }
                http_client()
                    .post(format!("{}/images/edits", Self::base(config)))
                    .timeout(Self::timeout(config))
                    .bearer_auth(&config.api_key)
                    .multipart(form)
                    .send()
                    .await
                    .map_err(|e| classify_reqwest(&e))?
            };
            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                return Err(classify_http(status, &text));
            }
            let parsed: ImageResponse = super::parse_json_body(resp, "/images/generations").await?;
            let mut out = Vec::new();
            for entry in &parsed.data {
                out.push(Self::fetch_image_b64(entry, Self::timeout(config)).await?);
            }
            Self::ensure_generated(out)
        })
    }

    fn edit<'a>(
        &'a self,
        config: &'a ProviderConfig,
        req: &'a EditRequest,
    ) -> super::BoxFuture<'a, Result<String, AdapterError>> {
        Box::pin(async move {
            let image_bytes = base64::engine::general_purpose::STANDARD
                .decode(&req.image_b64)
                .map_err(|e| AdapterError::Other {
                    message: format!("图片 base64 解码失败: {}", e),
                })?;
            let mask_bytes = match &req.mask_b64 {
                Some(mask_b64) => Some(
                    base64::engine::general_purpose::STANDARD
                        .decode(mask_b64)
                        .map_err(|e| AdapterError::Other {
                            message: format!("蒙版 base64 解码失败: {}", e),
                        })?,
                ),
                None => None,
            };
            let parsed = Self::post_edit(
                config,
                &req.model,
                &prompt_with_negative(&req.prompt, req.negative_prompt.as_deref()),
                image_bytes,
                mask_bytes,
                Some(snap_size(req.width, req.height)),
            )
            .await?;
            Self::first_image_b64(parsed, Self::timeout(config)).await
        })
    }

    fn transform<'a>(
        &'a self,
        config: &'a ProviderConfig,
        req: &'a TransformRequest,
    ) -> super::BoxFuture<'a, Result<String, AdapterError>> {
        Box::pin(async move {
            let image_bytes = base64::engine::general_purpose::STANDARD
                .decode(&req.image_b64)
                .map_err(|e| AdapterError::Other {
                    message: format!("图片 base64 解码失败: {}", e),
                })?;
            let size = scaled_size(&image_bytes, req.scale);
            let prompt = transform_prompt(&req.mode, req.scale, &req.prompt);
            let parsed =
                Self::post_edit(config, &req.model, &prompt, image_bytes, None, size).await?;
            Self::first_image_b64(parsed, Self::timeout(config)).await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RA-03：超长中文响应体按字符截断，不 panic，末尾补省略号
    #[test]
    fn truncate_preview_keeps_char_boundary_on_chinese() {
        let body = "接口返回错误：中文错误信息".repeat(50); // 远超 300 字符
        let cut = truncate_preview(&body, 300);
        assert_eq!(cut.chars().count(), 301, "300 字符 + 1 个省略号");
        assert!(cut.ends_with('…'));
        assert!(body.starts_with(cut.trim_end_matches('…')));
    }

    #[test]
    fn truncate_preview_short_or_empty_body_unchanged() {
        assert_eq!(truncate_preview("短文本", 300), "短文本");
        assert_eq!(truncate_preview("", 300), "");
        // 恰好等于上限时不截断、不补省略号
        let exact: String = "边".repeat(300);
        assert_eq!(truncate_preview(&exact, 300), exact);
    }

    /// 放大提示词：倍数写进指令；faithful 强调保真，detail 强调细节；风格词追加在末尾
    #[test]
    fn transform_prompt_modes_and_extra() {
        let faithful = transform_prompt("faithful", 2, "");
        assert!(faithful.contains("2x"), "{faithful}");
        assert!(
            faithful.contains("Preserve the exact composition"),
            "{faithful}"
        );
        let detail = transform_prompt("detail", 4, "  watercolor style  ");
        assert!(detail.contains("4x"), "{detail}");
        assert!(detail.contains("Enhance fine details"), "{detail}");
        assert!(detail.ends_with("watercolor style"), "{detail}");
        assert_ne!(faithful, transform_prompt("detail", 2, ""));
        // 风格转换：scale=1 带风格词时是换风格指令，不出现 "1x"
        let style = transform_prompt("detail", 1, "  ukiyo-e woodblock  ");
        assert!(style.contains("Restyle this image"), "{style}");
        assert!(!style.contains("1x"), "{style}");
        assert!(style.ends_with("ukiyo-e woodblock"), "{style}");
    }

    /// 放大尺寸按原图 × 倍数吸附到服务商档位；坏图不带 size；风格转换不带 size
    #[test]
    fn scaled_size_snaps_from_decoded_image() {
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::new(400, 400))
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        assert_eq!(
            scaled_size(cursor.get_ref(), 2).as_deref(),
            Some("1024x1024")
        );
        assert!(scaled_size(b"not an image", 2).is_none());
        assert!(
            scaled_size(cursor.get_ref(), 1).is_none(),
            "风格转换保持原尺寸，不带 size 字段"
        );
    }

    /// F-012：空结果必须报错，非空结果原样透传
    #[test]
    fn empty_generation_result_reports_error() {
        let err = OpenAiAdapter::ensure_generated(vec![]).unwrap_err();
        assert!(err.message().contains("未返回图片"), "{}", err.message());
        assert_eq!(
            OpenAiAdapter::ensure_generated(vec!["QUJD".into()]).unwrap(),
            vec!["QUJD".to_string()]
        );
    }
}
