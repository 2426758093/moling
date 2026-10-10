use crate::adapters::{self, AdapterError, EditRequest, GenerateRequest, ProviderConfig};
use crate::image_store::{self, SAFE_NAME_MAX_CHARS};
use crate::storage;

/// 生成失败自动重试的最大尝试次数（AuthInvalid / ContentBlocked 不重试）
const GENERATE_MAX_ATTEMPTS: u32 = 2;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateCommandInput {
    pub provider_id: i64,
    pub prompt: String,
    pub negative_prompt: Option<String>,
    pub model: String,
    pub width: u32,
    pub height: u32,
    pub guidance: Option<f32>,
    pub steps: Option<u32>,
    pub seed: Option<u64>,
    pub style: String,
    pub count: u32,
    pub images: Option<Vec<String>>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedImage {
    pub history_id: i64,
    pub data_url: String,
    pub file_path: String,
    pub prompt: String,
    pub model: String,
    pub seed: Option<i64>,
}

fn build_prompt(input: &GenerateCommandInput) -> String {
    if input.style.is_empty() {
        input.prompt.clone()
    } else {
        format!("{}, {}", input.prompt, input.style)
    }
}

#[tauri::command]
pub async fn generate_images(
    app: tauri::AppHandle,
    input: GenerateCommandInput,
) -> Result<serde_json::Value, String> {
    let row =
        storage::get_provider(input.provider_id)?.ok_or_else(|| "服务商不存在".to_string())?;
    let config = ProviderConfig::try_from(&row)?;
    let adapter = adapters::get_adapter(&config.kind).map_err(adapters::adapter_error_json)?;

    let full_prompt = build_prompt(&input);
    let req = GenerateRequest {
        prompt: full_prompt.clone(),
        negative_prompt: input.negative_prompt.clone(),
        model: input.model.clone(),
        width: input.width,
        height: input.height,
        guidance: input.guidance,
        steps: input.steps,
        seed: input.seed,
        count: input.count,
        images: input
            .images
            .clone()
            .unwrap_or_default()
            .iter()
            .map(|s| image_store::strip_data_url(s))
            .collect(),
    };

    // 失败自动重试（AuthInvalid / ContentBlocked 不重试）
    let mut last_err: Option<AdapterError> = None;
    let mut images: Option<Vec<String>> = None;
    for attempt in 0..GENERATE_MAX_ATTEMPTS {
        match adapter.generate(&config, &req).await {
            Ok(imgs) => {
                images = Some(imgs);
                break;
            }
            Err(e) => {
                let retryable = !matches!(
                    e,
                    AdapterError::AuthInvalid { .. } | AdapterError::ContentBlocked { .. }
                );
                if attempt + 1 < GENERATE_MAX_ATTEMPTS && retryable {
                    tracing::warn!(
                        "generate_images 第 {} 次尝试失败，准备重试: {}",
                        attempt + 1,
                        e.message()
                    );
                    last_err = Some(e);
                    continue;
                }
                return Err(adapters::adapter_error_json(e));
            }
        }
    }
    let images =
        images.ok_or_else(|| adapters::adapter_error_json(last_err.expect("重试耗尽必有错误")))?;

    let now = storage::timestamp_millis();
    let mut out = Vec::new();
    for (i, b64) in images.iter().enumerate() {
        let name = format!(
            "{}_{}",
            now.replace(|c: char| !c.is_ascii_alphanumeric(), ""),
            i
        );
        let (path, data_url) = image_store::save_b64_image(&app, b64, &name)?;
        let seed_val = Some(input.seed.map(|s| s as i64).unwrap_or_else(rand::random));
        let id = storage::add_history(&storage::HistoryRow {
            id: 0,
            prompt: full_prompt.clone(),
            negative_prompt: input.negative_prompt.clone().unwrap_or_default(),
            model: input.model.clone(),
            provider_name: row.name.clone(),
            seed: seed_val,
            width: input.width as i64,
            height: input.height as i64,
            guidance: input.guidance.unwrap_or(0.0) as f64,
            steps: input.steps.unwrap_or(0) as i64,
            style: input.style.clone(),
            file_path: path.clone(),
            favorite: false,
            created_at: now.clone(),
        })?;
        out.push(GeneratedImage {
            history_id: id,
            data_url,
            file_path: path,
            prompt: full_prompt.clone(),
            model: input.model.clone(),
            seed: seed_val,
        });
    }
    Ok(serde_json::json!({ "images": out }))
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditCommandInput {
    pub provider_id: i64,
    pub prompt: String,
    pub model: String,
    pub image_b64: String,
    pub mask_b64: Option<String>,
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
pub async fn edit_image(
    app: tauri::AppHandle,
    mut input: EditCommandInput,
) -> Result<serde_json::Value, String> {
    // 消除模式：空提示词替换为默认补全提示词
    let erase = input.prompt.trim().is_empty();
    if erase {
        input.prompt = "Remove the masked object completely and fill the area so it matches \
             the surrounding background naturally."
            .to_string();
    }
    let row =
        storage::get_provider(input.provider_id)?.ok_or_else(|| "服务商不存在".to_string())?;
    let config = ProviderConfig::try_from(&row)?;
    let adapter_prompt = if erase && config.kind == adapters::KIND_MOCK {
        format!("[消除] {}", input.prompt)
    } else {
        input.prompt.clone()
    };
    let req = EditRequest {
        prompt: adapter_prompt,
        model: input.model.clone(),
        image_b64: image_store::strip_data_url(&input.image_b64),
        mask_b64: input.mask_b64.as_deref().map(image_store::strip_data_url),
        width: input.width,
        height: input.height,
    };
    let adapter = adapters::get_adapter(&config.kind).map_err(adapters::adapter_error_json)?;
    let b64 = adapter
        .edit(&config, &req)
        .await
        .map_err(adapters::adapter_error_json)?;
    let now = storage::timestamp_millis();
    let name = format!(
        "edit_{}",
        now.replace(|c: char| !c.is_ascii_alphanumeric(), "")
    );
    let (path, data_url) = image_store::save_b64_image(&app, &b64, &name)?;
    let id = storage::add_history(&storage::HistoryRow {
        id: 0,
        prompt: input.prompt.clone(),
        negative_prompt: String::new(),
        model: input.model.clone(),
        provider_name: row.name.clone(),
        seed: None,
        width: input.width as i64,
        height: input.height as i64,
        guidance: 0.0,
        steps: 0,
        style: String::new(),
        file_path: path.clone(),
        favorite: false,
        created_at: now,
    })?;
    Ok(serde_json::json!({
        "historyId": id,
        "dataUrl": data_url,
        "filePath": path,
    }))
}

#[tauri::command]
pub async fn save_chat_image(
    app: tauri::AppHandle,
    data_url: String,
    name: Option<String>,
) -> Result<serde_json::Value, String> {
    let now = storage::timestamp_millis();
    let safe_name: String = name
        .unwrap_or_else(|| format!("att_{}", now))
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(SAFE_NAME_MAX_CHARS)
        .collect();
    let (path, _) =
        image_store::save_b64_image(&app, &image_store::strip_data_url(&data_url), &safe_name)?;
    Ok(serde_json::json!({ "path": path }))
}

#[tauri::command]
pub async fn list_history(
    limit: Option<i64>,
    offset: Option<i64>,
    model: Option<String>,
) -> Result<serde_json::Value, String> {
    let rows = storage::list_history(
        limit.unwrap_or(200),
        offset.unwrap_or(0),
        &model.unwrap_or_default(),
    )?;
    let mut items = Vec::new();
    for r in rows {
        let data_url = image_store::path_to_data_url(&r.file_path).unwrap_or_default();
        items.push(serde_json::json!({
            "history": r,
            "dataUrl": data_url,
        }));
    }
    Ok(serde_json::json!({ "items": items }))
}

#[tauri::command]
pub async fn set_favorite(id: i64, favorite: bool) -> Result<(), String> {
    storage::set_favorite(id, favorite)?;
    Ok(())
}

#[tauri::command]
pub async fn delete_history(id: i64) -> Result<(), String> {
    if let Some(path) = storage::delete_history(id)? {
        if !path.is_empty() {
            let _ = std::fs::remove_file(path);
        }
    }
    Ok(())
}
