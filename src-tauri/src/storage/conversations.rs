use super::*;

use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRow {
    pub id: i64,
    pub title: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
    /// id 由数据库生成；#[serde(default)] 作为纵深防御，避免 IPC 入参缺 id 时反序列化失败
    #[serde(default)]
    pub id: i64,
    pub conversation_id: i64,
    pub role: String,
    pub content: String,
    pub refined_content: String,
    pub images_json: String,
    pub params_json: String,
    pub created_at: String,
    /// done | failed | unconfirmed；旧库/旧前端缺省按 done 处理
    #[serde(default = "default_message_status")]
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
}

fn default_message_status() -> String {
    "done".to_string()
}

pub fn create_conversation(title: &str) -> AppResult<i64> {
    let c = conn()?;
    c.execute(
        "INSERT INTO conversations (title, created_at) VALUES (?1, ?2)",
        params![title, timestamp_millis()],
    )?;
    Ok(c.last_insert_rowid())
}

/// 会话标题回写（AI 自动命名）。会话不存在时返回 false，不当作错误。
pub fn update_conversation_title(id: i64, title: &str) -> AppResult<bool> {
    let c = conn()?;
    let affected = c.execute(
        "UPDATE conversations SET title = ?1 WHERE id = ?2",
        params![title, id],
    )?;
    Ok(affected > 0)
}

pub fn list_conversations() -> AppResult<Vec<ConversationRow>> {
    let c = conn()?;
    let mut stmt = c.prepare("SELECT id, title, created_at FROM conversations ORDER BY id DESC")?;
    let rows = stmt.query_map([], |r| {
        Ok(ConversationRow {
            id: r.get(0)?,
            title: r.get(1)?,
            created_at: r.get(2)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

pub fn delete_conversation(id: i64) -> AppResult<()> {
    let c = conn()?;
    delete_conversation_in(&c, id)
}

/// 会话与其消息必须同时消失：中途失败留下孤儿 messages，
/// 之后既不会出现在界面里，也不会被任何清理逻辑回收。
pub(crate) fn delete_conversation_in(c: &Connection, id: i64) -> AppResult<()> {
    let tx = c.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM messages WHERE conversation_id = ?1",
        params![id],
    )?;
    tx.execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
    tx.commit()?;
    Ok(())
}

/// 删除单条消息，返回是否命中。**不删图片文件**：同一个 path 可能还被
/// history（画廊）引用，删文件必须走画廊/附件各自的回收逻辑。
pub fn delete_message(id: i64) -> AppResult<bool> {
    let c = conn()?;
    delete_message_in(&c, id)
}

pub(crate) fn delete_message_in(c: &Connection, id: i64) -> AppResult<bool> {
    let affected = c.execute("DELETE FROM messages WHERE id = ?1", params![id])?;
    Ok(affected > 0)
}

pub fn add_message(m: &MessageRow) -> AppResult<i64> {
    let c = conn()?;
    c.execute(
        "INSERT INTO messages (conversation_id, role, content, refined_content, images_json,
         params_json, created_at, status, error) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            m.conversation_id,
            m.role,
            m.content,
            m.refined_content,
            m.images_json,
            m.params_json,
            m.created_at,
            if m.status.is_empty() {
                "done"
            } else {
                &m.status
            },
            m.error,
        ],
    )?;
    Ok(c.last_insert_rowid())
}

/// 按会话取一页消息：`before_id` 为空表示最新一页，否则取该 id 之前（更旧）的消息。
///
/// 用 keyset 分页（id < before_id）而不是 OFFSET：OFFSET 在长会话里越翻越慢，
/// 且翻页期间新增消息会让窗口错位。返回值按 id 升序（渲染顺序），`has_more`
/// 表示还有更旧的消息可加载。
pub fn list_messages(
    conversation_id: i64,
    limit: i64,
    before_id: Option<i64>,
) -> AppResult<(Vec<MessageRow>, bool)> {
    let c = conn()?;
    list_messages_in(&c, conversation_id, limit, before_id)
}

pub(crate) fn list_messages_in(
    c: &Connection,
    conversation_id: i64,
    limit: i64,
    before_id: Option<i64>,
) -> AppResult<(Vec<MessageRow>, bool)> {
    let limit = limit.clamp(1, 200);
    // id <= 0 是前端占位消息的本地 id，不能当游标
    let before = before_id.filter(|id| *id > 0);
    let mut stmt = c.prepare(
        "SELECT id, conversation_id, role, content, refined_content, images_json,
         params_json, created_at, status, error FROM messages
         WHERE conversation_id = ?1 AND (?2 IS NULL OR id < ?2)
         ORDER BY id DESC LIMIT ?3",
    )?;
    // 多取一条用来判断是否还有更旧的页
    let mut rows = stmt
        .query_map(params![conversation_id, before, limit + 1], |r| {
            Ok(MessageRow {
                id: r.get(0)?,
                conversation_id: r.get(1)?,
                role: r.get(2)?,
                content: r.get(3)?,
                refined_content: r.get(4)?,
                images_json: r.get(5)?,
                params_json: r.get(6)?,
                created_at: r.get(7)?,
                status: r
                    .get::<_, Option<String>>(8)?
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(default_message_status),
                error: r.get(9)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::from)?;
    let has_more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    rows.reverse();
    Ok((rows, has_more))
}
/// 回写消息的图片条目（仅在读路径惰性迁移触发时调用，见 image_store::enrich_image_entries）
pub fn update_message_images(id: i64, images_json: &str) -> AppResult<()> {
    conn()?.execute(
        "UPDATE messages SET images_json = ?2 WHERE id = ?1",
        params![id, images_json],
    )?;
    Ok(())
}
/// 从消息的 images_json 中移除一条图片引用。
///
/// 必须先改消息、再由调用方走 `delete_history` 做引用判定：顺序反了的话，
/// 本消息自己的引用会让文件被判为「仍被引用」而永远保留。
pub fn remove_message_image(message_id: i64, history_id: i64) -> AppResult<bool> {
    let c = conn()?;
    remove_message_image_in(&c, message_id, history_id)
}

fn remove_message_image_in(c: &Connection, message_id: i64, history_id: i64) -> AppResult<bool> {
    let json: Option<String> = c
        .query_row(
            "SELECT images_json FROM messages WHERE id = ?1",
            params![message_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(json) = json else { return Ok(false) };
    let Ok(mut entries) = serde_json::from_str::<Vec<serde_json::Value>>(&json) else {
        return Ok(false);
    };
    let before = entries.len();
    entries.retain(|e| e.get("historyId").and_then(|v| v.as_i64()) != Some(history_id));
    if entries.len() == before {
        return Ok(false);
    }
    let updated = serde_json::to_string(&entries).map_err(|e| AppError::Other(e.to_string()))?;
    c.execute(
        "UPDATE messages SET images_json = ?2 WHERE id = ?1",
        params![message_id, updated],
    )?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::*;

    /// A3：删除会话时中途失败要整体回滚，不能留下孤儿 messages
    #[test]
    fn delete_conversation_rolls_back_on_failure() {
        let c = mem_conn();
        c.execute_batch(
            "CREATE TRIGGER fail_message_delete BEFORE DELETE ON messages
             BEGIN SELECT RAISE(ABORT, 'boom'); END;",
        )
        .unwrap();
        c.execute(
            "INSERT INTO conversations (title, created_at) VALUES ('会话', '0.000')",
            [],
        )
        .unwrap();
        let cid = c.last_insert_rowid();
        insert_message(&c, cid, "hi");

        let err = delete_conversation_in(&c, cid).expect_err("应触发回滚");
        assert!(err.to_string().contains("boom"), "{err}");
        let messages: i64 = c
            .query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))
            .unwrap();
        let conversations: i64 = c
            .query_row("SELECT COUNT(*) FROM conversations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(messages, 1, "回滚后消息必须还在");
        assert_eq!(conversations, 1);
    }

    /// A2：keyset 分页从新到旧逐页取，顺序为渲染顺序（id 升序），不串会话
    #[test]
    fn keyset_pagination_walks_backwards() {
        let c = mem_conn();
        c.execute(
            "INSERT INTO conversations (title, created_at) VALUES ('A', '0.000')",
            [],
        )
        .unwrap();
        let a = c.last_insert_rowid();
        c.execute(
            "INSERT INTO conversations (title, created_at) VALUES ('B', '0.000')",
            [],
        )
        .unwrap();
        let b = c.last_insert_rowid();
        for i in 1..=120 {
            insert_message(&c, a, &format!("m{i}"));
        }
        insert_message(&c, b, "other");

        let (page1, more1) = list_messages_in(&c, a, 50, None).unwrap();
        assert_eq!(page1.len(), 50);
        assert!(more1);
        assert_eq!(page1.first().unwrap().content, "m71");
        assert_eq!(page1.last().unwrap().content, "m120");

        let (page2, more2) = list_messages_in(&c, a, 50, Some(page1.first().unwrap().id)).unwrap();
        assert_eq!(page2.len(), 50);
        assert!(more2);
        assert_eq!(page2.first().unwrap().content, "m21");
        assert_eq!(page2.last().unwrap().content, "m70");

        let (page3, more3) = list_messages_in(&c, a, 50, Some(page2.first().unwrap().id)).unwrap();
        assert_eq!(page3.len(), 20);
        assert!(!more3);
        assert_eq!(page3.first().unwrap().content, "m1");
        assert_eq!(page3.last().unwrap().content, "m20");
        assert!(page1.iter().all(|m| m.conversation_id == a));
        // 本地占位消息的负数 id 不能当游标（等价于取最新一页）
        let (fresh, _) = list_messages_in(&c, a, 5, Some(-1)).unwrap();
        assert_eq!(fresh.last().unwrap().content, "m120");
        // limit 越界时收敛到 1..=200
        let (clamped, _) = list_messages_in(&c, a, 10_000, None).unwrap();
        assert_eq!(clamped.len(), 120);
    }

    /// A3：delete_message 只删目标行，返回是否命中
    #[test]
    fn delete_message_removes_only_target_row() {
        let c = mem_conn();
        c.execute(
            "INSERT INTO conversations (title, created_at) VALUES ('A', '0.000')",
            [],
        )
        .unwrap();
        let cid = c.last_insert_rowid();
        let first = insert_message(&c, cid, "a");
        let second = insert_message(&c, cid, "b");
        let third = insert_message(&c, cid, "c");

        assert!(delete_message_in(&c, second).unwrap());
        assert!(
            !delete_message_in(&c, second).unwrap(),
            "重复删除应返回 false"
        );
        let (left, _) = list_messages_in(&c, cid, 50, None).unwrap();
        let ids: Vec<i64> = left.iter().map(|m| m.id).collect();
        assert_eq!(ids, vec![first, third]);
    }

    /// C4 缺陷 2：消息内移除图片引用后才能回收文件；其它消息仍引用时必须保留
    #[test]
    fn remove_message_image_keeps_shared_file() {
        let c = mem_conn();
        let shared = c
            .execute(
                "INSERT INTO history (prompt, file_path, created_at) VALUES ('p', 'shared.png', '0.000')",
                [],
            )
            .map(|_| c.last_insert_rowid())
            .unwrap();
        let images = serde_json::json!([{ "historyId": shared, "path": "shared.png" }]).to_string();
        let keep = insert_message(&c, 1, "keep");
        c.execute(
            "UPDATE messages SET images_json = ?2 WHERE id = ?1",
            params![keep, images],
        )
        .unwrap();
        let target = insert_message(&c, 1, "target");
        c.execute(
            "UPDATE messages SET images_json = ?2 WHERE id = ?1",
            params![target, images],
        )
        .unwrap();

        assert!(remove_message_image_in(&c, target, shared).unwrap());
        assert!(
            !remove_message_image_in(&c, target, shared).unwrap(),
            "重复移除应返回 false"
        );
        let remaining: String = c
            .query_row(
                "SELECT images_json FROM messages WHERE id = ?1",
                params![target],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(remaining, "[]");

        // 另一条消息仍引用 → 文件保留
        let deletion = delete_history_in(&c, shared).unwrap();
        assert!(deletion.still_referenced, "仍有消息引用时不得回收文件");
    }
}
