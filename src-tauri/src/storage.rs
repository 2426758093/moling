use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

mod assets;
mod canvas;
mod conversations;
mod crypto;
mod history;
mod jobs;
mod media;
mod providers;
mod schema;
mod settings;

pub use assets::*;
pub use canvas::*;
pub use conversations::*;
pub use crypto::*;
pub use history::*;
pub use jobs::*;
pub use media::*;
pub use providers::*;
pub use schema::*;
pub use settings::*;

static DB: OnceLock<Mutex<Connection>> = OnceLock::new();

/// 测试期间串行化全局 DB 初始化：OnceLock 只能 init 一次，多个测试模块会争抢
#[cfg(test)]
pub(crate) static TEST_DB_LOCK: Mutex<()> = Mutex::new(());

pub fn init(app_data_dir: PathBuf) -> AppResult<()> {
    std::fs::create_dir_all(&app_data_dir)?;
    let conn = open_and_migrate(&app_data_dir.join("moling.db"))?;
    DB.set(Mutex::new(conn))
        .map_err(|_| AppError::Other("storage already initialized".into()))
}

/// 打开数据库并应用迁移（init 与单测共用）。
///
/// 旧库升级前先留一份快照：迁移失败本身会回滚，但跨版本升级后旧代码就再也
/// 打不开新 schema 了，留一份可回退的副本比事后补救便宜。
pub(crate) fn open_and_migrate(db_path: &std::path::Path) -> AppResult<Connection> {
    let mut conn = Connection::open(db_path)?;
    // WAL 下并发写会短暂 SQLITE_BUSY：等 5s 而不是立刻失败；外键约束必须显式打开
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    let version = current_version(&conn)?;
    // 全新的空库（还没有 providers 表）没有数据可备份，跳过以免产生噪声文件
    if version < SCHEMA_VERSION && !table_missing(&conn, "providers") {
        backup_before_migration(db_path);
    }
    apply_migrations(&mut conn)?;
    backfill_provider_keys(&conn);
    Ok(conn)
}

/// 把存量单 Key 回填成 Key 列表（迁移 003 之后执行）。
/// 解密失败的行走跳过并留日志，下次启动重试；回填失败绝不阻断启动。
fn backfill_provider_keys(conn: &Connection) {
    let rows: Vec<(i64, String)> = {
        let mut stmt = match conn.prepare(
            "SELECT id, api_key_enc FROM providers WHERE api_keys_enc = '' AND api_key_enc <> ''",
        ) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("多 Key 回填查询失败: {e}");
                return;
            }
        };
        let collected = match stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))) {
            Ok(rows) => rows.filter_map(|r| r.ok()).collect::<Vec<_>>(),
            Err(e) => {
                tracing::warn!("多 Key 回填读取失败: {e}");
                return;
            }
        };
        collected
    };
    for (id, legacy_enc) in rows {
        let key = match decrypt_secret(&legacy_enc) {
            Ok(k) if !k.is_empty() => k,
            Ok(_) => continue,
            Err(e) => {
                tracing::warn!("服务商 id={id} 的旧 Key 解密失败，暂不参与多 Key 回填: {e}");
                continue;
            }
        };
        let json = match serde_json::to_string(&[ProviderKey::new(key)]) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("服务商 id={id} 的 Key 列表序列化失败: {e}");
                continue;
            }
        };
        match encrypt_secret(&json) {
            Ok(enc) => {
                if let Err(e) = conn.execute(
                    "UPDATE providers SET api_keys_enc = ?1 WHERE id = ?2 AND api_keys_enc = ''",
                    params![enc, id],
                ) {
                    tracing::warn!("服务商 id={id} 多 Key 回填写入失败: {e}");
                }
            }
            Err(e) => tracing::warn!("服务商 id={id} 的 Key 列表加密失败: {e}"),
        }
    }
}
/// 是否属于「数据库文件本身损坏」——只有这类错误才允许改名重建，
/// 其余错误（锁占用、磁盘满、迁移失败）必须上抛，绝不能把用户数据搬走。
pub fn is_corruption(e: &AppError) -> bool {
    match e {
        AppError::Sqlite(rusqlite::Error::SqliteFailure(err, _)) => matches!(
            err.code,
            rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase
        ),
        _ => false,
    }
}

pub(crate) fn conn() -> AppResult<std::sync::MutexGuard<'static, Connection>> {
    DB.get()
        .ok_or_else(|| AppError::Other("storage not initialized".into()))?
        .lock()
        .map_err(|e| AppError::Other(e.to_string()))
}
/// 可排序的毫秒时间戳（秒.毫秒格式），不依赖 chrono
pub fn timestamp_millis() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:03}", dur.as_secs(), dur.subsec_millis())
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use rusqlite::{params, Connection};
    use std::path::PathBuf;

    /// 串行化所有改动 MOLING_MASTER_KEY_HEX 的测试（cargo test 默认多线程并行）
    pub(crate) static ENV_LOCK: Mutex<()> = Mutex::new(());

    pub(crate) fn test_dir() -> PathBuf {
        std::env::temp_dir().join(format!("moling-test-{}", std::process::id()))
    }

    /// 单测用内存库：跑与线上完全相同的迁移序列，避免测试库 schema 漂移。
    /// （全局 DB 是 OnceLock，无法在测试里重复 init）
    pub(crate) fn mem_conn() -> Connection {
        let mut c = Connection::open_in_memory().expect("open in-memory db");
        apply_migrations(&mut c).expect("apply migrations");
        c
    }

    pub(crate) fn user_version_of(c: &Connection) -> i64 {
        c.query_row("PRAGMA user_version", [], |r| r.get(0))
            .expect("read user_version")
    }

    pub(crate) fn index_exists(c: &Connection, name: &str) -> bool {
        c.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
            params![name],
            |r| r.get::<_, i64>(0),
        )
        .expect("query sqlite_master")
            > 0
    }

    pub(crate) fn insert_message(c: &Connection, conversation_id: i64, content: &str) -> i64 {
        c.execute(
            "INSERT INTO messages (conversation_id, role, content, refined_content,
             images_json, params_json, created_at) VALUES (?1,'user',?2,'','[]','{}','0.000')",
            params![conversation_id, content],
        )
        .expect("insert message");
        c.last_insert_rowid()
    }

    pub(crate) fn count_providers(c: &Connection) -> i64 {
        c.query_row("SELECT COUNT(*) FROM providers", [], |r| r.get(0))
            .expect("count providers")
    }

    pub(crate) fn provider_id_by_name(c: &Connection, name: &str) -> i64 {
        c.query_row(
            "SELECT id FROM providers WHERE name = ?1",
            params![name],
            |r| r.get(0),
        )
        .expect("provider id")
    }

    pub(crate) fn setting_of(c: &Connection, key: &str) -> Option<String> {
        c.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |r| r.get(0),
        )
        .ok()
    }

    pub(crate) fn draft<'a>(
        name: &'a str,
        api_key: Option<&'a str>,
        extra: Option<&'a str>,
    ) -> ProviderDraft<'a> {
        ProviderDraft {
            name,
            base_url: "",
            api_key,
            kind: "mock",
            models_json: extra.unwrap_or("[\"mock-draw-v1\"]"),
            default_model: "mock-draw-v1",
            timeout_secs: 60,
            template_url: "",
            template_body: "",
            template_response_path: "",
            edit_template_json: "",
            transform_template_json: "",
        }
    }

    pub(crate) fn insert_history_row(c: &Connection, file_path: &str) -> i64 {
        c.execute(
            "INSERT INTO history (prompt, negative_prompt, model, provider_name, seed, width,
             height, guidance, steps, style, file_path, favorite, created_at)
             VALUES ('p','','m','pv',NULL,1024,1024,0,0,'', ?1, 0, '0.000')",
            params![file_path],
        )
        .expect("insert history");
        c.last_insert_rowid()
    }

    pub(crate) fn set_message_images(c: &Connection, id: i64, images_json: &str) {
        c.execute(
            "UPDATE messages SET images_json = ?2 WHERE id = ?1",
            params![id, images_json],
        )
        .expect("update images_json");
    }

    pub(crate) fn count_history_rows(c: &Connection) -> i64 {
        c.query_row("SELECT COUNT(*) FROM history", [], |r| r.get(0))
            .expect("count history")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamp_millis_format() {
        let ts = timestamp_millis();
        let (secs, millis) = ts.split_once('.').expect("秒.毫秒 格式");
        assert!(secs.parse::<u64>().is_ok());
        assert_eq!(millis.len(), 3);
    }
}
