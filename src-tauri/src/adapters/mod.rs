pub mod chat;
pub mod mock;
pub mod openai;
pub mod template;
#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

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
    /// 参考图（base64，无 data-url 前缀），随 multipart 上送
    pub images: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditRequest {
    pub prompt: String,
    pub model: String,
    pub image_b64: String,
    pub mask_b64: Option<String>,
    pub width: u32,
    pub height: u32,
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
    // 透传参数（JSON 对象字符串，合并进请求体）
    pub extra_params: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AdapterError {
    AuthInvalid { message: String },
    QuotaExceeded { message: String },
    Timeout { message: String },
    ContentBlocked { message: String },
    Network { message: String },
    Other { message: String },
}

impl AdapterError {
    pub fn message(&self) -> &str {
        match self {
            AdapterError::AuthInvalid { message }
            | AdapterError::QuotaExceeded { message }
            | AdapterError::Timeout { message }
            | AdapterError::ContentBlocked { message }
            | AdapterError::Network { message }
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

/// 全局共享 reqwest Client（连接池/TLS 会话复用，P5）；超时在各请求级单独设置
static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

pub(crate) fn http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

pub fn classify_http(status: reqwest::StatusCode, body: &str) -> AdapterError {
    let truncated: String = body.chars().take(ERROR_BODY_TRUNCATE_LEN).collect();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        AdapterError::AuthInvalid { message: truncated }
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
