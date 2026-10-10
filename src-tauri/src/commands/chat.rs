use crate::image_store;
use crate::storage;

#[tauri::command]
pub async fn create_conversation(title: String) -> Result<i64, String> {
    Ok(storage::create_conversation(&title)?)
}

#[tauri::command]
pub async fn list_conversations() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "conversations": storage::list_conversations()? }))
}

#[tauri::command]
pub async fn delete_conversation(id: i64) -> Result<(), String> {
    storage::delete_conversation(id)?;
    Ok(())
}

#[tauri::command]
pub async fn add_message(
    app: tauri::AppHandle,
    mut input: storage::MessageRow,
) -> Result<serde_json::Value, String> {
    input.images_json = image_store::persist_image_entries(&app, &input.images_json)?;
    let id = storage::add_message(&input)?;
    Ok(serde_json::json!({
        "id": id,
        "imagesJson": input.images_json,
    }))
}

/// 读取会话消息。注意：读路径包含旧数据（dataUrl 直存 images_json）的惰性迁移，
/// 详见 image_store::enrich_image_entries 的 TODO(一次性迁移) 注释。
#[tauri::command]
pub async fn list_messages(
    app: tauri::AppHandle,
    conversation_id: i64,
) -> Result<serde_json::Value, String> {
    let rows = storage::list_messages(conversation_id)?;
    let mut out = Vec::new();
    for mut r in rows {
        let (enriched, db_json) = image_store::enrich_image_entries(&app, &r.images_json)?;
        if let Some(db_json) = db_json {
            storage::update_message_images(r.id, &db_json)?;
        }
        r.images_json = enriched;
        out.push(r);
    }
    Ok(serde_json::json!({ "messages": out }))
}
