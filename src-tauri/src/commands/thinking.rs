use crate::adapters::{self, ProviderConfig};
use crate::storage;
use tauri::Emitter;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThinkingConfig {
    pub enabled: bool,
    pub mode: String, // "standalone" | "reuse"
    pub provider_id: Option<i64>,
    pub base_url: String,
    pub model: String,
    pub api_key_masked: Option<String>,
    /// 密文非空但解密失败（密钥损坏/主密钥变化），前端据此提示重新填写
    #[serde(default)]
    pub key_error: bool,
    /// 首条消息后自动生成会话标题（复用同一文本模型）
    #[serde(default = "default_true")]
    pub title_enabled: bool,
    /// 输入框提示词优化助手
    #[serde(default = "default_true")]
    pub optimize_enabled: bool,
}

fn default_true() -> bool {
    true
}

const THINKING_CONFIG_KEY: &str = "thinkingConfig";

fn read_thinking_config() -> Result<(ThinkingConfig, String), String> {
    let raw = storage::get_setting(THINKING_CONFIG_KEY)?
        .unwrap_or_else(|| {
            r#"{"enabled":false,"mode":"reuse","providerId":null,"baseUrl":"","model":"","apiKeyEnc":""}"#
                .to_string()
        });
    let value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("思考模型配置损坏: {}", e))?;
    let api_key_enc = value["apiKeyEnc"].as_str().unwrap_or_default().to_string();
    // 空密文 = 未设置 Key（正常）；非空但解密失败 = 密钥损坏，标记 key_error（R2）
    let (key, key_error) = match storage::decrypt_secret(&api_key_enc) {
        Ok(k) => (k, false),
        Err(e) => {
            tracing::warn!("思考模型 API Key 解密失败，标记 key_error: {}", e);
            (String::new(), true)
        }
    };
    let masked = if key.is_empty() {
        None
    } else {
        Some(storage::mask_key(&key))
    };
    Ok((
        ThinkingConfig {
            enabled: value["enabled"].as_bool().unwrap_or(false),
            mode: value["mode"].as_str().unwrap_or("reuse").to_string(),
            provider_id: value["providerId"].as_i64(),
            base_url: value["baseUrl"].as_str().unwrap_or_default().to_string(),
            model: value["model"].as_str().unwrap_or_default().to_string(),
            api_key_masked: masked,
            key_error,
            title_enabled: value["titleEnabled"].as_bool().unwrap_or(true),
            optimize_enabled: value["optimizeEnabled"].as_bool().unwrap_or(true),
        },
        api_key_enc,
    ))
}

#[tauri::command]
pub async fn get_thinking_config() -> Result<ThinkingConfig, String> {
    Ok(read_thinking_config()?.0)
}

/// 备份导出用视图：只包含非密钥字段。API Key（明文或密文）绝不写入备份文件；
/// 配置损坏时降级为默认值并记日志，不阻断整个备份。
pub(crate) fn backup_value() -> serde_json::Value {
    match read_thinking_config() {
        Ok((cfg, _)) => serde_json::json!({
            "enabled": cfg.enabled,
            "mode": cfg.mode,
            "providerId": cfg.provider_id,
            "baseUrl": cfg.base_url,
            "model": cfg.model,
            "titleEnabled": cfg.title_enabled,
            "optimizeEnabled": cfg.optimize_enabled,
        }),
        Err(e) => {
            tracing::warn!("导出：思考模型配置读取失败，按未配置导出: {}", e);
            serde_json::json!({
                "enabled": false,
                "mode": "reuse",
                "providerId": null,
                "baseUrl": "",
                "model": "",
                "titleEnabled": true,
                "optimizeEnabled": true,
            })
        }
    }
}

#[tauri::command]
pub async fn save_thinking_config(
    mut config: ThinkingConfig,
    api_key: Option<String>,
) -> Result<ThinkingConfig, String> {
    let (_, old_enc) = read_thinking_config()?;
    let api_key_enc = match api_key {
        Some(k) if !k.is_empty() => storage::encrypt_secret(&k)?,
        _ => old_enc,
    };
    let value = serde_json::json!({
        "enabled": config.enabled,
        "mode": config.mode,
        "providerId": config.provider_id,
        "baseUrl": config.base_url,
        "apiKeyEnc": api_key_enc,
        "model": config.model,
        "titleEnabled": config.title_enabled,
        "optimizeEnabled": config.optimize_enabled,
    });
    storage::set_setting(THINKING_CONFIG_KEY, &value.to_string())?;
    // 脱敏后返回
    let (key, key_error) = match storage::decrypt_secret(&api_key_enc) {
        Ok(k) => (k, false),
        Err(e) => {
            tracing::warn!("思考模型 API Key 解密失败，标记 key_error: {}", e);
            (String::new(), true)
        }
    };
    config.api_key_masked = if key.is_empty() {
        None
    } else {
        Some(storage::mask_key(&key))
    };
    config.key_error = key_error;
    Ok(config)
}

/// 解析思考模型的实际调用配置；未启用或配置不完整返回 None
fn resolve_thinking_provider() -> Result<Option<(ProviderConfig, String)>, String> {
    let (cfg, enc) = read_thinking_config()?;
    if !cfg.enabled || cfg.model.trim().is_empty() {
        return Ok(None);
    }
    if cfg.mode == "standalone" {
        if cfg.base_url.trim().is_empty() {
            return Ok(None);
        }
        // 解密失败直接报错，避免空 Key 上送服务商（R2）
        let key = storage::decrypt_secret(&enc).map_err(|e| -> String {
            tracing::warn!("思考模型（独立模式）API Key 解密失败: {}", e);
            format!("思考模型 API Key 解密失败，请在设置中重新填写: {}", e)
        })?;
        Ok(Some((
            ProviderConfig {
                id: None,
                name: "thinking".into(),
                base_url: cfg.base_url.clone(),
                api_key: key,
                kind: adapters::KIND_OPENAI.into(),
                models_json: String::new(),
                default_model: cfg.model.clone(),
                timeout_secs: 60,
                template_url: String::new(),
                template_body: String::new(),
                template_response_path: String::new(),
                edit_template: None,
                transform_template: None,
                extra_params: String::new(),
            },
            cfg.model,
        )))
    } else {
        let pid = match cfg.provider_id {
            Some(p) => p,
            None => return Ok(None),
        };
        match storage::get_provider(pid)? {
            Some(r) => Ok(Some((ProviderConfig::try_from(&r)?, cfg.model))),
            None => Ok(None),
        }
    }
}

#[tauri::command]
pub async fn test_thinking_connection() -> Result<serde_json::Value, String> {
    match resolve_thinking_provider()? {
        Some((config, model)) => {
            let start = std::time::Instant::now();
            let result = if config.kind == adapters::KIND_MOCK {
                Ok("mock".to_string())
            } else {
                adapters::chat::chat_complete(
                    &config,
                    &model,
                    "You are a helpful assistant.",
                    "ping, reply with one word",
                )
                .await
            };
            match result {
                Ok(_) => Ok(serde_json::json!({
                    "ok": true,
                    "latencyMs": start.elapsed().as_millis() as u64,
                })),
                Err(e) => Ok(serde_json::json!({
                    "ok": false,
                    "error": e,
                })),
            }
        }
        None => Ok(serde_json::json!({
            "ok": false,
            "error": { "type": "other", "message": "思考模型未启用或配置不完整" },
        })),
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefineInput {
    pub raw: String,
    pub context: Option<String>,
    /// 前端生成的思考请求 id：用于流式增量过滤与取消；不传时退回非流式行为
    #[serde(default)]
    pub request_id: Option<String>,
    /// 前端当前会话 id：随增量事件回传，便于前端做二次过滤
    #[serde(default)]
    pub conversation_id: Option<i64>,
}

/// 流式增量事件（前端按 requestId + 当前会话双重过滤）
fn emit_thinking_delta(
    app: &tauri::AppHandle,
    request_id: &str,
    conversation_id: Option<i64>,
    delta: &str,
) {
    let _ = app.emit(
        "thinking:delta",
        serde_json::json!({
            "requestId": request_id,
            "conversationId": conversation_id,
            "delta": delta,
        }),
    );
}

/// mock 分段流式：无网也能验收逐字效果与停止行为
const MOCK_REFINE_SEGMENTS: usize = 5;
const MOCK_REFINE_INTERVAL_MS: u64 = 120;

fn mock_refine_chunks(raw: &str) -> String {
    format!(
        "(mock 思考优化) {}，masterpiece, highly detailed, professional lighting",
        raw
    )
}

/// 思考结果统一降级：成功但文本为空白（模型只返回空格/换行）也按失败处理，
/// 避免前端把空串写进 assistant 正文。
fn refine_result_json(
    raw: &str,
    result: Result<String, adapters::AdapterError>,
) -> serde_json::Value {
    match result {
        Ok(text) if !text.trim().is_empty() => serde_json::json!({
            "refined": text,
            "used": true,
        }),
        Ok(_) => serde_json::json!({
            "refined": raw,
            "used": false,
            "error": adapters::AdapterError::Other {
                message: "思考模型返回空内容".into(),
            },
        }),
        Err(e) => serde_json::json!({
            "refined": raw,
            "used": false,
            "error": e,
        }),
    }
}

#[tauri::command]
pub async fn refine_prompt(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::commands::GenerationRegistry>,
    input: RefineInput,
) -> Result<serde_json::Value, String> {
    let resolved = resolve_thinking_provider()?;
    let Some((config, model)) = resolved else {
        return Ok(serde_json::json!({
            "refined": input.raw,
            "used": false,
        }));
    };
    let user = adapters::chat::build_refine_user_input(&input.raw, input.context.as_deref());
    // 取消 token 复用生成注册表，键加 `refine:` 前缀与生成任务隔离
    let cancel_key = input.request_id.as_ref().map(|id| format!("refine:{id}"));
    let (_registration, cancel_token) =
        crate::commands::CancelRegistration::new(&state, cancel_key.as_ref());
    let stream_id = input.request_id.as_deref();
    let conv_id = input.conversation_id;

    let result = if config.kind == adapters::KIND_MOCK {
        let full = mock_refine_chunks(&input.raw);
        let chars: Vec<char> = full.chars().collect();
        let step = chars.len().div_ceil(MOCK_REFINE_SEGMENTS).max(1);
        for piece in chars.chunks(step) {
            if cancel_token
                .as_ref()
                .is_some_and(|t| t.load(std::sync::atomic::Ordering::SeqCst))
            {
                return Err("思考优化已取消".into());
            }
            if let Some(id) = stream_id {
                emit_thinking_delta(&app, id, conv_id, &piece.iter().collect::<String>());
            }
            tokio::time::sleep(std::time::Duration::from_millis(MOCK_REFINE_INTERVAL_MS)).await;
        }
        Ok(full)
    } else {
        adapters::chat::chat_stream(
            &config,
            &model,
            adapters::chat::REFINE_SYSTEM_PROMPT,
            &user,
            cancel_token.as_ref(),
            |delta| {
                if let Some(id) = stream_id {
                    emit_thinking_delta(&app, id, conv_id, delta);
                }
            },
        )
        .await
    };
    Ok(refine_result_json(&input.raw, result))
}

/// 取消在途思考优化：置位注册表里的 token（幂等，未注册返回 false）
#[tauri::command]
pub fn cancel_refine(
    request_id: String,
    state: tauri::State<'_, crate::commands::GenerationRegistry>,
) -> bool {
    state.cancel(&format!("refine:{request_id}"))
}

/// 文本含 CJK 汉字即视为中文（用于选择翻译方向）
fn contains_cjk(text: &str) -> bool {
    text.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))
}

/// 中→英 或 英→中；纯数字/符号按英译中处理
fn translation_direction(text: &str) -> &'static str {
    if contains_cjk(text) {
        "zh2en"
    } else {
        "en2zh"
    }
}

#[tauri::command]
pub async fn translate_prompt(text: String) -> Result<serde_json::Value, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(serde_json::json!({
            "ok": false,
            "error": { "type": "other", "message": "请先输入要翻译的提示词" },
        }));
    }
    let direction = translation_direction(trimmed);
    let resolved = resolve_thinking_provider()?;
    let Some((config, model)) = resolved else {
        return Ok(serde_json::json!({
            "ok": false,
            "direction": direction,
            "error": { "type": "other", "message": "请先在「设置 → 思考模型」中启用并配置模型" },
        }));
    };
    let result = if config.kind == adapters::KIND_MOCK {
        Ok(if direction == "zh2en" {
            "(mock 翻译) a serene lake under moonlight, mist drifting over still water, cinematic lighting, ultra detailed"
                .to_string()
        } else {
            "(mock 翻译) 月光下宁静的湖面，薄雾漂过平静的水面，电影级光影，极其精细".to_string()
        })
    } else {
        adapters::chat::translate_prompt(&config, &model, trimmed, direction == "zh2en").await
    };
    match result {
        Ok(translated) => Ok(serde_json::json!({
            "ok": true,
            "translated": translated,
            "direction": direction,
        })),
        Err(e) => Ok(serde_json::json!({
            "ok": false,
            "direction": direction,
            "error": e,
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translation_direction_detects_script() {
        assert_eq!(translation_direction("一只橘猫在窗台上打盹"), "zh2en");
        assert_eq!(
            translation_direction("a cat napping on a windowsill"),
            "en2zh"
        );
        assert_eq!(translation_direction("cat 橘猫, soft light"), "zh2en");
        assert_eq!(translation_direction(""), "en2zh");
        assert_eq!(translation_direction("12345, ---"), "en2zh");
    }

    #[test]
    fn contains_cjk_boundaries() {
        assert!(contains_cjk("墨"));
        assert!(!contains_cjk("MoLing 0.8.0"));
        // 假名与全角标点不算汉字，避免把日文误判为中文输入
        assert!(!contains_cjk("こんにちは、"));
    }

    /// F-005：思考返回空白文本时不得 used:true（否则前端会用空串覆盖正文）
    #[test]
    fn empty_refine_result_degrades_to_raw() {
        let raw = "一只橘猫在窗台上打盹";
        for blank in ["", "   ", "\n\t "] {
            let value = refine_result_json(raw, Ok(blank.to_string()));
            assert_eq!(value["refined"], raw);
            assert_eq!(value["used"], false);
            assert_eq!(value["error"]["type"], "other");
        }

        let ok = refine_result_json(raw, Ok("refined prompt".to_string()));
        assert_eq!(ok["used"], true);
        assert_eq!(ok["refined"], "refined prompt");

        let failed = refine_result_json(
            raw,
            Err(adapters::AdapterError::Other {
                message: "boom".into(),
            }),
        );
        assert_eq!(failed["used"], false);
        assert_eq!(failed["refined"], raw);
        assert_eq!(failed["error"]["message"], "boom");
    }
}

#[tauri::command]
pub async fn reverse_prompt(image_b64: String) -> Result<serde_json::Value, String> {
    let resolved = resolve_thinking_provider()?;
    let Some((config, model)) = resolved else {
        return Ok(serde_json::json!({
            "ok": false,
            "error": { "type": "other", "message": "请先在「设置 → 思考模型」中启用并配置模型（反推需要具备视觉能力的模型）" },
        }));
    };
    let data_url = if image_b64.starts_with("data:") {
        image_b64
    } else {
        format!("data:image/png;base64,{}", image_b64)
    };
    let result = if config.kind == adapters::KIND_MOCK {
        Ok("(mock 反推) a serene mountain lake at dawn, mist rolling over still water, pine trees on the shore, soft pink and gold sky, ultra detailed landscape photography".to_string())
    } else {
        adapters::chat::reverse_prompt(&config, &model, &data_url).await
    };
    match result {
        Ok(text) => Ok(serde_json::json!({ "ok": true, "prompt": text })),
        Err(e) => Ok(serde_json::json!({
            "ok": false,
            "error": e,
        })),
    }
}

/// 首条消息后异步生成会话标题。未启用 / 未配置时静默跳过，
/// 不弹错——标题只是锦上添花，不能打断出图主流程。
#[tauri::command]
pub async fn generate_conversation_title(
    conversation_id: i64,
    prompt: String,
) -> Result<serde_json::Value, String> {
    let first = prompt.trim();
    if first.is_empty() {
        return Ok(serde_json::json!({ "ok": false, "skipped": true }));
    }
    let (cfg, _) = read_thinking_config()?;
    if !cfg.enabled || !cfg.title_enabled {
        return Ok(serde_json::json!({ "ok": false, "skipped": true }));
    }
    let Some((config, model)) = resolve_thinking_provider()? else {
        return Ok(serde_json::json!({ "ok": false, "skipped": true }));
    };
    let result = if config.kind == adapters::KIND_MOCK {
        Ok(first.chars().take(12).collect::<String>())
    } else {
        adapters::chat::generate_title(&config, &model, first).await
    };
    match result {
        Ok(title) if !title.is_empty() => {
            let updated = storage::update_conversation_title(conversation_id, &title)?;
            Ok(serde_json::json!({ "ok": true, "title": title, "updated": updated }))
        }
        Ok(_) => Ok(serde_json::json!({ "ok": false, "skipped": true })),
        Err(e) => {
            tracing::warn!("生成会话标题失败: {}", e);
            Ok(serde_json::json!({ "ok": false, "error": e }))
        }
    }
}

/// 提示词优化：把当前草稿改写成更易被模型理解的提示词。
#[tauri::command]
pub async fn optimize_prompt(text: String) -> Result<serde_json::Value, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(serde_json::json!({
            "ok": false,
            "error": { "type": "other", "message": "请先输入要优化的提示词" },
        }));
    }
    let (cfg, _) = read_thinking_config()?;
    if !cfg.enabled || !cfg.optimize_enabled {
        return Ok(serde_json::json!({
            "ok": false,
            "error": { "type": "other", "message": "提示词优化助手未启用，请在「设置 → 生成 → AI 助手」中开启" },
        }));
    }
    let Some((config, model)) = resolve_thinking_provider()? else {
        return Ok(serde_json::json!({
            "ok": false,
            "error": { "type": "other", "message": "请先在「设置 → 生成 → AI 助手」中启用并配置模型" },
        }));
    };
    let result = if config.kind == adapters::KIND_MOCK {
        Ok(format!(
            "(mock 优化) {}，柔和光线，精细构图，高质量细节",
            trimmed
        ))
    } else {
        adapters::chat::optimize_prompt(&config, &model, trimmed).await
    };
    match result {
        Ok(optimized) if !optimized.trim().is_empty() => Ok(serde_json::json!({
            "ok": true,
            "optimized": optimized.trim(),
        })),
        Ok(_) => Ok(serde_json::json!({
            "ok": false,
            "error": { "type": "other", "message": "模型返回空内容，请重试" },
        })),
        Err(e) => Ok(serde_json::json!({
            "ok": false,
            "error": e,
        })),
    }
}
