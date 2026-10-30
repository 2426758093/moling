use crate::error::AppResult;
use crate::image_store;
use crate::storage;
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePresetInput {
    #[serde(default)]
    pub id: Option<i64>,
    pub name: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub negative_prompt: String,
    #[serde(default)]
    pub params: serde_json::Value,
    #[serde(default)]
    pub refs: Vec<storage::PresetRef>,
}

pub fn ensure_preset_refs(app: &tauri::AppHandle, refs: &[storage::PresetRef]) -> AppResult<()> {
    for r in refs {
        image_store::ensure_ref_path(app, &r.path)?;
    }
    Ok(())
}

#[tauri::command]
pub fn list_favorites() -> Result<Vec<storage::PromptFavorite>, String> {
    storage::list_favorites().map_err(Into::into)
}

#[tauri::command]
pub fn upsert_favorite(text: String, tags: Vec<String>) -> Result<storage::PromptFavorite, String> {
    storage::upsert_favorite(&text, &tags).map_err(Into::into)
}

#[tauri::command]
pub fn delete_favorite(id: i64) -> Result<bool, String> {
    storage::delete_favorite(id).map_err(Into::into)
}

#[tauri::command]
pub fn list_presets() -> Result<Vec<storage::WorkflowPreset>, String> {
    storage::list_presets().map_err(Into::into)
}

#[tauri::command]
pub fn save_preset(
    app: tauri::AppHandle,
    input: SavePresetInput,
) -> Result<storage::WorkflowPreset, String> {
    ensure_preset_refs(&app, &input.refs)?;
    let params =
        serde_json::to_string(&input.params).map_err(|e| format!("预设参数序列化失败: {e}"))?;
    storage::save_preset(
        input.id,
        &input.name,
        &input.prompt,
        &input.negative_prompt,
        &params,
        &input.refs,
    )
    .map_err(Into::into)
}

#[tauri::command]
pub fn delete_preset(id: i64) -> Result<bool, String> {
    storage::delete_preset(id).map_err(Into::into)
}
