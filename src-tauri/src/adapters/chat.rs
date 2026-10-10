use super::{classify_http, classify_reqwest, http_client, AdapterError, ProviderConfig};

/// chat completions 的 temperature 默认值（思考优化用）
const CHAT_TEMPERATURE: f64 = 0.7;
/// 反推提示词的 temperature（输出需稳定可复现）
const REVERSE_TEMPERATURE: f64 = 0.4;

fn request_timeout(config: &ProviderConfig) -> std::time::Duration {
    std::time::Duration::from_secs(config.timeout_secs)
}

/// 调用 OpenAI 兼容的 /chat/completions，返回首个回复的文本
pub async fn chat_complete(
    config: &ProviderConfig,
    model: &str,
    system: &str,
    user: &str,
) -> Result<String, AdapterError> {
    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
        "temperature": CHAT_TEMPERATURE,
    });
    let resp = http_client()
        .post(format!(
            "{}/chat/completions",
            config.base_url.trim_end_matches('/')
        ))
        .timeout(request_timeout(config))
        .bearer_auth(&config.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| classify_reqwest(&e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(classify_http(status, &text));
    }
    let parsed: serde_json::Value = resp.json().await.map_err(|e| AdapterError::Other {
        message: format!("响应解析失败: {}", e),
    })?;
    extract_reply_text(&parsed)
}

/// 提示词优化用的系统提示：强约束只输出提示词
pub const REFINE_SYSTEM_PROMPT: &str = "\
你是一名顶级 AI 绘画提示词工程师。用户会给出简短、口语化甚至不完整的中文或英文绘画意图。
你的任务：
1. 理解用户真正想表达的画面意图（主体、场景、情绪、风格、光影、构图）；
2. 将其扩写为一段高质量、具体的英文图像生成提示词（80 词以内），可直接用于文生图模型；
3. 如果用户提供了参考图上下文，结合上下文让新提示词与参考图协调；
4. 只输出最终的提示词文本本身，不要输出任何解释、引号、前后缀或 Markdown。";

pub fn build_refine_user_input(raw: &str, context: Option<&str>) -> String {
    match context {
        Some(ctx) if !ctx.trim().is_empty() => {
            format!(
                "对话上下文（之前生成的画面描述）：\n{}\n\n用户新的请求：\n{}",
                ctx, raw
            )
        }
        _ => raw.to_string(),
    }
}

pub const REVERSE_SYSTEM_PROMPT: &str = "\
你是一名 AI 绘画提示词反推专家。用户会给你一张图片，你的任务：
1. 仔细观察图片的主体、场景、构图、光线、色彩、风格、质感细节；
2. 输出一段高质量的英文文生图提示词（80 词以内），能高度还原这张图；
3. 只输出提示词文本本身，不要任何解释、引号或 Markdown。";

/// 多模态反推：图片以 data URL 随 chat completions 上送
pub async fn reverse_prompt(
    config: &ProviderConfig,
    model: &str,
    image_data_url: &str,
) -> Result<String, AdapterError> {
    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": REVERSE_SYSTEM_PROMPT },
            {
                "role": "user",
                "content": [
                    { "type": "text", "text": "请反推这张图片的绘制提示词。" },
                    { "type": "image_url", "image_url": { "url": image_data_url } }
                ]
            },
        ],
        "temperature": REVERSE_TEMPERATURE,
    });
    let resp = http_client()
        .post(format!(
            "{}/chat/completions",
            config.base_url.trim_end_matches('/')
        ))
        .timeout(request_timeout(config))
        .bearer_auth(&config.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| classify_reqwest(&e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(classify_http(status, &text));
    }
    let parsed: serde_json::Value = resp.json().await.map_err(|e| AdapterError::Other {
        message: format!("响应解析失败: {}", e),
    })?;
    extract_reply_text(&parsed)
}

fn extract_reply_text(parsed: &serde_json::Value) -> Result<String, AdapterError> {
    parsed["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AdapterError::Other {
            message: "chat/completions 未返回文本内容".into(),
        })
}
