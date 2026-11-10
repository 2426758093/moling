use super::{
    classify_http, classify_http_with_retry_after, classify_reqwest, download_image_bytes,
    http_client, prompt_with_negative, retry_after_secs, AdapterError, EditRequest,
    GenerateRequest, ImageAdapter, ProviderConfig, TransformRequest,
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
    /// GIF 输出容器；省略即静态图
    #[serde(skip_serializing_if = "Option::is_none")]
    output_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    frame_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    frame_duration_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    complexity: Option<String>,
}

/// 自动尺寸的约定：宽高同时为 0 表示交给服务商（OpenAI 的 size=auto 等价于省略）。
pub(crate) fn is_auto_size(width: u32, height: u32) -> bool {
    width == 0 && height == 0
}

/// 质量档位映射：DALL·E 3 只认 standard / hd，其余 gpt-image 兼容档位原样发送。
/// auto 与不支持 quality 的 DALL·E 2 一律不发字段，避免严格网关 400。
/// `xhigh` / `max` 只有 gpt-image 系列认，别的模型带上会被 400，因此不外发。
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
    if matches!(quality, "xhigh" | "max") && !model.contains("gpt-image") {
        return None;
    }
    Some(quality.to_string())
}

/// `response_format` 只属于 DALL·E 系列；gpt-image 系列会以
/// `400 Unknown parameter: 'response_format'` 拒绝（Cherry Studio 踩过同款坑）。
pub(crate) fn supports_response_format(model: &str) -> bool {
    model.to_ascii_lowercase().contains("dall-e")
}

/// 尺寸能力：DALL·E / gpt-image-1 系列只认固定档位，必须吸附；
/// gpt-image-2 与未知模型保留用户请求，避免把 1792x1024 静默改成 1536x1024。
pub(crate) fn size_for_model(model: &str, width: u32, height: u32) -> Option<String> {
    if is_auto_size(width, height) {
        return None;
    }
    let model = model.to_ascii_lowercase();
    if model.contains("dall-e") || model.contains("gpt-image-1") {
        return Some(snap_size(width, height));
    }
    if width.is_multiple_of(8) && height.is_multiple_of(8) {
        return Some(format!("{width}x{height}"));
    }
    Some(snap_size(width, height))
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

/// `/images/edits` 的表单文本字段：嵌套值无法作为表单发送直接跳过。
/// `response_format` 必须剔除——该字段只对 DALL·E 2 有意义，gpt-image 系列一律返回
/// b64_json；严格网关会因这个多余字段直接 400（上游错误常被中转包装成
/// `bad_response_status_code`，从响应体看不出真实原因）。
pub(crate) fn edit_form_fields(body: &serde_json::Value) -> Vec<(String, String)> {
    let Some(obj) = body.as_object() else {
        return Vec::new();
    };
    obj.iter()
        .filter(|(key, _)| key.as_str() != "response_format")
        .filter_map(|(key, value)| {
            let text = match value {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Number(n) => n.to_string(),
                serde_json::Value::Bool(b) => b.to_string(),
                _ => return None,
            };
            Some((key.clone(), text))
        })
        .collect()
}

/// 编辑端点单张图片的体积/像素上限：超过时服务商通常直接 400，本地先给出可读错误
const MAX_EDIT_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const MAX_EDIT_PIXELS: u64 = 40_000_000;

/// 解码并校验待上送图片，防止超大图/解压炸弹进入网络请求
fn decode_edit_image(bytes: &[u8], label: &str) -> Result<image::DynamicImage, AdapterError> {
    if bytes.len() > MAX_EDIT_IMAGE_BYTES {
        return Err(AdapterError::Other {
            message: format!("{label}超过 {}MB 上限", MAX_EDIT_IMAGE_BYTES / 1024 / 1024),
        });
    }
    let img = crate::exif::decode_oriented(bytes).map_err(|e| AdapterError::Other {
        message: format!("{label}解码失败: {e}"),
    })?;
    if img.width() as u64 * img.height() as u64 > MAX_EDIT_PIXELS {
        return Err(AdapterError::Other {
            message: format!("{label}像素过大，请压缩后再试"),
        });
    }
    Ok(img)
}

/// 重编码时沿用源格式：手机相册里的摆正图几乎都是 JPEG，若一律转 PNG，
/// 12MP 照片会膨胀到 25~40MB，正好撞上下面的体积上限而被本地拒收。
fn is_jpeg(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xFF, 0xD8])
}

/// 解码校验后按需摆正像素：EXIF 方向 6/8 的原图字节仍带着方向标签、像素是躺倒的，
/// 而画布蒙版与上送尺寸都已按摆正后的方向计算。直接上传原始字节会让服务商侧
/// 图像与蒙版错位（常见结果为不可诊断的 400），因此这类图统一转成摆正后的像素；
/// 输出格式跟随源图（JPEG 源仍编 JPEG，无 Alpha 可丢；其余转 PNG）以控制体积。
/// 不带方向标签时保持原始字节不变（既不重编码也不损失画质/元数据）。
fn normalize_edit_image(bytes: Vec<u8>) -> Result<Vec<u8>, AdapterError> {
    let img = decode_edit_image(&bytes, "参考图")?;
    if crate::exif::orientation_of(&bytes) == image::metadata::Orientation::NoTransforms {
        return Ok(bytes);
    }
    use image::ImageEncoder;

    let mut out = std::io::Cursor::new(Vec::new());
    if is_jpeg(&bytes) {
        let rgb = img.to_rgb8();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 92)
            .write_image(
                rgb.as_raw(),
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|e| AdapterError::Other {
                message: format!("参考图摆正后转 JPEG 失败: {e}"),
            })?;
    } else {
        img.write_to(&mut out, image::ImageFormat::Png)
            .map_err(|e| AdapterError::Other {
                message: format!("参考图摆正后转 PNG 失败: {e}"),
            })?;
    }
    let out = out.into_inner();
    // 重编码后的体积未必更小（PNG 无损、JPEG 换编码器参数），超限同样在本地拦下
    if out.len() > MAX_EDIT_IMAGE_BYTES {
        return Err(AdapterError::Other {
            message: format!(
                "参考图摆正后超过 {}MB 上限",
                MAX_EDIT_IMAGE_BYTES / 1024 / 1024
            ),
        });
    }
    Ok(out)
}

/// 蒙版必须是与原图同尺寸、带 Alpha 的 PNG：不满足时不发请求，避免不可诊断的 400
fn normalize_mask(mask: Vec<u8>, image: &[u8]) -> Result<Vec<u8>, AdapterError> {
    let base = decode_edit_image(image, "参考图")?;
    let mask_img = decode_edit_image(&mask, "蒙版")?;
    if (base.width(), base.height()) != (mask_img.width(), mask_img.height()) {
        return Err(AdapterError::Other {
            message: format!(
                "蒙版尺寸 {}x{} 与参考图 {}x{} 不一致",
                mask_img.width(),
                mask_img.height(),
                base.width(),
                base.height()
            ),
        });
    }
    if !mask_img.color().has_alpha() {
        return Err(AdapterError::Other {
            message: "蒙版必须包含 Alpha 通道（透明区域表示要修改的范围）".into(),
        });
    }
    let mut out = std::io::Cursor::new(Vec::new());
    mask_img
        .write_to(&mut out, image::ImageFormat::Png)
        .map_err(|e| AdapterError::Other {
            message: format!("蒙版转 PNG 失败: {e}"),
        })?;
    Ok(out.into_inner())
}

/// 构造 `/images/edits` 的 multipart 表单；字段名在部分服务商那里可能是单数 `image`
fn build_edit_form(
    body: &serde_json::Value,
    images: &[(Vec<u8>, &'static str, &'static str)],
    field: &str,
) -> Result<reqwest::multipart::Form, AdapterError> {
    let mut form = reqwest::multipart::Form::new();
    for (key, text) in edit_form_fields(body) {
        form = form.text(key, text);
    }
    for (i, (bytes, ext, mime)) in images.iter().enumerate() {
        form = form.part(
            field.to_string(),
            reqwest::multipart::Part::bytes(bytes.clone())
                .file_name(format!("ref.{i}.{ext}"))
                .mime_str(mime)
                .map_err(|e| AdapterError::Other {
                    message: e.to_string(),
                })?,
        );
    }
    Ok(form)
}

/// 中转常见的 400 文案差异：`image` 单数 / `image[]` 数组，只回退一次（400 不计费）
fn suggests_singular_image_field(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    lower.contains("image")
        && !lower.contains("image[]")
        && (lower.contains("required")
            || lower.contains("missing")
            || lower.contains("unknown")
            || lower.contains("expected"))
}

/// 400 参数错误的可执行上下文：只列字段名与端点，不记录任何值/密钥
fn enrich_400(
    err: AdapterError,
    endpoint: &str,
    model: &str,
    fields: impl IntoIterator<Item = String>,
) -> AdapterError {
    let fields: Vec<String> = fields.into_iter().collect();
    let context = format!(
        "（端点 {endpoint}，模型 {model}，字段 [{}]；常见原因：不支持的 response_format / 尺寸档位 / 蒙版格式）",
        fields.join(", ")
    );
    match err {
        AdapterError::Other { message } => AdapterError::Other {
            message: format!("{message}{context}"),
        },
        other => other,
    }
}

/// edits 请求失败的统一诊断：字段清单来自实际表单（不含值），
/// 让「中转把上游 400 包装成 bad_response_status_code」也能定位到真实字段
fn edit_error(
    status: reqwest::StatusCode,
    text: &str,
    model: &str,
    body: &serde_json::Value,
    extra_fields: &[&str],
    retry_after: Option<u64>,
) -> AdapterError {
    let mut fields: Vec<String> = edit_form_fields(body)
        .into_iter()
        .map(|(key, _)| key)
        .collect();
    fields.extend(extra_fields.iter().map(|field| field.to_string()));
    enrich_400(
        classify_http_with_retry_after(status, text, retry_after),
        "/images/edits",
        model,
        fields,
    )
}

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

#[derive(serde::Deserialize, Debug)]
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

    /// 非生成端点的等待上限：默认超时已按图片生成放大到 600s，
    /// 但拉取模型列表不应把设置页卡住十分钟。取用户配置与旧默认 60s 的较小值。
    fn aux_timeout(config: &ProviderConfig) -> std::time::Duration {
        Self::timeout(config).min(std::time::Duration::from_secs(60))
    }

    /// 发送 /images/edits 表单；字段名可切换（image[] / image）。
    /// `X-Client-Request-Id` 只对 OpenAI 兼容通道发送：用于服务商后台对账，
    /// 严格网关若不接受可在这里统一关闭。
    async fn send_edits(
        config: &ProviderConfig,
        body: &serde_json::Value,
        images: &[(Vec<u8>, &'static str, &'static str)],
        field: &str,
        ctx: Option<&crate::billing_journal::AttemptCtx>,
    ) -> Result<reqwest::Response, AdapterError> {
        let form = build_edit_form(body, images, field)?;
        let mut request = http_client()?
            .post(format!("{}/images/edits", Self::base(config)))
            .bearer_auth(&config.api_key)
            .multipart(form);
        if let Some(ctx) = ctx {
            request = request.header("X-Client-Request-Id", ctx.client_request_id());
            ctx.mark_sent();
        }
        super::send_with_timeout(request, Self::timeout(config), "/images/edits").await
    }

    /// 构造并发送 /images/edits 请求（编辑与变换共用同一端点）。
    #[allow(clippy::too_many_arguments)]
    async fn post_edit(
        config: &ProviderConfig,
        model: &str,
        prompt: &str,
        image_bytes: Vec<u8>,
        mask_bytes: Option<Vec<u8>>,
        size: Option<String>,
        gif: Option<&super::GifParams>,
        ctx: Option<&crate::billing_journal::AttemptCtx>,
    ) -> Result<ImageResponse, AdapterError> {
        // 官方 GIF 编辑不带蒙版；带蒙版时明确拒绝，绝不静默压成静图
        if gif.is_some() && mask_bytes.is_some() {
            return Err(AdapterError::Unsupported {
                message: "服务商不支持带蒙版的 GIF 编辑，请先转静图或改用单帧修复".into(),
            });
        }
        let mut body = serde_json::json!({ "model": model, "prompt": prompt });
        // RA-02：编辑分支同样吸附到服务商支持的尺寸档位，与 generate 保持一致
        if let Some(size) = size {
            body["size"] = serde_json::Value::String(size);
        }
        if let Some(gif) = gif {
            body["output_format"] = serde_json::Value::String(gif.output_format.clone());
            body["frame_count"] = serde_json::Value::from(gif.frame_count);
            body["frame_duration_ms"] = serde_json::Value::from(gif.frame_duration_ms);
            if let Some(complexity) = &gif.complexity {
                body["complexity"] = serde_json::Value::String(complexity.clone());
            }
        }
        // A2：上送前本地校验体积/像素；蒙版必须是同尺寸且带 Alpha 的 PNG
        let has_mask = mask_bytes.is_some();
        let image_bytes = normalize_edit_image(image_bytes)?;
        let mask_bytes = match mask_bytes {
            Some(mask) => Some(normalize_mask(mask, &image_bytes)?),
            None => None,
        };
        // 文件名与 MIME 按真实格式上报：JPEG 谎报 PNG 会被严格网关拒绝
        let (ext, mime) = crate::image_store::sniff_image_mime(&image_bytes);
        let mut form = build_edit_form(&body, &[(image_bytes, ext, mime)], "image")?;
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
        let mut request = http_client()?
            .post(format!("{}/images/edits", Self::base(config)))
            .bearer_auth(&config.api_key)
            .multipart(form);
        if let Some(ctx) = ctx {
            request = request.header("X-Client-Request-Id", ctx.client_request_id());
            ctx.mark_sent();
        }
        let resp =
            super::send_with_timeout(request, Self::timeout(config), "/images/edits").await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let retry_after = retry_after_secs(&resp);
            let text = super::read_error_text(resp).await;
            let extra: &[&str] = if has_mask {
                &["image", "mask"]
            } else {
                &["image"]
            };
            return Err(edit_error(status, &text, model, &body, extra, retry_after));
        }
        super::parse_json_body_with_ctx(resp, "/images/edits", ctx).await
    }

    async fn first_image_b64(
        parsed: ImageResponse,
        timeout: std::time::Duration,
        max_bytes: usize,
    ) -> Result<String, AdapterError> {
        let entry = first_image(&parsed)?;
        Self::fetch_image_b64(entry, timeout, max_bytes).await
    }

    /// 取回单张图片：b64 直接返回，URL 走「只重试下载」的下载器。
    /// 下载失败时 URL 由调用方记入请求流水的产物清单，恢复入口可再取。
    async fn fetch_image_b64(
        entry: &ImageEntry,
        timeout: std::time::Duration,
        max_bytes: usize,
    ) -> Result<String, AdapterError> {
        if let Some(b64) = &entry.b64_json {
            // base64 膨胀 4/3；不真正 decode 就能拦下明显超限的响应
            let approx = b64.len() / 4 * 3;
            if approx > max_bytes {
                return Err(AdapterError::Other {
                    message: format!("图片体积超过上限 {} MB", max_bytes / 1024 / 1024),
                });
            }
            return Ok(b64.clone());
        }
        if let Some(url) = &entry.url {
            // F-011：统一走带状态码 / 体积上限 / 魔数校验的下载函数
            let bytes = download_with_retry(url, timeout, max_bytes).await?;
            return Ok(base64::engine::general_purpose::STANDARD.encode(&bytes));
        }
        Err(AdapterError::Other {
            message: "API 返回的图片缺少 b64_json 与 url 字段".into(),
        })
    }
}

/// 取第一张图；200 但 `data` 为空同样算「已计费无产物」，由上层按计费分类处理。
fn first_image(parsed: &ImageResponse) -> Result<&ImageEntry, AdapterError> {
    parsed.data.first().ok_or_else(|| AdapterError::Other {
        message: "API 未返回图片".into(),
    })
}

/// 只有瞬时故障才值得重试下载：建连失败、超时、5xx。
pub(crate) fn retryable_download_error(e: &AdapterError) -> bool {
    matches!(
        e,
        AdapterError::Network { .. } | AdapterError::Timeout { .. } | AdapterError::Upstream { .. }
    )
}

/// 只重试「下载」：生成已经计费，重新发请求等于再付一次钱。
/// 仅对瞬时故障（建连/超时/5xx）重试 ≤3 次，其余错误立即返回。
pub(crate) async fn download_with_retry(
    url: &str,
    timeout: std::time::Duration,
    max_bytes: usize,
) -> Result<Vec<u8>, AdapterError> {
    let mut last: Option<AdapterError> = None;
    for attempt in 0..3u64 {
        match download_image_bytes(url, timeout, max_bytes).await {
            Ok(bytes) => return Ok(bytes),
            Err(e) if retryable_download_error(&e) => {
                tracing::warn!(
                    "图片下载第 {} 次失败（不重新生成，仅重试下载）: {}",
                    attempt + 1,
                    e.message()
                );
                last = Some(e);
                if attempt < 2 {
                    tokio::time::sleep(std::time::Duration::from_millis(1000 * (attempt + 1)))
                        .await;
                }
            }
            Err(e) => return Err(e),
        }
    }
    Err(last.unwrap_or(AdapterError::Other {
        message: "图片下载失败".into(),
    }))
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
    let img = crate::image_store::decode_limited(bytes).ok()?;
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
            let resp = http_client()?
                .get(format!("{}/models", Self::base(config)))
                .timeout(Self::aux_timeout(config))
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
        Box::pin(async move { Self::generate_impl(config, req, None).await })
    }

    fn generate_journaled<'a>(
        &'a self,
        config: &'a ProviderConfig,
        req: &'a GenerateRequest,
        ctx: Option<&'a crate::billing_journal::AttemptCtx>,
    ) -> super::BoxFuture<'a, Result<Vec<String>, AdapterError>> {
        Box::pin(async move { Self::generate_impl(config, req, ctx).await })
    }

    fn edit<'a>(
        &'a self,
        config: &'a ProviderConfig,
        req: &'a EditRequest,
    ) -> super::BoxFuture<'a, Result<String, AdapterError>> {
        Box::pin(async move { Self::edit_impl(config, req, None).await })
    }

    fn edit_journaled<'a>(
        &'a self,
        config: &'a ProviderConfig,
        req: &'a EditRequest,
        ctx: Option<&'a crate::billing_journal::AttemptCtx>,
    ) -> super::BoxFuture<'a, Result<String, AdapterError>> {
        Box::pin(async move { Self::edit_impl(config, req, ctx).await })
    }

    fn transform<'a>(
        &'a self,
        config: &'a ProviderConfig,
        req: &'a TransformRequest,
    ) -> super::BoxFuture<'a, Result<String, AdapterError>> {
        Box::pin(async move { Self::transform_impl(config, req, None).await })
    }

    fn transform_journaled<'a>(
        &'a self,
        config: &'a ProviderConfig,
        req: &'a TransformRequest,
        ctx: Option<&'a crate::billing_journal::AttemptCtx>,
    ) -> super::BoxFuture<'a, Result<String, AdapterError>> {
        Box::pin(async move { Self::transform_impl(config, req, ctx).await })
    }
}

impl OpenAiAdapter {
    async fn generate_impl(
        config: &ProviderConfig,
        req: &GenerateRequest,
        ctx: Option<&crate::billing_journal::AttemptCtx>,
    ) -> Result<Vec<String>, AdapterError> {
        let gif = super::GifParams::from_request(
            req.output_format.as_deref(),
            req.frame_count,
            req.frame_duration_ms,
            req.complexity.as_deref(),
        );
        let mut body = serde_json::to_value(GenerationBody {
            model: req.model.clone(),
            prompt: prompt_with_negative(&req.prompt, req.negative_prompt.as_deref()),
            // count 映射为 OpenAI n 参数；多图返回在下方按 data 数组逐项解析
            n: req.count.max(1),
            size: size_for_model(&req.model, req.width, req.height),
            quality: map_quality(&req.model, req.quality.as_deref()),
            response_format: supports_response_format(&req.model).then(|| "b64_json".to_string()),
            output_format: gif.as_ref().map(|g| g.output_format.clone()),
            frame_count: gif.as_ref().map(|g| g.frame_count),
            frame_duration_ms: gif.as_ref().map(|g| g.frame_duration_ms),
            complexity: gif.as_ref().and_then(|g| g.complexity.clone()),
        })
        .map_err(|e| AdapterError::Other {
            message: e.to_string(),
        })?;
        merge_extra_params(&mut body, config);
        // 透传参数也可能塞回 response_format；能力过滤必须放在合并之后
        if !supports_response_format(&req.model) {
            if let Some(obj) = body.as_object_mut() {
                obj.remove("response_format");
            }
        }
        let (resp, endpoint, edit_field) = if req.images.is_empty() {
            // 纯文生图：JSON 请求 /images/generations
            let mut request = http_client()?
                .post(format!("{}/images/generations", Self::base(config)))
                .bearer_auth(&config.api_key)
                .json(&body);
            if let Some(ctx) = ctx {
                request = request.header("X-Client-Request-Id", ctx.client_request_id());
                ctx.mark_sent();
            }
            let resp =
                super::send_with_timeout(request, Self::timeout(config), "/images/generations")
                    .await?;
            (resp, "/images/generations", None)
        } else {
            // 参考图（图生图/编辑）：gpt-image 规范走 multipart /images/edits；
            // RA-01：数字型 n 等标量统一转文本；response_format 由 edit_form_fields 剔除。
            let mut prepared = Vec::with_capacity(req.images.len());
            for img_b64 in &req.images {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(img_b64)
                    .map_err(|e| AdapterError::Other {
                        message: format!("参考图 base64 解码失败: {}", e),
                    })?;
                // A8：解码校验 + 体积/像素上限；A2：MIME 按真实格式上报
                let bytes = normalize_edit_image(bytes)?;
                let (ext, mime) = crate::image_store::sniff_image_mime(&bytes);
                prepared.push((bytes, ext, mime));
            }
            let mut field = "image[]";
            let mut resp = Self::send_edits(config, &body, &prepared, field, ctx).await?;
            // A7：部分中转只认单数 image 字段；400 不计费，允许回退一次
            if resp.status() == reqwest::StatusCode::BAD_REQUEST && prepared.len() == 1 {
                let status = resp.status();
                let text = super::read_error_text(resp).await;
                if suggests_singular_image_field(&text) {
                    tracing::warn!("服务商要求单数 image 字段，回退重试一次");
                    field = "image";
                    resp = Self::send_edits(config, &body, &prepared, field, ctx).await?;
                } else {
                    return Err(edit_error(status, &text, &req.model, &body, &[field], None));
                }
            }
            (resp, "/images/edits", Some(field))
        };
        if !resp.status().is_success() {
            let status = resp.status();
            let retry_after = retry_after_secs(&resp);
            let text = super::read_error_text(resp).await;
            return Err(match edit_field {
                Some(field) => edit_error(status, &text, &req.model, &body, &[field], retry_after),
                None => {
                    // 只记录字段名，不记录值（可能含密钥/超长提示词）
                    let fields = body
                        .as_object()
                        .map(|obj| obj.keys().cloned().collect::<Vec<_>>())
                        .unwrap_or_default();
                    enrich_400(
                        classify_http_with_retry_after(status, &text, retry_after),
                        endpoint,
                        &req.model,
                        fields,
                    )
                }
            });
        }
        let status = resp.status().as_u16();
        // 先落「已受理」，再读 body：读超时/坏 JSON 同样已计费
        let parsed: ImageResponse = super::parse_json_body_with_ctx(resp, endpoint, ctx).await?;
        if let Some(ctx) = ctx {
            ctx.mark_billed(status, Some(parsed.data.len() as u32));
        }
        // 逐张取图：单张失败只丢该张（与 Cherry Studio 一致），全部失败才报错
        let max_bytes = if gif.is_some() {
            super::MAX_REMOTE_GIF_BYTES
        } else {
            super::MAX_REMOTE_IMAGE_BYTES
        };
        let mut out = Vec::new();
        let mut last_err: Option<AdapterError> = None;
        for entry in &parsed.data {
            match Self::fetch_image_b64(entry, Self::timeout(config), max_bytes).await {
                Ok(b64) => out.push(b64),
                Err(e) => {
                    tracing::warn!("第 {} 张图片取回失败: {}", out.len() + 1, e.message());
                    if let (Some(ctx), Some(url)) = (ctx, entry.url.as_deref()) {
                        // 保留 URL 供「只重试下载」的恢复流程使用
                        ctx.note_artifact(url);
                    }
                    last_err = Some(e);
                }
            }
        }
        if out.is_empty() {
            return Err(last_err.unwrap_or(AdapterError::Other {
                message: "API 未返回图片".into(),
            }));
        }
        if last_err.is_some() {
            tracing::warn!(
                "本次返回 {} 张，仅成功取回 {} 张",
                parsed.data.len(),
                out.len()
            );
        }
        Ok(out)
    }

    async fn edit_impl(
        config: &ProviderConfig,
        req: &EditRequest,
        ctx: Option<&crate::billing_journal::AttemptCtx>,
    ) -> Result<String, AdapterError> {
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
        let gif = super::GifParams::from_request(
            req.output_format.as_deref(),
            req.frame_count,
            req.frame_duration_ms,
            req.complexity.as_deref(),
        );
        let parsed = Self::post_edit(
            config,
            &req.model,
            &prompt_with_negative(&req.prompt, req.negative_prompt.as_deref()),
            image_bytes,
            mask_bytes,
            size_for_model(&req.model, req.width, req.height),
            gif.as_ref(),
            ctx,
        )
        .await?;
        let max_bytes = if gif.is_some() {
            super::MAX_REMOTE_GIF_BYTES
        } else {
            super::MAX_REMOTE_IMAGE_BYTES
        };
        Self::first_image_b64(parsed, Self::timeout(config), max_bytes).await
    }

    async fn transform_impl(
        config: &ProviderConfig,
        req: &TransformRequest,
        ctx: Option<&crate::billing_journal::AttemptCtx>,
    ) -> Result<String, AdapterError> {
        let image_bytes = base64::engine::general_purpose::STANDARD
            .decode(&req.image_b64)
            .map_err(|e| AdapterError::Other {
                message: format!("图片 base64 解码失败: {}", e),
            })?;
        let size = scaled_size(&image_bytes, req.scale);
        let prompt = transform_prompt(&req.mode, req.scale, &req.prompt);
        let parsed = Self::post_edit(
            config,
            &req.model,
            &prompt,
            image_bytes,
            None,
            size,
            None,
            ctx,
        )
        .await?;
        Self::first_image_b64(parsed, Self::timeout(config), super::MAX_REMOTE_IMAGE_BYTES).await
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

    /// A1：能力矩阵——只有 DALL·E 系列发 response_format，gpt-image 一律不发
    #[test]
    fn generation_body_omits_response_format_for_gpt_image() {
        let body = |model: &str| {
            serde_json::to_value(GenerationBody {
                model: model.into(),
                prompt: "x".into(),
                n: 1,
                size: size_for_model(model, 1024, 1024),
                quality: map_quality(model, None),
                response_format: supports_response_format(model).then(|| "b64_json".to_string()),
                output_format: None,
                frame_count: None,
                frame_duration_ms: None,
                complexity: None,
            })
            .unwrap()
        };
        assert!(body("gpt-image-1").get("response_format").is_none());
        assert!(body("openai/gpt-image-2.5")
            .get("response_format")
            .is_none());
        assert_eq!(body("dall-e-3")["response_format"], "b64_json");
    }

    /// GIF 字段只在动图请求里出现；静态请求的形状必须与旧版完全一致
    #[test]
    fn generation_body_serializes_gif_fields_only_when_present() {
        let body = |gif: Option<(&str, u32, u32, &str)>| {
            serde_json::to_value(GenerationBody {
                model: "gpt-image-2.6-flare".into(),
                prompt: "x".into(),
                n: 1,
                size: None,
                quality: None,
                response_format: None,
                output_format: gif.map(|g| g.0.to_string()),
                frame_count: gif.map(|g| g.1),
                frame_duration_ms: gif.map(|g| g.2),
                complexity: gif.map(|g| g.3.to_string()),
            })
            .unwrap()
        };
        let static_body = body(None);
        assert!(static_body.get("output_format").is_none());
        assert!(static_body.get("frame_count").is_none());
        let gif_body = body(Some(("gif", 6, 120, "high")));
        assert_eq!(gif_body["output_format"], "gif");
        assert_eq!(gif_body["frame_count"], 6);
        assert_eq!(gif_body["frame_duration_ms"], 120);
        assert_eq!(gif_body["complexity"], "high");
    }

    /// 编辑表单必须把 GIF 参数作为文本字段上送（数字也转字符串）
    #[test]
    fn edit_form_fields_carry_gif_params() {
        let body = serde_json::json!({
            "model": "gpt-image-2.6-sunburst",
            "prompt": "x",
            "output_format": "gif",
            "frame_count": 4,
            "frame_duration_ms": 90,
            "response_format": "b64_json",
        });
        let fields: std::collections::HashMap<_, _> = edit_form_fields(&body).into_iter().collect();
        assert_eq!(fields.get("output_format").map(String::as_str), Some("gif"));
        assert_eq!(fields.get("frame_count").map(String::as_str), Some("4"));
        assert_eq!(
            fields.get("frame_duration_ms").map(String::as_str),
            Some("90")
        );
        assert!(!fields.contains_key("response_format"));
    }

    /// xhigh/max 只对 gpt-image 系列放行，DALL·E 仍映射到 standard/hd
    #[test]
    fn map_quality_gates_new_tiers_by_model() {
        assert_eq!(
            map_quality("gpt-image-2.6-flare", Some("xhigh")).as_deref(),
            Some("xhigh")
        );
        assert_eq!(
            map_quality("gpt-image-2.6-flare", Some("max")).as_deref(),
            Some("max")
        );
        assert_eq!(
            map_quality("dall-e-3", Some("xhigh")).as_deref(),
            Some("standard")
        );
        assert_eq!(
            map_quality("dall-e-3", Some("max")).as_deref(),
            Some("standard")
        );
        assert_eq!(map_quality("flux-pro", Some("max")), None);
    }

    /// A1：新模型保留用户尺寸，不吸附到 DALL·E 三档
    #[test]
    fn size_for_model_keeps_requested_dimensions_for_new_models() {
        assert_eq!(
            size_for_model("gpt-image-2", 1792, 1024).as_deref(),
            Some("1792x1024")
        );
        assert_eq!(
            size_for_model("weird-model", 768, 512).as_deref(),
            Some("768x512")
        );
        assert_eq!(
            size_for_model("gpt-image-1", 1792, 1024).as_deref(),
            Some("1536x1024")
        );
        assert_eq!(
            size_for_model("dall-e-3", 680, 1024).as_deref(),
            Some("1024x1536")
        );
        assert_eq!(size_for_model("gpt-image-2", 0, 0), None);
    }

    fn png_of(width: u32, height: u32, alpha: bool) -> Vec<u8> {
        let mut cursor = std::io::Cursor::new(Vec::new());
        if alpha {
            image::DynamicImage::ImageRgba8(image::RgbaImage::new(width, height))
                .write_to(&mut cursor, image::ImageFormat::Png)
                .unwrap();
        } else {
            image::DynamicImage::ImageRgb8(image::RgbImage::new(width, height))
                .write_to(&mut cursor, image::ImageFormat::Png)
                .unwrap();
        }
        cursor.into_inner()
    }

    /// A2：蒙版必须与参考图同尺寸且带 Alpha，否则本地直接报错不发请求
    #[test]
    fn mask_normalization_requires_same_size_and_alpha() {
        let image = png_of(64, 64, true);
        assert!(normalize_mask(png_of(64, 64, true), &image).is_ok());
        let mismatch = normalize_mask(png_of(32, 32, true), &image).unwrap_err();
        assert!(
            mismatch.message().contains("尺寸"),
            "{}",
            mismatch.message()
        );
        let no_alpha = normalize_mask(png_of(64, 64, false), &image).unwrap_err();
        assert!(
            no_alpha.message().contains("Alpha"),
            "{}",
            no_alpha.message()
        );
    }

    /// A2/A8：超过体积上限的图片在本地拒绝，不进入网络请求
    #[test]
    fn edit_image_limit_rejects_oversized_payload() {
        let err = normalize_edit_image(vec![0u8; MAX_EDIT_IMAGE_BYTES + 1]).unwrap_err();
        assert!(err.message().contains("上限"), "{}", err.message());
        let err = normalize_edit_image(b"not an image".to_vec()).unwrap_err();
        assert!(err.message().contains("解码失败"), "{}", err.message());
    }

    /// EXIF 方向 6：上送前换成摆正后的像素，与摆正蒙版同向同尺寸；
    /// 源为 JPEG 时仍编 JPEG（否则照片体积会撞上上送上限）；
    /// 无方向标签的图片保持原始字节不变
    #[test]
    fn oriented_edit_image_is_reencoded_upright() {
        let jpeg = crate::exif::test_fixtures::jpeg_with_orientation(8, 4, 6);
        assert_eq!(
            crate::exif::orientation_of(&jpeg),
            image::metadata::Orientation::Rotate90
        );
        let normalized = normalize_edit_image(jpeg).expect("带方向的参考图应通过校验");
        assert!(
            normalized.starts_with(&[0xFF, 0xD8]),
            "JPEG 源应重编码为 JPEG，而不是膨胀成 PNG"
        );
        assert!(
            !normalized.starts_with(&[0x89, b'P', b'N', b'G']),
            "JPEG 源不应被转成 PNG"
        );
        assert!(
            normalized.len() < 2_000_000,
            "摆正后体积应远低于 25MB 上限，实际 {} 字节",
            normalized.len()
        );
        assert_eq!(
            crate::exif::orientation_of(&normalized),
            image::metadata::Orientation::NoTransforms,
            "重编码后不应再带方向标签"
        );
        let upright = crate::exif::decode_oriented(&normalized).expect("摆正后的 JPEG 应可解码");
        assert_eq!((upright.width(), upright.height()), (4, 8));
        // 画布蒙版按摆正方向导出，与新像素尺寸一致
        assert!(normalize_mask(png_of(4, 8, true), &normalized).is_ok());

        let plain = png_of(6, 5, false);
        assert_eq!(
            normalize_edit_image(plain.clone()).unwrap(),
            plain,
            "无方向标签时不重编码"
        );
    }

    /// A7：只在错误明确指向单数 image 字段时回退，避免误触发重复请求
    #[test]
    fn singular_image_field_hint_detection() {
        assert!(suggests_singular_image_field(
            r#"{"error":{"message":"image is required"}}"#
        ));
        assert!(suggests_singular_image_field("missing field `image`"));
        assert!(!suggests_singular_image_field(
            "unknown parameter: image[] is deprecated"
        ));
        assert!(!suggests_singular_image_field("content policy violation"));
    }

    /// F-012：空结果必须报错，非空结果可取到首张
    #[test]
    fn empty_generation_result_reports_error() {
        let empty = ImageResponse { data: vec![] };
        let err = first_image(&empty).unwrap_err();
        assert!(err.message().contains("未返回图片"), "{}", err.message());
        let one = ImageResponse {
            data: vec![ImageEntry {
                b64_json: Some("QUJD".into()),
                url: None,
            }],
        };
        assert_eq!(first_image(&one).unwrap().b64_json.as_deref(), Some("QUJD"));
    }
}
