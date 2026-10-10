use crate::adapters::{self, ProviderConfig};
use crate::storage;

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
        },
        api_key_enc,
    ))
}

#[tauri::command]
pub async fn get_thinking_config() -> Result<ThinkingConfig, String> {
    Ok(read_thinking_config()?.0)
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
}

#[tauri::command]
pub async fn refine_prompt(input: RefineInput) -> Result<serde_json::Value, String> {
    let resolved = resolve_thinking_provider()?;
    let Some((config, model)) = resolved else {
        return Ok(serde_json::json!({
            "refined": input.raw,
            "used": false,
        }));
    };
    let user = adapters::chat::build_refine_user_input(&input.raw, input.context.as_deref());
    let result = if config.kind == adapters::KIND_MOCK {
        Ok(format!(
            "(mock 思考优化) {}，masterpiece, highly detailed, professional lighting",
            input.raw
        ))
    } else {
        adapters::chat::chat_complete(&config, &model, adapters::chat::REFINE_SYSTEM_PROMPT, &user)
            .await
    };
    match result {
        Ok(text) => Ok(serde_json::json!({
            "refined": text,
            "used": true,
        })),
        Err(e) => {
            // 思考失败降级为原文
            Ok(serde_json::json!({
                "refined": input.raw,
                "used": false,
                "error": e,
            }))
        }
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
