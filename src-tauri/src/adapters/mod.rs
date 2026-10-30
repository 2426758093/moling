pub mod chat;
pub mod http;
pub mod mock;
pub mod openai;
pub mod template;
#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};
use std::sync::Arc;

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
