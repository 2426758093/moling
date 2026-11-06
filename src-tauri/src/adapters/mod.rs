pub mod chat;
pub mod http;
pub mod mock;
pub mod openai;
pub mod template;
#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

/// provider kind 常量（serde/DB 中的字符串值冻结：mock/template/openai）
pub const KIND_MOCK: &str = "mock";
pub const KIND_TEMPLATE: &str = "template";
pub const KIND_OPENAI: &str = "openai";

/// 错误响应体保留的最大字符数（避免超长错误消息撑爆 UI/日志）
pub const ERROR_BODY_TRUNCATE_LEN: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerateRequest {
    pub prompt: String,
    pub negative_prompt: Option<String>,
    pub model: String,
    pub width: u32,
    pub height: u32,
    pub guidance: Option<f32>,
    pub steps: Option<u32>,
    pub seed: Option<u64>,
    pub count: u32,
    /// 质量档位（low / medium / high）；None = auto，不发送该字段
    #[serde(default)]
    pub quality: Option<String>,
    /// 参考图（base64，无 data-url 前缀），随 multipart 上送
    pub images: Vec<String>,
    /// 与 `images` 按位置对应的角色 / 强度；只用于提示词级说明与模板变量
    #[serde(default)]
    pub references: Vec<crate::reference::ReferenceSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditRequest {
    pub prompt: String,
    pub negative_prompt: Option<String>,
    pub model: String,
    pub image_b64: String,
    pub mask_b64: Option<String>,
    pub width: u32,
    pub height: u32,
}

/// 高清放大 / 风格转换（M4 起由 `transform_image` 命令使用）。
/// 服务商没有原生超分端点时按指令化编辑实现，`mode` 决定保真还是加细节。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransformRequest {
    pub prompt: String,
    pub model: String,
    pub image_b64: String,
    /// 放大倍数：2 / 4
    pub scale: u32,
    /// detail（细节增强）| faithful（忠实还原）
    pub mode: String,
}

/// 负向提示词的统一落法：OpenAI 兼容接口没有标准负向字段，按 ADR #3 不新增字段，
/// 而是作为提示词尾句追加；模板服务商走原生 `{{negative_prompt}}`，不经过这里。
pub(crate) fn prompt_with_negative(prompt: &str, negative: Option<&str>) -> String {
    match negative.map(str::trim).filter(|n| !n.is_empty()) {
        Some(neg) => format!("{prompt}\n\nAvoid: {neg}"),
        None => prompt.to_string(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub id: Option<i64>,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub kind: String,
    pub models_json: String,
    pub default_model: String,
    pub timeout_secs: u64,
    // template kind extras
    pub template_url: String,
    pub template_body: String,
    pub template_response_path: String,
    /// 编辑 / 变换模板；None = 该服务商未配置对应端点
    pub edit_template: Option<template::TemplateSpec>,
    pub transform_template: Option<template::TemplateSpec>,
    // 透传参数（JSON 对象字符串，合并进请求体）
    pub extra_params: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AdapterError {
    AuthInvalid {
        message: String,
        /// HTTP 状态码：401 可判定 Key 失效并长期跳过；403 多为权限不足，只切换不标记
        #[serde(default)]
        status: u16,
    },
    QuotaExceeded {
        message: String,
    },
    Timeout {
        message: String,
    },
    ContentBlocked {
        message: String,
    },
    Network {
        message: String,
    },
    /// 服务商/接口不具备该能力（如模板服务商的放大端点）
    Unsupported {
        message: String,
    },
    Other {
        message: String,
    },
}

impl AdapterError {
    pub fn message(&self) -> &str {
        match self {
            AdapterError::AuthInvalid { message, .. }
            | AdapterError::QuotaExceeded { message }
            | AdapterError::Timeout { message }
            | AdapterError::ContentBlocked { message }
            | AdapterError::Network { message }
            | AdapterError::Unsupported { message }
            | AdapterError::Other { message } => message,
        }
    }
}

impl std::fmt::Display for AdapterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message())
    }
}

impl std::error::Error for AdapterError {}

/// 手工 Future 装箱（edition 2021 无原生 async trait；避免引入 async-trait 依赖）
pub type BoxFuture<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

pub trait ImageAdapter: Send + Sync {
    fn list_models<'a>(
        &'a self,
        config: &'a ProviderConfig,
    ) -> BoxFuture<'a, Result<Vec<String>, AdapterError>>;
    fn generate<'a>(
        &'a self,
        config: &'a ProviderConfig,
        req: &'a GenerateRequest,
    ) -> BoxFuture<'a, Result<Vec<String>, AdapterError>>;
    fn edit<'a>(
        &'a self,
        config: &'a ProviderConfig,
        req: &'a EditRequest,
    ) -> BoxFuture<'a, Result<String, AdapterError>>;
    /// 高清放大 / 风格转换；默认明确报「不支持」，避免被 UI 误当成网络错误
    fn transform<'a>(
        &'a self,
        _config: &'a ProviderConfig,
        _req: &'a TransformRequest,
    ) -> BoxFuture<'a, Result<String, AdapterError>> {
        Box::pin(async move {
            Err(AdapterError::Unsupported {
                message: "该服务商不支持高清放大与风格转换".into(),
            })
        })
    }
}

/// 按 kind 获取适配器；未知 kind 显式报错（不再静默回退 OpenAI）
pub fn get_adapter(kind: &str) -> Result<Box<dyn ImageAdapter>, AdapterError> {
    match kind {
        KIND_MOCK => Ok(Box::new(mock::MockAdapter)),
        KIND_TEMPLATE => Ok(Box::new(template::TemplateAdapter)),
        KIND_OPENAI => Ok(Box::new(openai::OpenAiAdapter)),
        _ => Err(AdapterError::Other {
            message: format!("未知适配器类型: {kind}"),
        }),
    }
}

/// 序列化为前端 parseAdapterError 约定的 JSON 字符串（失败时退化为纯文本消息）
pub fn adapter_error_json(e: AdapterError) -> String {
    serde_json::to_string(&e).unwrap_or_else(|_| e.message().to_string())
}

/// 全局共享 reqwest Client（连接池/TLS 会话复用，P5）；超时在各请求级单独设置。
/// 返回 `Arc` 让调用方在读锁外持有客户端，代理热切换不会中断在途请求。
pub(crate) fn http_client() -> Arc<reqwest::Client> {
    http::current_client()
}

/// 单张远程图片体积上限（20MB）：防止错误页 / 超大响应把内存与落盘打满。
pub(crate) const MAX_REMOTE_IMAGE_BYTES: usize = 20 * 1024 * 1024;

/// 支持的图片魔数（与 `image` crate 启用的格式一致：PNG / JPEG / GIF / WebP）
fn looks_like_image(bytes: &[u8]) -> bool {
    if bytes.starts_with(b"\x89PNG") || bytes.starts_with(b"\xff\xd8") || bytes.starts_with(b"GIF8")
    {
        return true;
    }
    bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP"
}

/// 响应体开头像 HTML / JSON 文本时，几乎可以确定拿到的是错误页而不是图片
fn looks_like_text_body(bytes: &[u8]) -> bool {
    bytes
        .iter()
        .find(|b| !b.is_ascii_whitespace())
        .is_some_and(|b| matches!(*b, b'<' | b'{' | b'['))
}

/// 下载结果校验（F-011）：体积上限 + 魔数。错误消息面向用户，明确「下载到的不是图片」。
fn validate_downloaded_image(bytes: &[u8], max_bytes: usize) -> Result<(), AdapterError> {
    if bytes.len() > max_bytes {
        return Err(AdapterError::Other {
            message: format!("图片体积超过上限 {} MB", max_bytes / 1024 / 1024),
        });
    }
    if looks_like_image(bytes) {
        return Ok(());
    }
    if looks_like_text_body(bytes) {
        return Err(AdapterError::Other {
            message: "下载内容不是图片（可能是错误页或登录页），请检查服务商图片链接".into(),
        });
    }
    Err(AdapterError::Other {
        message: "下载内容不是支持的图片格式（仅支持 PNG/JPEG/GIF/WebP）".into(),
    })
}

/// 下载远程图片并做安全校验（F-011）：状态码、体积上限、魔数。
///
/// 不复用 `classify_http`：这里的 401/403 只表示图片链接不可访问，
/// 若映射成 `AuthInvalid` 会被上层误判为 API Key 失效而触发换 Key。
pub(crate) async fn download_image_bytes(
    url: &str,
    timeout: Duration,
) -> Result<Vec<u8>, AdapterError> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(AdapterError::Other {
            message: format!("图片地址不是 http(s): {url}"),
        });
    }
    let resp = http_client()
        .get(url)
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| classify_reqwest(&e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let truncated: String = text.chars().take(ERROR_BODY_TRUNCATE_LEN).collect();
        return Err(AdapterError::Other {
            message: format!("下载图片失败 HTTP {status}: {truncated}"),
        });
    }
    if resp
        .content_length()
        .is_some_and(|len| len > MAX_REMOTE_IMAGE_BYTES as u64)
    {
        return Err(AdapterError::Other {
            message: format!(
                "图片体积超过上限 {} MB",
                MAX_REMOTE_IMAGE_BYTES / 1024 / 1024
            ),
        });
    }
    let bytes = resp.bytes().await.map_err(|e| classify_reqwest(&e))?;
    validate_downloaded_image(&bytes, MAX_REMOTE_IMAGE_BYTES)?;
    Ok(bytes.to_vec())
}

pub fn classify_http(status: reqwest::StatusCode, body: &str) -> AdapterError {
    let truncated: String = body.chars().take(ERROR_BODY_TRUNCATE_LEN).collect();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        AdapterError::AuthInvalid {
            message: truncated,
            status: status.as_u16(),
        }
    } else if status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status == reqwest::StatusCode::PAYMENT_REQUIRED
        || status.as_u16() == 402
        || status.as_u16() == 429
    {
        AdapterError::QuotaExceeded { message: truncated }
    } else if status.as_u16() == 400 && is_content_policy_block(body) {
        AdapterError::ContentBlocked { message: truncated }
    } else {
        AdapterError::Other {
            message: format!("HTTP {}: {}", status, truncated),
        }
    }
}

/// 内容审核拦截判定：仅当响应体出现明确的审核/安全关键词时才归类为
/// ContentBlocked，避免普通 400（如参数错误）因含 "content" 字样被误判（m26）
fn is_content_policy_block(body: &str) -> bool {
    let lower = body.to_lowercase();
    lower.contains("content_policy")
        || lower.contains("content policy")
        || lower.contains("moderation")
        || lower.contains("safety")
        || body.contains("审核")
}

pub fn classify_reqwest(err: &reqwest::Error) -> AdapterError {
    if err.is_timeout() {
        AdapterError::Timeout {
            message: err.to_string(),
        }
    } else if err.is_connect() {
        AdapterError::Network {
            message: err.to_string(),
        }
    } else {
        AdapterError::Other {
            message: err.to_string(),
        }
    }
}

/// 响应体解析失败时保留的字符数：够看出是 HTML 错误页、错误 JSON 还是压缩字节
const JSON_PREVIEW_CHARS: usize = 300;

/// 解压后允许的最大字节数：防止被构造成压缩炸弹的响应撑爆内存
const MAX_DECODED_BODY_BYTES: u64 = 64 * 1024 * 1024;

/// 读取成功响应并按 JSON 解析。
///
/// 不用 `Response::json()`，也不交给 reqwest 自动解压：链路（安全软件 / 透明代理 /
/// 网关）一旦谎报或篡改 Content-Encoding，reqwest 会丢掉原始字节，只留下
/// "error decoding response body"。这里读原始字节后自己按「明文 → 魔数 → 头」宽容解码。
pub async fn parse_json_body<T: serde::de::DeserializeOwned>(
    resp: reqwest::Response,
    api: &str,
) -> Result<T, AdapterError> {
    let status = resp.status().as_u16();
    let content_type = header_value(&resp, reqwest::header::CONTENT_TYPE);
    let content_encoding = header_value(&resp, reqwest::header::CONTENT_ENCODING);
    let content_length = header_value(&resp, reqwest::header::CONTENT_LENGTH);
    let started = std::time::Instant::now();
    let bytes = match resp.bytes().await {
        Ok(bytes) => bytes,
        Err(e) => {
            // 读流失败原先只透出 "error decoding response body"，状态码 / 编码 / 耗时全丢失
            let message = format!(
                "{api} 读取响应失败（{}，耗时 {:.1}s）: {}",
                response_meta(status, &content_type, &content_encoding, &content_length),
                started.elapsed().as_secs_f64(),
                reqwest_error_chain(&e),
            );
            tracing::warn!("{}", message);
            return Err(if e.is_timeout() {
                AdapterError::Timeout { message }
            } else {
                AdapterError::Other { message }
            });
        }
    };
    parse_json_bytes(api, status, &content_type, &content_encoding, &bytes)
}

fn header_value(resp: &reqwest::Response, name: reqwest::header::HeaderName) -> String {
    resp.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string()
}

fn response_meta(
    status: u16,
    content_type: &str,
    content_encoding: &str,
    content_length: &str,
) -> String {
    let mut meta = format!("HTTP {status}");
    for (name, value) in [
        ("Content-Type", content_type),
        ("Content-Encoding", content_encoding),
        ("Content-Length", content_length),
    ] {
        if !value.is_empty() {
            meta.push_str(", ");
            meta.push_str(name);
            meta.push_str(": ");
            meta.push_str(value);
        }
    }
    meta
}

/// reqwest 顶层只有一句 "error decoding response body"，真正原因（连接中断 / 解压失败 /
/// 超时）在 source 链里，必须展开才能定位。
fn reqwest_error_chain(err: &reqwest::Error) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut current: Option<&(dyn std::error::Error + 'static)> = Some(err);
    while let Some(e) = current {
        let text = e.to_string();
        if !text.is_empty() && parts.last().map(String::as_str) != Some(text.as_str()) {
            parts.push(text);
        }
        current = e.source();
    }
    let hint = if err.is_timeout() {
        "（等待响应超时）"
    } else if err.is_connect() {
        "（连接失败）"
    } else if err.is_body() || err.is_decode() {
        "（响应流读取或解压失败）"
    } else {
        ""
    };
    format!("{}{}", parts.join(" <- "), hint)
}

/// 解析失败时把接口、状态码、编码与响应体开头写进错误并落日志（诊断包会带上）。
pub(crate) fn parse_json_bytes<T: serde::de::DeserializeOwned>(
    api: &str,
    status: u16,
    content_type: &str,
    content_encoding: &str,
    bytes: &[u8],
) -> Result<T, AdapterError> {
    // 明文优先：头写了 gzip 但 body 已被中间层解压时，这一步就能直接成功
    match serde_json::from_slice(bytes) {
        Ok(value) => Ok(value),
        Err(plain_err) => {
            let Some(decoded) = decode_body(bytes, content_encoding) else {
                return Err(parse_error(
                    api,
                    status,
                    content_type,
                    content_encoding,
                    None,
                    bytes,
                    &plain_err,
                ));
            };
            match serde_json::from_slice(&decoded) {
                Ok(value) => Ok(value),
                // 解压成功但内容不是 JSON：按解压后的内容报告，才能看到真实错误页
                Err(decoded_err) => Err(parse_error(
                    api,
                    status,
                    content_type,
                    content_encoding,
                    Some(&decoded),
                    bytes,
                    &decoded_err,
                )),
            }
        }
    }
}

fn parse_error(
    api: &str,
    status: u16,
    content_type: &str,
    content_encoding: &str,
    decoded: Option<&[u8]>,
    body: &[u8],
    err: &serde_json::Error,
) -> AdapterError {
    let meta = response_meta(status, content_type, content_encoding, "");
    let (size, preview) = match decoded {
        Some(decoded) => (
            format!("解压后 {} 字节", decoded.len()),
            body_preview(decoded),
        ),
        None => (format!("{} 字节", body.len()), body_preview(body)),
    };
    let message = format!("{api} 响应解析失败（{meta}，{size}）: {err}；响应体开头: {preview}");
    tracing::warn!("{}", message);
    AdapterError::Other { message }
}

/// 宽容解码：先看压缩魔数（头可能缺失），再按 Content-Encoding 逐段解。
/// 请求已声明 `Accept-Encoding: identity`，走到这里说明链路仍然强行压缩了。
fn decode_body(bytes: &[u8], content_encoding: &str) -> Option<Vec<u8>> {
    if bytes.starts_with(&[0x1f, 0x8b]) {
        return inflate_with(flate2::read::GzDecoder::new(bytes));
    }
    for token in content_encoding
        .split(',')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .rev()
    {
        match token.to_ascii_lowercase().as_str() {
            "gzip" | "x-gzip" => return inflate_with(flate2::read::GzDecoder::new(bytes)),
            // 规范是 zlib 包装，但不少服务端/网关发裸 deflate，两种都试
            "deflate" => {
                return inflate_with(flate2::read::ZlibDecoder::new(bytes))
                    .or_else(|| inflate_with(flate2::read::DeflateDecoder::new(bytes)))
            }
            _ => {}
        }
    }
    None
}

fn inflate_with<R: std::io::Read>(reader: R) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut out = Vec::new();
    reader
        .take(MAX_DECODED_BODY_BYTES + 1)
        .read_to_end(&mut out)
        .ok()?;
    if out.is_empty() || out.len() as u64 > MAX_DECODED_BODY_BYTES {
        return None;
    }
    Some(out)
}

fn body_preview(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return "<空响应体>".into();
    }
    // 先按字节截断再转字符串：多字节字符被切在中间时 lossy 兜底，不会 panic
    let head = &bytes[..bytes.len().min(2048)];
    if head.iter().any(|b| !is_displayable(*b)) {
        let hex: Vec<String> = head.iter().take(32).map(|b| format!("{b:02x}")).collect();
        return format!("<二进制> {}", hex.join(" "));
    }
    openai::truncate_preview(&String::from_utf8_lossy(head), JSON_PREVIEW_CHARS)
}

fn is_displayable(b: u8) -> bool {
    matches!(b, b'\t' | b'\n' | b'\r') || (0x20..=0x7e).contains(&b) || b >= 0x80
}

#[cfg(test)]
mod download_tests {
    use super::*;

    fn png_bytes() -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.extend_from_slice(&[0, 0, 0, 0]);
        bytes
    }

    /// F-011：四种受支持格式的魔数都被接受
    #[test]
    fn accepts_supported_image_magic() {
        assert!(validate_downloaded_image(&png_bytes(), 1024).is_ok());
        assert!(validate_downloaded_image(b"\xff\xd8\xff\xe0rest", 1024).is_ok());
        assert!(validate_downloaded_image(b"GIF89a....", 1024).is_ok());
        assert!(validate_downloaded_image(b"RIFF\x00\x00\x00\x00WEBPdata", 1024).is_ok());
    }

    /// F-011：错误页 / JSON 错误体 / 超限体积都必须被拒绝
    #[test]
    fn rejects_error_page_and_oversize_body() {
        let err = validate_downloaded_image(b"<html>403 Forbidden</html>", 1024).unwrap_err();
        assert!(err.message().contains("不是图片"), "{}", err.message());
        let err = validate_downloaded_image(br#"{"error":"link expired"}"#, 1024).unwrap_err();
        assert!(err.message().contains("不是图片"), "{}", err.message());
        let err = validate_downloaded_image(&vec![0u8; 2048], 1024).unwrap_err();
        assert!(err.message().contains("体积超过上限"), "{}", err.message());
    }

    /// F-011：非图片的二进制格式也要明确报格式不支持
    #[test]
    fn rejects_unknown_binary_format() {
        let err = validate_downloaded_image(b"BM\x00\x00", 1024).unwrap_err();
        assert!(
            err.message().contains("不是支持的图片格式"),
            "{}",
            err.message()
        );
    }
}

#[cfg(test)]
mod json_parse_tests {
    use super::*;

    #[derive(Debug, serde::Deserialize)]
    struct Payload {
        data: Vec<String>,
    }

    #[test]
    fn parses_valid_payload() {
        let parsed: Payload =
            parse_json_bytes("api", 200, "application/json", "", br#"{"data":["a"]}"#).unwrap();
        assert_eq!(parsed.data, vec!["a".to_string()]);
    }

    /// 200 拿到 HTML（网关/代理拦截页）时，错误里必须有状态码、编码与响应体开头
    #[test]
    fn parse_error_reports_status_headers_and_body() {
        let body = "<html><body>gateway blocked</body></html>";
        let err = parse_json_bytes::<Payload>(
            "/images/generations",
            200,
            "text/html; charset=utf-8",
            "gzip",
            body.as_bytes(),
        )
        .unwrap_err();
        let message = err.message();
        for needle in [
            "/images/generations",
            "HTTP 200",
            "text/html",
            "Content-Encoding: gzip",
            &format!("{} 字节", body.len()),
            "gateway blocked",
        ] {
            assert!(message.contains(needle), "缺少 {needle}: {message}");
        }
    }

    /// 200 但 JSON 形状不对（中转站把上游错误包成 200）时，能看到 serde 原因与真实响应体
    #[test]
    fn parse_error_on_unexpected_json_shape() {
        let err = parse_json_bytes::<Payload>(
            "/images/generations",
            200,
            "application/json",
            "",
            br#"{"error":{"message":"upstream failed"}}"#,
        )
        .unwrap_err();
        let message = err.message();
        assert!(message.contains("missing field `data`"), "{message}");
        assert!(message.contains("upstream failed"), "{message}");
    }

    #[test]
    fn parse_error_on_empty_body() {
        let err = parse_json_bytes::<Payload>("api", 200, "", "", b"").unwrap_err();
        assert!(err.message().contains("<空响应体>"), "{}", err.message());
    }

    /// 多字节字符被字节截断切开时走 lossy 兜底，不 panic，预览仍按字符截断
    #[test]
    fn parse_error_preview_is_char_safe() {
        let body = format!("<html>{}</html>", "错".repeat(400));
        let err =
            parse_json_bytes::<Payload>("api", 200, "text/html", "", body.as_bytes()).unwrap_err();
        assert!(err.message().contains('…'), "{}", err.message());
    }

    fn gzip(data: &[u8]) -> Vec<u8> {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write;
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(data).unwrap();
        encoder.finish().unwrap()
    }

    /// 核心回归：头写了 gzip 但中间层已把 body 解成明文，必须直接解析成功
    /// （旧实现交给 reqwest 自动解压，这条路径只会得到 "error decoding response body"）
    #[test]
    fn accepts_plain_body_with_lying_gzip_header() {
        let parsed: Payload =
            parse_json_bytes("api", 200, "application/json", "gzip", br#"{"data":["a"]}"#).unwrap();
        assert_eq!(parsed.data, vec!["a".to_string()]);
    }

    /// 头缺失但字节是 gzip：按魔数兜底解压
    #[test]
    fn accepts_gzip_body_without_header() {
        let body = gzip(br#"{"data":["b"]}"#);
        let parsed: Payload = parse_json_bytes("api", 200, "application/json", "", &body).unwrap();
        assert_eq!(parsed.data, vec!["b".to_string()]);
    }

    /// 头与字节一致的 gzip：由自身解码，不依赖 reqwest 的自动解压特性
    #[test]
    fn accepts_gzip_body_with_header() {
        let body = gzip(br#"{"data":["c"]}"#);
        let parsed: Payload =
            parse_json_bytes("api", 200, "application/json", "gzip", &body).unwrap();
        assert_eq!(parsed.data, vec!["c".to_string()]);
    }

    /// 截断的压缩流：错误里必须有状态码 / 编码 / 字节数，预览用十六进制而不是乱码
    #[test]
    fn binary_parse_error_previews_hex() {
        let mut body = gzip(br#"{"data":["d"]}"#);
        body.truncate(body.len() / 2);
        let err =
            parse_json_bytes::<Payload>("api", 200, "application/json", "gzip", &body).unwrap_err();
        let message = err.message();
        for needle in [
            "HTTP 200",
            "Content-Encoding: gzip",
            &format!("{} 字节", body.len()),
            "<二进制> 1f 8b",
        ] {
            assert!(message.contains(needle), "缺少 {needle}: {message}");
        }
    }
}
