use super::{classify_http, classify_reqwest, http_client, AdapterError, ProviderConfig};

/// chat completions 的 temperature 默认值（思考优化用）
const CHAT_TEMPERATURE: f64 = 0.7;
/// 反推提示词的 temperature（输出需稳定可复现）
const REVERSE_TEMPERATURE: f64 = 0.4;

/// 单块读取的最长等待：半开连接不应拖到整体超时才断开
const STREAM_CHUNK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// 流式取消标记（与 commands::GenerationRegistry 共用 Arc<AtomicBool>）
pub type CancelFlag = std::sync::Arc<std::sync::atomic::AtomicBool>;

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

/// SSE 单帧解析结果：正文增量 / 流结束 / 无价值帧（心跳、role 帧、坏帧）
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SseItem {
    Delta(String),
    Done,
    Ignored,
}

/// SSE 解码器：只消费完整帧（`\n\n` / `\r\n\r\n` 结尾），跨 chunk 的半帧留在缓冲里；
/// 帧内多行 `data:` 按 SSE 规范用 `\n` 拼接后再解析。
pub(crate) struct SseDecoder {
    buf: Vec<u8>,
    warned: bool,
}

impl Default for SseDecoder {
    fn default() -> Self {
        Self::new()
    }
}

impl SseDecoder {
    pub fn new() -> Self {
        Self {
            buf: Vec::new(),
            warned: false,
        }
    }

    pub fn feed(&mut self, chunk: &[u8]) -> Vec<SseItem> {
        self.buf.extend_from_slice(chunk);
        let mut items = Vec::new();
        while let Some((frame_len, sep_len)) = find_frame_end(&self.buf) {
            let frame: Vec<u8> = self.buf.drain(..frame_len + sep_len).collect();
            // 分隔符可能是 CRLF 组合，帧体长度已排除它
            let text = String::from_utf8_lossy(&frame[..frame_len]).into_owned();
            items.push(self.parse_frame(&text));
        }
        items
    }

    fn parse_frame(&mut self, frame: &str) -> SseItem {
        let mut data = String::new();
        let mut has_data = false;
        for line in frame.split('\n') {
            let line = line.strip_suffix('\r').unwrap_or(line);
            // 空行与 `:` 注释（心跳）不参与数据拼接
            if line.is_empty() || line.starts_with(':') {
                continue;
            }
            let Some(value) = line.strip_prefix("data:") else {
                continue;
            };
            let value = value.strip_prefix(' ').unwrap_or(value);
            if has_data {
                data.push('\n');
            }
            data.push_str(value);
            has_data = true;
        }
        if !has_data || data.trim().is_empty() {
            return SseItem::Ignored;
        }
        if data.trim() == "[DONE]" {
            return SseItem::Done;
        }
        match serde_json::from_str::<serde_json::Value>(&data) {
            Ok(parsed) => match parsed["choices"][0]["delta"]["content"].as_str() {
                Some(text) if !text.is_empty() => SseItem::Delta(text.to_string()),
                _ => SseItem::Ignored,
            },
            Err(e) => {
                // 坏帧只记一次，避免心跳/工具事件刷日志
                if !self.warned {
                    self.warned = true;
                    tracing::warn!("chat 流出现无法解析的帧，已忽略: {}", e);
                }
                SseItem::Ignored
            }
        }
    }
}

/// 返回 (帧体长度, 分隔符长度)；分隔符为 `\n\n`、`\r\n\r\n` 或混合的 `\n\r\n`
fn find_frame_end(buf: &[u8]) -> Option<(usize, usize)> {
    let mut i = 0;
    while i < buf.len() {
        if buf[i] == b'\n' {
            if buf.get(i + 1) == Some(&b'\n') {
                return Some((i, 2));
            }
            if buf.get(i + 1) == Some(&b'\r') && buf.get(i + 2) == Some(&b'\n') {
                // CRLFCRLF 时前一个 \r 属于分隔符
                let start = if i > 0 && buf[i - 1] == b'\r' {
                    i - 1
                } else {
                    i
                };
                return Some((start, i + 3 - start));
            }
        }
        i += 1;
    }
    None
}

/// 流式 chat completions：逐帧回调增量，返回完整文本（已 trim）。
/// 失败语义：已产出增量后出错一律返回 Err，由上层降级为原文——
/// 半截提示词比原文更糟，且绝不重发请求（避免重复计费与文字闪烁）。
/// 网关忽略 `stream` 时，用同一次响应体做一次性 JSON 解析。
pub async fn chat_stream<F>(
    config: &ProviderConfig,
    model: &str,
    system: &str,
    user: &str,
    cancel: Option<&CancelFlag>,
    mut on_delta: F,
) -> Result<String, AdapterError>
where
    F: FnMut(&str),
{
    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
        "temperature": CHAT_TEMPERATURE,
        "stream": true,
    });
    let mut resp = http_client()
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
    let is_sse = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.to_ascii_lowercase().contains("text/event-stream"));
    if !is_sse {
        let text = resp.text().await.map_err(|e| classify_reqwest(&e))?;
        let parsed: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| AdapterError::Other {
                message: format!("响应解析失败: {}", e),
            })?;
        return extract_reply_text(&parsed);
    }

    let total_timeout = request_timeout(config);
    let start = std::time::Instant::now();
    let mut decoder = SseDecoder::new();
    let mut acc = String::new();
    loop {
        if cancel.is_some_and(|t| t.load(std::sync::atomic::Ordering::SeqCst)) {
            return Err(AdapterError::Other {
                message: "思考优化已取消".into(),
            });
        }
        let remaining = total_timeout.saturating_sub(start.elapsed());
        if remaining.is_zero() {
            return Err(AdapterError::Timeout {
                message: "思考模型流式响应超时".into(),
            });
        }
        let chunk =
            match tokio::time::timeout(remaining.min(STREAM_CHUNK_TIMEOUT), resp.chunk()).await {
                Err(_) => {
                    return Err(AdapterError::Timeout {
                        message: "思考模型流式响应超时".into(),
                    })
                }
                Ok(Err(e)) => return Err(classify_reqwest(&e)),
                Ok(Ok(None)) => break,
                Ok(Ok(Some(bytes))) => bytes,
            };
        let mut done = false;
        for item in decoder.feed(&chunk) {
            match item {
                SseItem::Delta(delta) => {
                    acc.push_str(&delta);
                    on_delta(&delta);
                }
                SseItem::Done => done = true,
                SseItem::Ignored => {}
            }
        }
        if done {
            break;
        }
    }
    let trimmed = acc.trim();
    if trimmed.is_empty() {
        return Err(AdapterError::Other {
            message: "chat/completions 流未返回文本内容".into(),
        });
    }
    Ok(trimmed.to_string())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn delta_frame(text: &str) -> String {
        format!(
            "data: {{\"choices\":[{{\"delta\":{{\"content\":\"{}\"}}}}]}}\n\n",
            text
        )
    }

    fn deltas(items: Vec<SseItem>) -> Vec<String> {
        items
            .into_iter()
            .filter_map(|item| match item {
                SseItem::Delta(text) => Some(text),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn decodes_frame_split_across_chunks() {
        let frame = delta_frame("hello");
        let bytes = frame.as_bytes();
        let mut decoder = SseDecoder::new();
        assert!(decoder.feed(&bytes[..12]).is_empty());
        assert!(decoder.feed(&bytes[12..bytes.len() - 1]).is_empty());
        assert_eq!(
            deltas(decoder.feed(&bytes[bytes.len() - 1..])),
            vec!["hello".to_string()]
        );
    }

    #[test]
    fn decodes_crlf_and_mixed_separators() {
        let mut decoder = SseDecoder::new();
        let mut items =
            decoder.feed(b"data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\r\n\r\n");
        items.extend(decoder.feed(b"data: {\"choices\":[{\"delta\":{\"content\":\"b\"}}]}\n\r\n"));
        assert_eq!(deltas(items), vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn joins_multiline_data() {
        let mut decoder = SseDecoder::new();
        let items =
            decoder.feed(b"data: {\"choices\":\ndata: [{\"delta\":{\"content\":\"hi\"}}]}\n\n");
        assert_eq!(deltas(items), vec!["hi".to_string()]);
    }

    #[test]
    fn detects_done_marker() {
        let mut decoder = SseDecoder::new();
        assert_eq!(decoder.feed(b"data: [DONE]\n\n"), vec![SseItem::Done]);
    }

    #[test]
    fn ignores_role_only_bad_and_comment_frames() {
        let mut decoder = SseDecoder::new();
        let mut items = decoder.feed(b": keep-alive\n\n\n\n");
        items.extend(
            decoder.feed(b"data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n"),
        );
        items.extend(decoder.feed(b"data: {not json\n\n"));
        items.extend(decoder.feed(b"data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n"));
        assert_eq!(
            items,
            vec![
                SseItem::Ignored,
                SseItem::Ignored,
                SseItem::Ignored,
                SseItem::Ignored,
                SseItem::Delta("ok".into()),
            ]
        );
        assert!(decoder.warned); // 坏帧只告警一次
    }

    #[test]
    fn handles_utf8_split_across_chunks() {
        let frame = delta_frame("你好");
        let bytes = frame.as_bytes();
        // 切在「好」的三个字节中间，验证半帧不解析、完整后不乱码
        let cut = frame.find('你').unwrap() + 4;
        let mut decoder = SseDecoder::new();
        assert!(decoder.feed(&bytes[..cut]).is_empty());
        assert_eq!(
            deltas(decoder.feed(&bytes[cut..])),
            vec!["你好".to_string()]
        );
    }

    #[test]
    fn emits_multiple_deltas_from_one_chunk() {
        let mut decoder = SseDecoder::new();
        let mut payload = delta_frame("a");
        payload.push_str(&delta_frame("b"));
        payload.push_str("data: [DONE]\n\n");
        assert_eq!(
            decoder.feed(payload.as_bytes()),
            vec![
                SseItem::Delta("a".into()),
                SseItem::Delta("b".into()),
                SseItem::Done,
            ]
        );
    }
}
