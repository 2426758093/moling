use crate::adapters::{self, ProviderConfig};
use crate::key_pool;
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

/// 前端只拿到掩码与状态，明文 Key 永不出后端。
fn key_views(keys: &[storage::ProviderKey]) -> Vec<serde_json::Value> {
    keys.iter()
        .enumerate()
        .map(|(index, k)| {
            serde_json::json!({
                "index": index,
                "masked": storage::mask_key(&k.key),
                "invalid": k.invalid,
                "invalidAt": k.invalid_at,
            })
        })
        .collect()
}

/// 读取失败只降级为「无 Key 信息」，列表本身照常展示。
fn key_summary(id: i64) -> (usize, usize, Vec<serde_json::Value>) {
    match storage::load_provider_keys(id) {
        Ok(keys) => (
            keys.len(),
            keys.iter().filter(|k| k.invalid).count(),
            key_views(&keys),
        ),
        Err(e) => {
            tracing::warn!("服务商 id={id} 的 Key 列表读取失败: {e}");
            (0, 0, Vec::new())
        }
    }
}

fn provider_item(row: &storage::ProviderRow) -> serde_json::Value {
    let (key_count, invalid_key_count, keys) = key_summary(row.id);
    serde_json::json!({
        "provider": to_input(row),
        "apiKeyMasked": row.api_key_masked,
        "hasKey": row.has_key,
        "keyError": row.key_error,
        "keyCount": key_count,
        "invalidKeyCount": invalid_key_count,
        "keys": keys,
    })
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
    Ok(provider_item(&row))
}

#[tauri::command]
pub async fn list_providers() -> Result<serde_json::Value, String> {
    let rows = storage::list_providers()?;
    let list: Vec<serde_json::Value> = rows.iter().map(provider_item).collect();
    Ok(serde_json::json!({ "providers": list }))
}

#[tauri::command]
pub async fn list_provider_keys(id: i64) -> Result<serde_json::Value, String> {
    let keys = storage::load_provider_keys(id)?;
    Ok(serde_json::json!({ "keys": key_views(&keys) }))
}

#[tauri::command]
pub async fn add_provider_key(id: i64, key: String) -> Result<serde_json::Value, String> {
    storage::add_provider_key(id, &key)?;
    let keys = storage::load_provider_keys(id)?;
    Ok(serde_json::json!({ "keys": key_views(&keys) }))
}

#[tauri::command]
pub async fn delete_provider_key(id: i64, index: usize) -> Result<serde_json::Value, String> {
    storage::delete_provider_key(id, index)?;
    let keys = storage::load_provider_keys(id)?;
    Ok(serde_json::json!({ "keys": key_views(&keys) }))
}

/// 清除失效标记，让 Key 重新参与轮换（例如额度已恢复、临时封禁结束）。
#[tauri::command]
pub async fn reset_provider_key(id: i64, index: usize) -> Result<serde_json::Value, String> {
    storage::mark_key_invalid(id, index, false)?;
    let keys = storage::load_provider_keys(id)?;
    Ok(serde_json::json!({ "keys": key_views(&keys) }))
}

#[tauri::command]
pub async fn delete_provider(id: i64) -> Result<(), String> {
    storage::delete_provider(id)?;
    // 保留原有行为：清理该服务商的透传参数
    storage::set_setting(&format!("extraParams:{}", id), "")?;
    // RC-03：默认服务商若指向被删服务商，默认设置会悬空；一并清除，前端回落到未选择状态
    let default_id = storage::get_setting("defaultProviderId")?.unwrap_or_default();
    if default_id.trim().parse::<i64>().ok() == Some(id) {
        storage::delete_setting("defaultProviderId")?;
        tracing::warn!("默认服务商（id={id}）已被删除，已清除 defaultProviderId 设置");
    }
    Ok(())
}

#[tauri::command]
pub async fn pull_models(id: i64) -> Result<Vec<String>, String> {
    let candidates = key_pool::candidates(id)?;
    if candidates.is_empty() {
        return Err("该服务商还没有配置 API Key".to_string());
    }
    let mut last_err: Option<adapters::AdapterError> = None;
    for candidate in &candidates {
        let adapter =
            adapters::get_adapter(&candidate.config.kind).map_err(adapters::adapter_error_json)?;
        match adapter.list_models(&candidate.config).await {
            Ok(models) => {
                key_pool::note_success(id, candidate.index);
                return Ok(models);
            }
            Err(e) if key_pool::is_auth(&e) => {
                key_pool::note_auth_failure(id, candidate.index, &e);
                last_err = Some(e);
            }
            Err(e) => return Err(adapters::adapter_error_json(e)),
        }
    }
    Err(adapters::adapter_error_json(
        last_err.expect("候选列表非空时必有结果或错误"),
    ))
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
    let candidates = key_pool::candidates(id)?;
    if candidates.is_empty() {
        return Ok(serde_json::json!({
            "ok": false,
            "error": adapters::adapter_error_json(adapters::AdapterError::AuthInvalid {
                message: "该服务商还没有配置 API Key".to_string(),
                status: 0,
            }),
        }));
    }
    let mut last_err: Option<adapters::AdapterError> = None;
    for candidate in &candidates {
        let result = match adapters::get_adapter(&candidate.config.kind) {
            Ok(adapter) => adapter.list_models(&candidate.config).await,
            Err(e) => Err(e),
        };
        match result {
            Ok(models) => {
                key_pool::note_success(id, candidate.index);
                return Ok(serde_json::json!({
                    "ok": true,
                    "latencyMs": start.elapsed().as_millis() as u64,
                    "modelCount": models.len(),
                }));
            }
            Err(e) if key_pool::is_auth(&e) => {
                key_pool::note_auth_failure(id, candidate.index, &e);
                last_err = Some(e);
            }
            Err(e) => {
                return Ok(serde_json::json!({
                    "ok": false,
                    "error": e,
                }))
            }
        }
    }
    Ok(serde_json::json!({
        "ok": false,
        "error": last_err.expect("候选列表非空时必有结果或错误"),
    }))
}

/// 导出配置（备份 v3）：`include_keys` 默认 false，不把明文 API Key 写进文件；
/// 服务商仍带 id，供导入时把 defaultProviderId / 思考模型 providerId 重映射到新自增 id。
#[tauri::command]
pub async fn export_config(include_keys: Option<bool>) -> Result<serde_json::Value, String> {
    let include_keys = include_keys.unwrap_or(false);
    let rows = storage::list_providers()?;
    let providers: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            let keys = match storage::load_provider_keys(r.id) {
                Ok(keys) => keys,
                Err(e) => {
                    tracing::warn!(
                        "导出：服务商「{}」的 Key 列表读取失败，按无 Key 导出: {}",
                        r.name,
                        e
                    );
                    Vec::new()
                }
            };
            let (api_keys, invalid_indexes) = if include_keys {
                let plain: Vec<String> = keys.iter().map(|k| k.key.clone()).collect();
                let invalid: Vec<usize> = keys
                    .iter()
                    .enumerate()
                    .filter(|(_, k)| k.invalid)
                    .map(|(i, _)| i)
                    .collect();
                (plain, invalid)
            } else {
                (Vec::new(), Vec::new())
            };
            serde_json::json!({
                "id": r.id,
                "name": r.name,
                "baseUrl": r.base_url,
                "hasKeys": keys.len(),
                "apiKeys": api_keys,
                "invalidKeyIndexes": invalid_indexes,
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
    let settings = [
        "defaultProviderId",
        "defaultParams",
        "theme",
        "promptTemplates",
    ]
    .iter()
    .filter_map(|k| {
        storage::get_setting(k)
            .ok()
            .flatten()
            .map(|v| (k.to_string(), serde_json::Value::String(v)))
    })
    .collect::<serde_json::Map<String, serde_json::Value>>();
    Ok(serde_json::json!({
        "version": 3,
        "exportedAt": storage::timestamp_millis(),
        "providers": providers,
        "settings": serde_json::Value::Object(settings),
        // 代理只导出非密钥字段：密码永远不出本机
        "network": network_backup_value(),
        // 思考模型只导出非密钥字段，绝不导出 API Key（明文或密文）
        "thinking": super::thinking::backup_value(),
    }))
}

/// 代理设置的非密钥快照（mode/url/noProxy），供备份导出。
fn network_backup_value() -> serde_json::Value {
    let cfg = adapters::http::stored_config();
    serde_json::json!({
        "mode": cfg.mode,
        "url": cfg.url,
        "noProxy": cfg.no_proxy,
    })
}

/// 导入配置（替换语义）：version 1 / 2 / 3 都接受；整体在一个事务内完成，
/// 先删除旧服务商再写入，中途失败回滚不留半导入状态（R5）。
/// v2 起额外恢复设置、主题、自定义模板与思考模型配置；v3 增加整组 Key 与代理非密钥字段。
/// 不含 Key 时按 name+baseUrl 复用本机旧密文（见 storage::import_config_in）。
#[tauri::command]
pub async fn import_config(data: serde_json::Value) -> Result<(), String> {
    match data.get("version").and_then(|v| v.as_u64()) {
        Some(1) | Some(2) | Some(3) => {}
        _ => return Err("配置版本不受支持，仅支持 version=1 / 2 / 3".to_string()),
    }
    let count = storage::import_config(&data).map_err(|e| -> String {
        tracing::warn!("配置导入失败，已整体回滚: {e}");
        e.into()
    })?;
    // 导入可能改了代理设置：按新配置重建客户端（失败时保留旧客户端并落日志）
    adapters::http::init_from_storage();
    tracing::warn!("配置导入完成（替换语义）：{count} 个服务商");
    Ok(())
}
