use crate::image_store;
use crate::storage;

/// 新增消息入参（与前端 NewMessage 对齐）。
///
/// P0-1：此前直接把 storage::MessageRow 当作 IPC 入参，而 MessageRow.id 必填，
/// 前端 NewMessage 不含 id → invoke 反序列化报 missing field id，消息全部无法入库。
/// 这里使用独立 DTO：不含 id，可选字段全部带 serde default，IPC 字段名仍为 camelCase
///（前端无需改动）。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddMessageInput {
    pub conversation_id: i64,
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub refined_content: Option<String>,
    #[serde(default)]
    pub images_json: Option<String>,
    #[serde(default)]
    pub params_json: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
}

impl AddMessageInput {
    /// 组装为落库行：缺省字段按 messages 表的默认语义补齐（created_at 补毫秒时间戳）
    fn into_row(self) -> storage::MessageRow {
        storage::MessageRow {
            id: 0, // 由 AUTOINCREMENT 生成，add_message 不使用该字段
            conversation_id: self.conversation_id,
            role: self.role,
            content: self.content,
            refined_content: self.refined_content.unwrap_or_default(),
            images_json: self.images_json.unwrap_or_else(|| "[]".to_string()),
            params_json: self.params_json.unwrap_or_else(|| "{}".to_string()),
            created_at: self
                .created_at
                .filter(|s| !s.is_empty())
                .unwrap_or_else(storage::timestamp_millis),
        }
    }
}

/// 收集 images_json 中已记录磁盘路径的条目
fn image_paths(images_json: &str) -> Vec<String> {
    serde_json::from_str::<Vec<serde_json::Value>>(images_json)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| {
            entry
                .get("path")
                .and_then(|p| p.as_str())
                .map(|p| p.to_string())
        })
        .collect()
}

/// 入库失败时 best-effort 回收**本次新落盘**的附件。
///
/// 真实流程里附件已由 `save_chat_image` 先落盘并带 path，`persist_image_entries`
/// 不会写新文件，因此本函数通常无事可做；它只对「调用方直接传 dataUrl 的
/// images_json」生效。之所以保留：它是唯一能在「persist 真写了文件但入库失败」时
/// 立即回收的路径，删掉只会把这类残留 100% 推给下次启动扫描。删除仅限本次新增
/// 的差量文件，不碰既有文件。
fn remove_newly_persisted_images(before: &[String], images_json: &str) {
    for path in image_paths(images_json) {
        if before.contains(&path) {
            continue;
        }
        if let Err(e) = std::fs::remove_file(&path) {
            tracing::warn!("消息入库失败后清理新增附件失败：{path}: {e}");
        }
    }
}

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
    input: AddMessageInput,
) -> Result<serde_json::Value, String> {
    let mut row = input.into_row();
    // 落盘前的既有路径，用于入库失败时只回收本次新增的附件
    let paths_before = image_paths(&row.images_json);
    row.images_json = image_store::persist_image_entries(&app, &row.images_json)?;
    let id = match storage::add_message(&row) {
        Ok(id) => id,
        Err(e) => {
            remove_newly_persisted_images(&paths_before, &row.images_json);
            return Err(format!("消息入库失败: {e}"));
        }
    };
    Ok(serde_json::json!({
        "id": id,
        "imagesJson": row.images_json,
    }))
}

/// 读取会话消息（keyset 分页）。注意：读路径包含旧数据（dataUrl 直存 images_json）
/// 的惰性迁移，详见 image_store::enrich_image_entries 的 TODO(一次性迁移) 注释。
///
/// `before_id` 为空表示最新一页；返回值按 id 升序，"hasMore" 表示还有更旧的消息。
#[tauri::command]
pub async fn list_messages(
    app: tauri::AppHandle,
    conversation_id: i64,
    limit: Option<i64>,
    before_id: Option<i64>,
) -> Result<serde_json::Value, String> {
    let (rows, has_more) = storage::list_messages(conversation_id, limit.unwrap_or(50), before_id)?;
    let mut out = Vec::new();
    for mut r in rows {
        let (enriched, db_json) = image_store::enrich_image_entries(&app, &r.images_json)?;
        if let Some(db_json) = db_json {
            storage::update_message_images(r.id, &db_json)?;
        }
        r.images_json = enriched;
        out.push(r);
    }
    Ok(serde_json::json!({ "messages": out, "hasMore": has_more }))
}

/// 删除单条消息（用于「重试」时清掉上一条回复，避免旧行留在库里）。
///
/// 不删除图片文件：同一 path 可能仍被画廊 history 引用，删文件必须走各自的回收逻辑。
#[tauri::command]
pub async fn delete_message(id: i64) -> Result<bool, String> {
    Ok(storage::delete_message(id)?)
}

/// 从消息里移除一张生成的图片（缺陷 2：只改前端的话刷新后又会出现）。
///
/// 顺序固定：先改消息的 images_json，再走 `delete_history` 做引用判定与文件回收。
/// 反过来的话，本消息自己的引用会让文件永远判为「仍被引用」。
#[tauri::command]
pub async fn remove_message_image(message_id: i64, history_id: i64) -> Result<bool, String> {
    let removed = storage::remove_message_image(message_id, history_id)?;
    if removed {
        crate::commands::image::delete_history(history_id).await?;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// P0-1 回归：前端 NewMessage（不含 id 的 camelCase JSON）必须能反序列化
    #[test]
    fn add_message_input_accepts_frontend_payload_without_id() {
        let json = r#"{
            "conversationId": 3,
            "role": "user",
            "content": "画一只猫",
            "refinedContent": "",
            "imagesJson": "[{\"path\":\"/x.png\"}]",
            "paramsJson": "{\"steps\":30}",
            "createdAt": "1700000000.123"
        }"#;
        let input: AddMessageInput = serde_json::from_str(json).expect("前端入参应可反序列化");
        let row = input.into_row();
        assert_eq!(row.id, 0);
        assert_eq!(row.conversation_id, 3);
        assert_eq!(row.created_at, "1700000000.123");
        assert_eq!(row.images_json, r#"[{"path":"/x.png"}]"#);
    }

    /// P0-1 回归：缺省 createdAt 时补毫秒时间戳（秒.毫秒，含 '.'），其余字段按表默认值补齐
    #[test]
    fn add_message_input_fills_missing_created_at() {
        let json = r#"{"conversationId":1,"role":"assistant","content":"hi"}"#;
        let input: AddMessageInput = serde_json::from_str(json).unwrap();
        let row = input.into_row();
        let (secs, millis) = row.created_at.split_once('.').expect("应为 秒.毫秒 格式");
        assert!(secs.parse::<u64>().is_ok());
        assert_eq!(millis.len(), 3);
        assert_eq!(row.refined_content, "");
        assert_eq!(row.images_json, "[]");
        assert_eq!(row.params_json, "{}");
    }
}
