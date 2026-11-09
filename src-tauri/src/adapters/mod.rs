pub mod chat;
pub mod http;
pub mod mock;
pub mod openai;
pub mod template;
#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

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
        /// 服务商建议的等待秒数（Retry-After：秒或 HTTP 日期），队列据此退避
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retry_after: Option<u64>,
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
    /// 上游 5xx / 408 / 409 / 425：请求可能已被受理并计费，不可自动重放
    Upstream {
        message: String,
        #[serde(default)]
        status: u16,
    },
    /// 请求体发出后连接中断 / 读响应失败：无法判断上游是否已计费
    BodyInterrupted {
        message: String,
    },
    /// 结果未确认：可能已计费但拿不到产物；带请求 id 供对账
    Unconfirmed {
        message: String,
        #[serde(default)]
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        artifact: Option<String>,
    },
    Other {
        message: String,
    },
}

impl AdapterError {
    pub fn message(&self) -> &str {
        match self {
            AdapterError::AuthInvalid { message, .. }
            | AdapterError::QuotaExceeded { message, .. }
            | AdapterError::Timeout { message }
            | AdapterError::ContentBlocked { message }
            | AdapterError::Network { message }
            | AdapterError::Unsupported { message }
            | AdapterError::Upstream { message, .. }
            | AdapterError::BodyInterrupted { message }
            | AdapterError::Unconfirmed { message, .. }
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
    /// 带计费流水的生成入口。默认实现忽略上下文，适配器可按需覆盖
    /// （OpenAI 兼容适配器用它实现「200 先记证据、逐张容错」）。
    fn generate_journaled<'a>(
        &'a self,
        config: &'a ProviderConfig,
        req: &'a GenerateRequest,
        _ctx: Option<&'a crate::billing_journal::AttemptCtx>,
    ) -> BoxFuture<'a, Result<Vec<String>, AdapterError>> {
        self.generate(config, req)
    }
    fn edit_journaled<'a>(
        &'a self,
        config: &'a ProviderConfig,
        req: &'a EditRequest,
        _ctx: Option<&'a crate::billing_journal::AttemptCtx>,
    ) -> BoxFuture<'a, Result<String, AdapterError>> {
        self.edit(config, req)
    }
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
    /// 带计费流水的放大 / 换风格入口（与 generate_journaled 同语义）
    fn transform_journaled<'a>(
        &'a self,
        config: &'a ProviderConfig,
        req: &'a TransformRequest,
        _ctx: Option<&'a crate::billing_journal::AttemptCtx>,
    ) -> BoxFuture<'a, Result<String, AdapterError>> {
        self.transform(config, req)
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
pub(crate) fn http_client() -> Result<Arc<reqwest::Client>, AdapterError> {
    http::current_client().map_err(|e| AdapterError::Other { message: e })
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

/// 本地/内网/云元数据地址：服务商返回的图片 URL 是不可信输入，必须拒绝（SSRF）
fn blocked_host(host: &str) -> bool {
    let host = host
        .trim_end_matches('.')
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    if host.is_empty()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
    {
        return true;
    }
    let Ok(ip) = host.parse::<std::net::IpAddr>() else {
        return false;
    };
    match ip {
        std::net::IpAddr::V4(v4) => blocked_v4(v4),
        std::net::IpAddr::V6(v6) => {
            let segments = v6.segments();
            v6.is_loopback()
                || v6.is_unspecified()
                // fc00::/7 unique-local 与 fe80::/10 link-local
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
                || v6.to_ipv4_mapped().is_some_and(blocked_v4)
        }
    }
}

fn blocked_v4(ip: std::net::Ipv4Addr) -> bool {
    let octets = ip.octets();
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || octets[0] == 0
        // 100.64.0.0/10 运营商级 NAT
        || (octets[0] == 100 && (64..128).contains(&octets[1]))
}

fn validate_remote_url(url: &str) -> Result<reqwest::Url, AdapterError> {
    let parsed = reqwest::Url::parse(url).map_err(|e| AdapterError::Other {
        message: format!("图片地址无效: {e}"),
    })?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AdapterError::Other {
            message: format!("图片地址不是 http(s): {}", parsed.scheme()),
        });
    }
    let host = parsed.host_str().unwrap_or_default();
    if host.is_empty() {
        return Err(AdapterError::Other {
            message: "图片地址缺少主机名".into(),
        });
    }
    if blocked_host(host) {
        return Err(AdapterError::Other {
            message: "图片地址指向本地或内网，已拒绝下载".into(),
        });
    }
    Ok(parsed)
}

/// 重定向每一跳都重新校验，最多 3 跳
pub(crate) fn safe_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 3 {
            return attempt.error("图片下载重定向次数过多");
        }
        let url = attempt.url();
        if !matches!(url.scheme(), "http" | "https") {
            return attempt.error("图片下载重定向到非 http(s) 地址");
        }
        match url.host_str() {
            Some(host) if !blocked_host(host) => attempt.follow(),
            _ => attempt.error("图片下载重定向到本地或内网地址"),
        }
    })
}

fn append_chunk(out: &mut Vec<u8>, chunk: &[u8], max: usize) -> Result<(), AdapterError> {
    if out.len() + chunk.len() > max {
        return Err(AdapterError::Other {
            message: format!("响应体超过上限 {} MB", max / 1024 / 1024),
        });
    }
    out.extend_from_slice(chunk);
    Ok(())
}

/// 远程图片下载等待响应头的上限：与生成长请求无关，沿用旧的 60s 默认。
/// 响应体另由 `read_body_with_idle` 按空闲 / 总时长约束。
const DOWNLOAD_HEADER_TIMEOUT: Duration = Duration::from_secs(60);

/// 下载远程图片并做安全校验（F-011）：状态码、体积上限、魔数。
///
/// 不复用 `classify_http`：这里的 401/403 只表示图片链接不可访问，
/// 若映射成 `AuthInvalid` 会被上层误判为 API Key 失效而触发换 Key。
pub(crate) async fn download_image_bytes(
    url: &str,
    timeout: Duration,
) -> Result<Vec<u8>, AdapterError> {
    let parsed = validate_remote_url(url)?;
    let request = http::image_client()
        .map_err(|e| AdapterError::Other { message: e })?
        .get(parsed);
    let resp = send_with_timeout(request, timeout.min(DOWNLOAD_HEADER_TIMEOUT), "下载图片").await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = read_error_text(resp).await;
        let truncated: String = crate::redact::redact_secrets(&text)
            .chars()
            .take(ERROR_BODY_TRUNCATE_LEN)
            .collect();
        let message = format!("下载图片失败 HTTP {status}: {truncated}");
        // 5xx 是瞬时故障：交给下载器重试（只重下载，绝不重新生成）
        return Err(if status.is_server_error() {
            AdapterError::Upstream {
                message,
                status: status.as_u16(),
            }
        } else {
            AdapterError::Other { message }
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
    let bytes = read_body_with_idle(
        resp,
        "下载图片",
        body_idle_timeout(),
        body_total_timeout(),
        MAX_REMOTE_IMAGE_BYTES,
    )
    .await?;
    validate_downloaded_image(&bytes, MAX_REMOTE_IMAGE_BYTES)?;
    Ok(bytes)
}

pub fn classify_http(status: reqwest::StatusCode, body: &str) -> AdapterError {
    classify_http_with_retry_after(status, body, None)
}

pub fn classify_http_with_retry_after(
    status: reqwest::StatusCode,
    body: &str,
    retry_after: Option<u64>,
) -> AdapterError {
    // 错误体可能回显请求 URL / Header，统一脱敏后再截断
    let truncated: String = crate::redact::redact_secrets(body)
        .chars()
        .take(ERROR_BODY_TRUNCATE_LEN)
        .collect();
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
        AdapterError::QuotaExceeded {
            message: truncated,
            retry_after,
        }
    } else if status.as_u16() == 400 && is_content_policy_block(body) {
        AdapterError::ContentBlocked { message: truncated }
    } else if matches!(status.as_u16(), 408 | 409 | 425) || status.is_server_error() {
        // 5xx / 请求冲突：上游可能已受理，按「可能已计费」处理，绝不自动重放
        AdapterError::Upstream {
            message: format!("HTTP {}: {}", status, truncated),
            status: status.as_u16(),
        }
    } else {
        AdapterError::Other {
            message: format!("HTTP {}: {}", status, truncated),
        }
    }
}

/// 读取 Retry-After：支持秒数与 HTTP 日期两种格式
pub(crate) fn retry_after_secs(resp: &reqwest::Response) -> Option<u64> {
    let raw = resp
        .headers()
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?;
    let raw = raw.trim();
    if let Ok(secs) = raw.parse::<u64>() {
        return Some(secs);
    }
    let when = parse_http_date(raw)?;
    when.duration_since(std::time::SystemTime::now())
        .ok()
        .map(|d| d.as_secs().max(1))
}

/// 解析 RFC 7231 IMF-fixdate（`Sun, 06 Nov 1994 08:49:37 GMT`）
fn parse_http_date(raw: &str) -> Option<std::time::SystemTime> {
    let parts: Vec<&str> = raw.split_whitespace().collect();
    if parts.len() != 6 || !parts[5].eq_ignore_ascii_case("GMT") {
        return None;
    }
    let day: u32 = parts[1].parse().ok()?;
    let month = match parts[2].to_ascii_lowercase().as_str() {
        "jan" => 1,
        "feb" => 2,
        "mar" => 3,
        "apr" => 4,
        "may" => 5,
        "jun" => 6,
        "jul" => 7,
        "aug" => 8,
        "sep" => 9,
        "oct" => 10,
        "nov" => 11,
        "dec" => 12,
        _ => return None,
    };
    let year: i32 = parts[3].parse().ok()?;
    let time: Vec<u32> = parts[4]
        .split(':')
        .map(|p| p.parse::<u32>().ok())
        .collect::<Option<Vec<_>>>()?;
    if time.len() != 3 || day == 0 || day > 31 || time[0] > 23 || time[1] > 59 || time[2] > 60 {
        return None;
    }
    let secs = days_from_civil(year, month, day) * 86_400
        + time[0] as i64 * 3600
        + time[1] as i64 * 60
        + time[2] as i64;
    if secs < 0 {
        return None;
    }
    Some(std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs as u64))
}

/// Howard Hinnant 的 days_from_civil 算法：公历日期 → 1970-01-01 起的天数
fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let y = year - if month <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u32;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era as i64 * 146_097 + doe as i64 - 719_468
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
    // reqwest 的 Display 会带上请求 URL；模板适配器把 key 放在 query 里，必须脱敏。
    // 只取顶层 Display 会丢底层原因（如 connection closed），排障时无法区分
    // 连接重置 / 证书 / DNS，因此带上 source 链。
    let message = crate::redact::redact_secrets(&reqwest_error_chain(err));
    // 建连失败（含连接超时）说明请求从未送达，是唯一可以安全重试的一类。
    // 必须放在 is_timeout 之前：连接超时同样是 timeout，但语义完全不同。
    if err.is_connect() {
        AdapterError::Network { message }
    } else if err.is_timeout() {
        AdapterError::Timeout { message }
    } else {
        let hint = connection_reset_hint(&message).unwrap_or_default();
        // 非建连、非超时：请求体可能已经发出，结果未知
        AdapterError::BodyInterrupted {
            message: format!("{message}{hint}"),
        }
    }
}

/// 连接在响应头之前被重置时的可执行提示。
///
/// Windows 10053/10054 常由代理或安全软件回收空闲 keep-alive 连接引起。
/// 该错误发生时请求体可能已送达上游，不能自动重试（与计费安全策略一致），
/// 只提示用户先确认是否已生成，再决定是否重发。
fn connection_reset_hint(message: &str) -> Option<&'static str> {
    let lower = message.to_ascii_lowercase();
    let reset = lower.contains("os error 10054")
        || lower.contains("os error 10053")
        || lower.contains("connection reset")
        || message.contains("强迫关闭");
    reset.then_some(
        "；连接在响应返回前被重置（常见于代理或安全软件回收空闲连接）。\
         已为生成请求禁用空闲连接复用，请重新发起；\
         若上游可能已处理，先在服务商后台确认再重试，避免重复计费",
    )
}

/// 响应体解析失败时保留的字符数：够看出是 HTML 错误页、错误 JSON 还是压缩字节
const JSON_PREVIEW_CHARS: usize = 300;

/// 解压后允许的最大字节数：防止被构造成压缩炸弹的响应撑爆内存
const MAX_DECODED_BODY_BYTES: u64 = 64 * 1024 * 1024;

/// 响应体空闲超时：连续这么久没有收到新数据才判定失败。
/// 不能与「等待生成」的服务商超时共用：图片接口常返回 3–4MB base64，
/// 慢链路上生成 40s + 下载 25s，总截止时间会把 HTTP 200 的响应体截断。
/// 两项均可由设置热更新，默认值见 `storage::DEFAULT_BODY_*`。
static BODY_IDLE_TIMEOUT_SECS: AtomicU64 =
    AtomicU64::new(crate::storage::DEFAULT_BODY_IDLE_TIMEOUT_SECS);
/// 响应体总时长硬上限，避免持续滴流的异常链路长期占用生成槽位。
static BODY_TOTAL_TIMEOUT_SECS: AtomicU64 =
    AtomicU64::new(crate::storage::DEFAULT_BODY_TOTAL_TIMEOUT_SECS);
/// 未解压响应体上限（解压后另有 `MAX_DECODED_BODY_BYTES`）。
const MAX_RAW_BODY_BYTES: usize = 64 * 1024 * 1024;

/// 启动 / 配置导入后从设置加载响应体超时。
pub fn init_body_timeouts() {
    let (idle, total) = crate::storage::body_timeout_secs();
    apply_body_timeouts(idle, total);
}

/// 热更新响应体超时；调用方已完成取值范围与跨字段校验。
pub fn apply_body_timeouts(idle_secs: u64, total_secs: u64) {
    let (idle, total) = resolve_body_timeouts(idle_secs, total_secs);
    BODY_IDLE_TIMEOUT_SECS.store(idle.as_secs(), Ordering::Relaxed);
    BODY_TOTAL_TIMEOUT_SECS.store(total.as_secs(), Ordering::Relaxed);
}

/// 兜底：0 视为 1s，总时长不得小于空闲（与存储层脏值兜底同语义）。
pub(crate) fn resolve_body_timeouts(idle_secs: u64, total_secs: u64) -> (Duration, Duration) {
    let idle = idle_secs.max(1);
    let total = total_secs.max(idle);
    (Duration::from_secs(idle), Duration::from_secs(total))
}

fn body_idle_timeout() -> Duration {
    Duration::from_secs(BODY_IDLE_TIMEOUT_SECS.load(Ordering::Relaxed))
}

fn body_total_timeout() -> Duration {
    Duration::from_secs(BODY_TOTAL_TIMEOUT_SECS.load(Ordering::Relaxed))
}

/// 发送请求：服务商超时只约束「等到响应头」，不覆盖响应体下载。
///
/// reqwest 的 `RequestBuilder::timeout` 是整次请求的总截止时间（含读完 body）。
/// 图片接口的 base64 body 很大，若与生成时间共用同一个截止时间，会出现
/// 「HTTP 200 已收到、读到一半 operation timed out」并已被上游计费的情况。
pub(crate) async fn send_with_timeout(
    request: reqwest::RequestBuilder,
    timeout: Duration,
    api: &str,
) -> Result<reqwest::Response, AdapterError> {
    match tokio::time::timeout(timeout, request.send()).await {
        Ok(Ok(resp)) => Ok(resp),
        Ok(Err(e)) => Err(classify_reqwest(&e)),
        Err(_) => {
            let message = format!("{api} 等待服务商响应超时（{}s）", timeout.as_secs());
            // 这里必须落日志：超时不进重试、也不一定有 body 错误日志，
            // 否则诊断包里完全看不到这条请求（用户只看到 UI 报错）。
            tracing::warn!("{}", message);
            Err(AdapterError::Timeout { message })
        }
    }
}

/// 读取错误响应体：错误体很小，用固定短上限，避免无超时的 `resp.text()` 永久挂起。
pub(crate) async fn read_error_text(resp: reqwest::Response) -> String {
    match tokio::time::timeout(Duration::from_secs(30), resp.text()).await {
        Ok(Ok(text)) => text,
        _ => String::new(),
    }
}

/// 按「空闲超时 + 总时长上限 + 体积上限」读取响应体。
async fn read_body_with_idle(
    mut resp: reqwest::Response,
    api: &str,
    idle: Duration,
    total: Duration,
    max: usize,
) -> Result<Vec<u8>, AdapterError> {
    let status = resp.status().as_u16();
    let content_type = header_value(&resp, reqwest::header::CONTENT_TYPE);
    let content_encoding = header_value(&resp, reqwest::header::CONTENT_ENCODING);
    let content_length = header_value(&resp, reqwest::header::CONTENT_LENGTH);
    let expected = resp.content_length().unwrap_or(0);
    let started = Instant::now();
    let mut bytes = Vec::with_capacity((expected as usize).min(8 * 1024 * 1024));

    loop {
        let elapsed = started.elapsed();
        if elapsed >= total {
            return Err(body_timeout(
                api,
                &format!("超过 {}s 总上限", total.as_secs()),
                bytes.len(),
                expected,
                elapsed,
                &response_meta(status, &content_type, &content_encoding, &content_length),
            ));
        }
        let wait = idle.min(total - elapsed);
        match tokio::time::timeout(wait, resp.chunk()).await {
            Ok(Ok(Some(chunk))) => {
                append_chunk(&mut bytes, &chunk, max)?;
            }
            Ok(Ok(None)) => break,
            Ok(Err(e)) => {
                let message = crate::redact::redact_secrets(&format!(
                    "{api} 读取响应失败（{}，耗时 {:.1}s）: {}",
                    response_meta(status, &content_type, &content_encoding, &content_length),
                    started.elapsed().as_secs_f64(),
                    reqwest_error_chain(&e),
                ));
                tracing::warn!("{}", message);
                return Err(if e.is_timeout() {
                    AdapterError::Timeout { message }
                } else {
                    AdapterError::BodyInterrupted { message }
                });
            }
            Err(_) => {
                let reason = if wait < idle {
                    format!("超过 {}s 总上限", total.as_secs())
                } else {
                    format!("{}s 内未收到新数据", idle.as_secs())
                };
                return Err(body_timeout(
                    api,
                    &reason,
                    bytes.len(),
                    expected,
                    started.elapsed(),
                    &response_meta(status, &content_type, &content_encoding, &content_length),
                ));
            }
        }
    }
    Ok(bytes)
}

fn body_timeout(
    api: &str,
    reason: &str,
    received: usize,
    expected: u64,
    elapsed: Duration,
    meta: &str,
) -> AdapterError {
    let total = if expected > 0 {
        expected.to_string()
    } else {
        "未知".to_string()
    };
    let message = format!(
        "{api} 读取响应超时（{reason}，已接收 {received} / {total} 字节，耗时 {:.1}s）：{meta}",
        elapsed.as_secs_f64()
    );
    tracing::warn!("{}", message);
    AdapterError::Timeout { message }
}

/// 读取成功响应并按 JSON 解析。
///
/// 不用 `Response::json()`，也不交给 reqwest 自动解压：链路（安全软件 / 透明代理 /
/// 网关）一旦谎报或篡改 Content-Encoding，reqwest 会丢掉原始字节，只留下
/// "error decoding response body"。这里读原始字节后自己按「明文 → 魔数 → 头」宽容解码。
pub async fn parse_json_body<T: serde::de::DeserializeOwned>(
    resp: reqwest::Response,
    api: &str,
) -> Result<T, AdapterError> {
    parse_json_body_with_ctx(resp, api, None).await
}

/// 带计费流水的响应解析：2xx 先落「已受理」，原始字节先落盘再解析。
///
/// 顺序是刻意的：只要 200 到手就已经计费，任何后续失败都必须留下证据，
/// 而不是等解析成功才记录。
pub async fn parse_json_body_with_ctx<T: serde::de::DeserializeOwned>(
    resp: reqwest::Response,
    api: &str,
    ctx: Option<&crate::billing_journal::AttemptCtx>,
) -> Result<T, AdapterError> {
    let status = resp.status().as_u16();
    let content_type = header_value(&resp, reqwest::header::CONTENT_TYPE);
    let content_encoding = header_value(&resp, reqwest::header::CONTENT_ENCODING);
    if let Some(ctx) = ctx {
        let request_id = ["x-request-id", "x-oneapi-request-id", "request-id"]
            .iter()
            .find_map(|name| {
                resp.headers()
                    .get(*name)
                    .and_then(|v| v.to_str().ok())
                    .filter(|v| !v.is_empty())
            })
            .unwrap_or_default();
        ctx.capture_request_id(request_id);
        if resp.status().is_success() {
            ctx.mark_billed(status, None);
        }
    }
    let bytes = read_body_with_idle(
        resp,
        api,
        body_idle_timeout(),
        body_total_timeout(),
        MAX_RAW_BODY_BYTES,
    )
    .await?;
    if let Some(ctx) = ctx {
        ctx.stash_raw(&bytes);
    }
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
    let message = crate::redact::redact_secrets(&format!(
        "{api} 响应解析失败（{meta}，{size}）: {err}；响应体开头: {preview}"
    ));
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

    /// A4：本地/内网/云元数据地址一律拒绝（SSRF）
    #[test]
    fn rejects_loopback_private_and_metadata_hosts() {
        for host in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "localhost",
            "app.local",
            "metadata.google.internal",
        ] {
            assert!(blocked_host(host), "{host} 应被拒绝");
        }
        assert!(!blocked_host("8.8.8.8"));
        assert!(!blocked_host("example.com"));
    }

    /// A4：初始 URL 与重定向都走同一套校验；非 http(s) 直接拒绝
    #[test]
    fn validate_remote_url_rejects_unsafe_targets() {
        assert!(validate_remote_url("https://cdn.example.com/a.png").is_ok());
        for url in [
            "http://127.0.0.1/a.png",
            "http://169.254.169.254/latest/meta-data",
            "http://localhost:8080/a.png",
            "file:///C:/a.png",
            "not a url",
        ] {
            let err = validate_remote_url(url).unwrap_err();
            assert!(matches!(err, AdapterError::Other { .. }), "{url}");
        }
    }

    /// A4：没有 Content-Length 的流也要在超过上限时立即中止
    #[test]
    fn streaming_append_stops_oversize_chunks() {
        let mut out = Vec::new();
        append_chunk(&mut out, &[0u8; 6], 10).unwrap();
        let err = append_chunk(&mut out, &[0u8; 6], 10).unwrap_err();
        assert!(
            err.message().contains("响应体超过上限"),
            "{}",
            err.message()
        );
        assert_eq!(out.len(), 6, "超限分块不应被写入");
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
