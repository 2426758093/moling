use crate::adapters::{self, ProviderConfig};
use crate::storage;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInput {
    pub id: Option<i64>,
    pub name: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub kind: String,
    pub models_json: String,
    pub default_model: String,
    pub timeout_secs: u64,
    pub template_url: String,
    pub template_body: String,
    pub template_response_path: String,
    pub extra_params: Option<String>,
}

/// 读取服务商的透传参数（extraParams 存于 settings KV）
fn load_extra_params(id: i64) -> String {
    storage::get_setting(&format!("extraParams:{}", id))
        .ok()
        .flatten()
        .unwrap_or_default()
}

fn row_to_draft<'a>(input: &'a ProviderInput) -> storage::ProviderDraft<'a> {
    storage::ProviderDraft {
        name: &input.name,
        base_url: &input.base_url,
        api_key: input.api_key.as_deref().filter(|k| !k.is_empty()),
        kind: &input.kind,
        models_json: &input.models_json,
        default_model: &input.default_model,
        timeout_secs: input.timeout_secs,
        template_url: &input.template_url,
        template_body: &input.template_body,
        template_response_path: &input.template_response_path,
    }
}

/// ProviderRow → ProviderConfig（供 adapter 调用）。
/// 密文非空但解密失败时返回 Err——绝不把空 Key 上送给服务商（R2）。
impl TryFrom<&storage::ProviderRow> for ProviderConfig {
    type Error = String;

    fn try_from(row: &storage::ProviderRow) -> Result<Self, Self::Error> {
        let key = storage::decrypt_secret(&row.api_key_enc).map_err(|e| -> String {
            tracing::warn!(
                "服务商「{}」的 API Key 解密失败，拒绝以空 Key 调用: {}",
                row.name,
                e
            );
            format!(
                "服务商「{}」的 API Key 解密失败，请重新填写: {}",
                row.name, e
            )
        })?;
        Ok(ProviderConfig {
            id: Some(row.id),
            name: row.name.clone(),
            base_url: row.base_url.clone(),
            api_key: key,
            kind: row.kind.clone(),
            models_json: row.models_json.clone(),
            default_model: row.default_model.clone(),
            timeout_secs: row.timeout_secs,
            template_url: row.template_url.clone(),
            template_body: row.template_body.clone(),
            template_response_path: row.template_response_path.clone(),
            extra_params: load_extra_params(row.id),
        })
    }
}

fn to_input(p: &storage::ProviderRow) -> ProviderInput {
    let extra_params = load_extra_params(p.id);
    ProviderInput {
        id: Some(p.id),
        name: p.name.clone(),
        base_url: p.base_url.clone(),
        api_key: None,
        kind: p.kind.clone(),
        models_json: p.models_json.clone(),
        default_model: p.default_model.clone(),
        timeout_secs: p.timeout_secs,
        template_url: p.template_url.clone(),
        template_body: p.template_body.clone(),
        template_response_path: p.template_response_path.clone(),
        extra_params: if extra_params.is_empty() {
            None
        } else {
            Some(extra_params)
        },
    }
}

#[tauri::command]
pub async fn save_provider(input: ProviderInput) -> Result<serde_json::Value, String> {
    let row = storage::save_provider(input.id, &row_to_draft(&input))?;
    if let Some(ep) = &input.extra_params {
        storage::set_setting(&format!("extraParams:{}", row.id), ep)?;
    }
    Ok(serde_json::json!({
        "provider": to_input(&row),
        "apiKeyMasked": row.api_key_masked,
        "hasKey": row.has_key,
        "keyError": row.key_error,
    }))
}

#[tauri::command]
pub async fn list_providers() -> Result<serde_json::Value, String> {
    let rows = storage::list_providers()?;
    let list: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            serde_json::json!({
                "provider": to_input(r),
                "apiKeyMasked": r.api_key_masked,
                "hasKey": r.has_key,
                "keyError": r.key_error,
            })
        })
        .collect();
    Ok(serde_json::json!({ "providers": list }))
}

#[tauri::command]
pub async fn delete_provider(id: i64) -> Result<(), String> {
    storage::delete_provider(id)?;
    storage::set_setting(&format!("extraParams:{}", id), "")?;
    Ok(())
}

#[tauri::command]
pub async fn pull_models(id: i64) -> Result<Vec<String>, String> {
    let row = storage::get_provider(id)?.ok_or_else(|| "服务商不存在".to_string())?;
    let config = ProviderConfig::try_from(&row)?;
    let adapter = adapters::get_adapter(&config.kind).map_err(adapters::adapter_error_json)?;
    adapter
        .list_models(&config)
        .await
        .map_err(adapters::adapter_error_json)
}

/// 向导内「拉取模型列表」：直接用表单内容在内存中构建配置发起调用，
/// 不落库——用户取消向导不会留下半成品服务商（M6）。
#[tauri::command]
pub async fn test_models(input: ProviderInput) -> Result<Vec<String>, String> {
    let config = ProviderConfig {
        id: None,
        name: input.name,
        base_url: input.base_url,
        api_key: input.api_key.unwrap_or_default(),
        kind: input.kind,
        models_json: input.models_json,
        default_model: input.default_model,
        timeout_secs: input.timeout_secs,
        template_url: input.template_url,
        template_body: input.template_body,
        template_response_path: input.template_response_path,
        extra_params: input.extra_params.unwrap_or_default(),
    };
    let adapter = adapters::get_adapter(&config.kind).map_err(adapters::adapter_error_json)?;
    adapter
        .list_models(&config)
        .await
        .map_err(adapters::adapter_error_json)
}

#[tauri::command]
pub async fn test_connection(id: i64) -> Result<serde_json::Value, String> {
    let start = std::time::Instant::now();
    let row = storage::get_provider(id)?.ok_or_else(|| "服务商不存在".to_string())?;
    let config = ProviderConfig::try_from(&row)?;
    let result = match adapters::get_adapter(&config.kind) {
        Ok(adapter) => adapter.list_models(&config).await,
        Err(e) => Err(e),
    };
    match result {
        Ok(models) => Ok(serde_json::json!({
            "ok": true,
            "latencyMs": start.elapsed().as_millis() as u64,
            "modelCount": models.len(),
        })),
        Err(e) => Ok(serde_json::json!({
            "ok": false,
            "error": e,
        })),
    }
}

#[tauri::command]
pub async fn export_config() -> Result<serde_json::Value, String> {
    let rows = storage::list_providers()?;
    let providers: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            let key = match storage::decrypt_secret(&r.api_key_enc) {
                Ok(k) => k,
                Err(e) => {
                    tracing::warn!(
                        "导出：服务商「{}」的 API Key 解密失败，导出为空串: {}",
                        r.name,
                        e
                    );
                    String::new()
                }
            };
            serde_json::json!({
                "name": r.name,
                "baseUrl": r.base_url,
                "apiKey": key,
                "kind": r.kind,
                "modelsJson": r.models_json,
                "defaultModel": r.default_model,
                "timeoutSecs": r.timeout_secs,
                "templateUrl": r.template_url,
                "templateBody": r.template_body,
                "templateResponsePath": r.template_response_path,
                "extraParams": load_extra_params(r.id),
            })
        })
        .collect();
    let settings = ["defaultProviderId", "defaultParams"]
        .iter()
        .filter_map(|k| {
            storage::get_setting(k)
                .ok()
                .flatten()
                .map(|v| (k.to_string(), serde_json::Value::String(v)))
        })
        .collect::<serde_json::Map<String, serde_json::Value>>();
    Ok(serde_json::json!({
        "version": 1,
        "providers": providers,
        "settings": serde_json::Value::Object(settings),
    }))
}

/// 导入配置（替换语义）：version 必须为 1；整体在一个事务内完成，
/// 先删除旧服务商再写入，中途失败回滚不留半导入状态（R5）。
/// 同时恢复每个服务商的 extraParams 透传参数（M7）。
#[tauri::command]
pub async fn import_config(data: serde_json::Value) -> Result<(), String> {
    if data.get("version").and_then(|v| v.as_u64()) != Some(1) {
        return Err("配置版本不受支持，仅支持 version=1".to_string());
    }
    let count = storage::import_config(&data).map_err(|e| -> String {
        tracing::warn!("配置导入失败，已整体回滚: {e}");
        e.into()
    })?;
    tracing::warn!("配置导入完成（替换语义）：{count} 个服务商");
    Ok(())
}
