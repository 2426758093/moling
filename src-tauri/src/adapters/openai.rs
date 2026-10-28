use super::{
    classify_http, classify_reqwest, http_client, AdapterError, EditRequest, GenerateRequest,
    ImageAdapter, ProviderConfig,
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
    size: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<String>,
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

    /// 下载图片 URL（RA-05：必须带服务商超时，避免下载阶段无限挂起）
    async fn fetch_image_b64(
        entry: &ImageEntry,
        timeout: std::time::Duration,
    ) -> Result<String, AdapterError> {
        if let Some(b64) = &entry.b64_json {
            return Ok(b64.clone());
        }
        if let Some(url) = &entry.url {
            let resp = http_client()
                .get(url)
                .timeout(timeout)
                .send()
                .await
                .map_err(|e| classify_reqwest(&e))?;
            let bytes = resp.bytes().await.map_err(|e| classify_reqwest(&e))?;
            return Ok(base64::engine::general_purpose::STANDARD.encode(&bytes));
        }
        Err(AdapterError::Other {
            message: "API 返回的图片缺少 b64_json 与 url 字段".into(),
        })
    }
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
                prompt: req.prompt.clone(),
                // count 映射为 OpenAI n 参数；多图返回在下方按 data 数组逐项解析
                n: req.count.max(1),
                size: snap_size(req.width, req.height),
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
                    form = form.part(
                        "image[]",
                        reqwest::multipart::Part::bytes(bytes)
                            // 文件名必须带扩展名，否则服务商可能按二进制拒绝
                            .file_name(format!("image-{}.png", i))
                            .mime_str("image/png")
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
            let parsed: ImageResponse = resp.json().await.map_err(|e| AdapterError::Other {
                message: format!("响应解析失败: {}", e),
            })?;
            let mut out = Vec::new();
            for entry in &parsed.data {
                out.push(Self::fetch_image_b64(entry, Self::timeout(config)).await?);
            }
            Ok(out)
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
            let mut form = reqwest::multipart::Form::new()
                .text("model", req.model.clone())
                .text("prompt", req.prompt.clone())
                // RA-02：编辑分支同样吸附到服务商支持的尺寸档位，与 generate 保持一致
                .text("size", snap_size(req.width, req.height))
                .part(
                    "image",
                    reqwest::multipart::Part::bytes(image_bytes)
                        .file_name("image.png")
                        .mime_str("image/png")
                        .map_err(|e| AdapterError::Other {
                            message: e.to_string(),
                        })?,
                );
            if let Some(mask_b64) = &req.mask_b64 {
                let mask_bytes = base64::engine::general_purpose::STANDARD
                    .decode(mask_b64)
                    .map_err(|e| AdapterError::Other {
                        message: format!("蒙版 base64 解码失败: {}", e),
                    })?;
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
            let parsed: ImageResponse = resp.json().await.map_err(|e| AdapterError::Other {
                message: format!("响应解析失败: {}", e),
            })?;
            let entry = parsed.data.first().ok_or_else(|| AdapterError::Other {
                message: "API 未返回图片".into(),
            })?;
            Self::fetch_image_b64(entry, Self::timeout(config)).await
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
}
