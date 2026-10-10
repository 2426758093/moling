use crate::error::{AppError, AppResult};
use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use base64::Engine;
use rand::RngCore;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

static DB: OnceLock<Mutex<Connection>> = OnceLock::new();

/// keyring 服务名/账号（跨版本冻结，勿改）
const MASTER_KEY_SERVICE: &str = "moling";
const MASTER_KEY_USER: &str = "master-key";
const MASTER_KEY_ENV: &str = "MOLING_MASTER_KEY_HEX";

const KEYRING_READ_REFUSE: &str = "无法读取系统凭据管理器，拒绝轮换主密钥以避免数据丢失";

/// 主密钥进程内缓存（R6：避免每行解密都走一次 DPAPI 系统调用）。
/// 注意：环境变量注入路径不走进程缓存，便于测试与便携模式外部轮换。
static MASTER_KEY: OnceLock<[u8; 32]> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRow {
    pub id: i64,
    pub name: String,
    pub base_url: String,
    #[serde(skip_serializing)]
    pub api_key_enc: String,
    pub kind: String,
    pub models_json: String,
    pub default_model: String,
    pub timeout_secs: u64,
    pub template_url: String,
    pub template_body: String,
    pub template_response_path: String,
    pub api_key_masked: String,
    pub has_key: bool,
    /// 密文非空但解密失败（主密钥丢失/密文损坏），前端据此提示"密钥损坏，请重新填写"
    #[serde(default)]
    pub key_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRow {
    pub id: i64,
    pub prompt: String,
    pub negative_prompt: String,
    pub model: String,
    pub provider_name: String,
    pub seed: Option<i64>,
    pub width: i64,
    pub height: i64,
    pub guidance: f64,
    pub steps: i64,
    pub style: String,
    pub file_path: String,
    pub favorite: bool,
    pub created_at: String,
}

/// 服务商可编辑字段（save_provider / import_config 共用）
pub struct ProviderDraft<'a> {
    pub name: &'a str,
    pub base_url: &'a str,
    /// 明文 Key；`None` 表示更新时保留旧密文
    pub api_key: Option<&'a str>,
    pub kind: &'a str,
    pub models_json: &'a str,
    pub default_model: &'a str,
    pub timeout_secs: u64,
    pub template_url: &'a str,
    pub template_body: &'a str,
    pub template_response_path: &'a str,
}

pub fn init(app_data_dir: PathBuf) -> AppResult<()> {
    std::fs::create_dir_all(&app_data_dir)?;
    let conn = Connection::open(app_data_dir.join("moling.db"))?;
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS providers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            base_url TEXT NOT NULL DEFAULT '',
            api_key_enc TEXT NOT NULL DEFAULT '',
            kind TEXT NOT NULL DEFAULT 'openai',
            models_json TEXT NOT NULL DEFAULT '',
            default_model TEXT NOT NULL DEFAULT '',
            timeout_secs INTEGER NOT NULL DEFAULT 60,
            template_url TEXT NOT NULL DEFAULT '',
            template_body TEXT NOT NULL DEFAULT '',
            template_response_path TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            prompt TEXT NOT NULL DEFAULT '',
            negative_prompt TEXT NOT NULL DEFAULT '',
            model TEXT NOT NULL DEFAULT '',
            provider_name TEXT NOT NULL DEFAULT '',
            seed INTEGER,
            width INTEGER NOT NULL DEFAULT 0,
            height INTEGER NOT NULL DEFAULT 0,
            guidance REAL NOT NULL DEFAULT 0,
            steps INTEGER NOT NULL DEFAULT 0,
            style TEXT NOT NULL DEFAULT '',
            file_path TEXT NOT NULL DEFAULT '',
            favorite INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id INTEGER NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',
            content TEXT NOT NULL DEFAULT '',
            refined_content TEXT NOT NULL DEFAULT '',
            images_json TEXT NOT NULL DEFAULT '[]',
            params_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT ''
        );
        ",
    )?;
    DB.set(Mutex::new(conn))
        .map_err(|_| AppError::Other("storage already initialized".into()))
}

fn conn() -> AppResult<std::sync::MutexGuard<'static, Connection>> {
    DB.get()
        .ok_or_else(|| AppError::Other("storage not initialized".into()))?
        .lock()
        .map_err(|e| AppError::Other(e.to_string()))
}

fn master_key() -> AppResult<[u8; 32]> {
    // 允许通过环境变量注入主密钥（测试 / 便携模式）
    if let Ok(hex_env) = std::env::var(MASTER_KEY_ENV) {
        return parse_hex_key(&hex_env)
            .map_err(|_| AppError::Crypto(format!("{MASTER_KEY_ENV} 必须是 64 位十六进制")));
    }
    if let Some(key) = MASTER_KEY.get() {
        return Ok(*key);
    }
    let key = load_or_create_master_key()?;
    // 并发首次加载时多个线程可能各自读到相同 keyring 值；创建路径总是先写
    // keyring 再返回，因此竞争双方的值必然一致，缓存任一即可。
    Ok(*MASTER_KEY.get_or_init(|| key))
}

/// 从 keyring 读取主密钥；仅当凭据明确不存在（首次运行）时才生成并写入新密钥。
/// 读取失败一律报错，绝不静默轮换主密钥（否则所有已存 API Key 永久不可解）。
fn load_or_create_master_key() -> AppResult<[u8; 32]> {
    let entry = keyring::Entry::new(MASTER_KEY_SERVICE, MASTER_KEY_USER)
        .map_err(|e| AppError::Keyring(format!("创建凭据管理器条目失败: {e}")))?;
    match entry.get_password() {
        Ok(hex) => parse_hex_key(&hex).map_err(|msg| {
            tracing::error!("keyring 中存储的主密钥无法解析（{msg}），拒绝轮换以避免数据丢失");
            AppError::Keyring(format!(
                "{KEYRING_READ_REFUSE}: 已存储的主密钥格式异常（{msg}）"
            ))
        }),
        Err(keyring::Error::NoEntry) => {
            let mut key = [0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut key);
            let hex_str: String = key.iter().map(|b| format!("{:02x}", b)).collect();
            entry.set_password(&hex_str).map_err(|e| {
                tracing::error!("无法写入系统凭据管理器: {e}");
                AppError::Keyring(format!("无法写入系统凭据管理器: {e}"))
            })?;
            // 无 info 级别日志配置（默认仅落盘 WARN/ERROR），主密钥创建属安全关键事件，用 warn 留痕
            tracing::warn!("首次运行：已生成新的主加密密钥并写入系统凭据管理器");
            Ok(key)
        }
        Err(e) => {
            tracing::error!("{KEYRING_READ_REFUSE}: {e}");
            Err(AppError::Keyring(format!("{KEYRING_READ_REFUSE}: {e}")))
        }
    }
}

fn parse_hex_key(hex_str: &str) -> Result<[u8; 32], &'static str> {
    let bytes = hex::decode_inner(hex_str).map_err(|_| "hex 解码失败")?;
    if bytes.len() != 32 {
        return Err("长度不是 32 字节");
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Ok(key)
}

pub fn encrypt_secret(plain: &str) -> AppResult<String> {
    let key = master_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| AppError::Crypto(e.to_string()))?;
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plain.as_bytes())
        .map_err(|e| AppError::Crypto(e.to_string()))?;
    let mut packed = nonce_bytes.to_vec();
    packed.extend_from_slice(&ciphertext);
    Ok(base64::engine::general_purpose::STANDARD.encode(packed))
}

pub fn decrypt_secret(enc: &str) -> AppResult<String> {
    if enc.is_empty() {
        return Ok(String::new());
    }
    let packed = base64::engine::general_purpose::STANDARD
        .decode(enc)
        .map_err(|e| AppError::Crypto(e.to_string()))?;
    if packed.len() < 13 {
        return Err(AppError::Crypto("密文长度异常".into()));
    }
    let key = master_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| AppError::Crypto(e.to_string()))?;
    let nonce = Nonce::from_slice(&packed[..12]);
    let plain = cipher
        .decrypt(nonce, &packed[12..])
        .map_err(|_| AppError::Crypto("Key 解密失败（主密钥可能已变化）".into()))?;
    String::from_utf8(plain).map_err(|e| AppError::Crypto(e.to_string()))
}

/// API Key 脱敏：按字符（而非字节）截取头尾各 4 位，短 Key 整体遮蔽。
/// 用户 Key 可能含多字节字符，字节切片会在 UTF-8 边界 panic（B1）。
pub fn mask_key(key: &str) -> String {
    if key.chars().count() <= 8 {
        return "****".to_string();
    }
    let head: String = key.chars().take(4).collect();
    let tail: String = key
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    format!("{}...{}", head, tail)
}

fn row_to_provider(row: &rusqlite::Row) -> rusqlite::Result<ProviderRow> {
    let id: i64 = row.get(0)?;
    let enc: String = row.get(3)?;
    // 空密文 = 未设置 Key（正常空串）；非空但解密失败 = 密文损坏/主密钥变化，
    // 标记 key_error 透出前端，禁止静默吞错（R2）
    let (key, key_error) = match decrypt_secret(&enc) {
        Ok(k) => (k, false),
        Err(e) => {
            tracing::warn!(
                "服务商 id={} 的 API Key 解密失败，标记 key_error: {}",
                id,
                e
            );
            (String::new(), true)
        }
    };
    Ok(ProviderRow {
        id,
        name: row.get(1)?,
        base_url: row.get(2)?,
        api_key_enc: enc,
        kind: row.get(4)?,
        models_json: row.get(5)?,
        default_model: row.get(6)?,
        timeout_secs: row.get::<_, i64>(7)? as u64,
        template_url: row.get(8)?,
        template_body: row.get(9)?,
        template_response_path: row.get(10)?,
        api_key_masked: mask_key(&key),
        has_key: !key.is_empty(),
        key_error,
    })
}

pub fn save_provider(id: Option<i64>, draft: &ProviderDraft) -> AppResult<ProviderRow> {
    let id = {
        let c = conn()?;
        match id {
            Some(existing) => {
                let enc = draft.api_key.map(encrypt_secret).transpose()?;
                // 单条 UPDATE：未提供新 Key 时 enc 为 NULL，COALESCE 保留旧密文
                c.execute(
                    "UPDATE providers SET name=?1, base_url=?2, api_key_enc=COALESCE(?3, api_key_enc),
                     kind=?4, models_json=?5, default_model=?6, timeout_secs=?7, template_url=?8,
                     template_body=?9, template_response_path=?10 WHERE id=?11",
                    params![
                        draft.name,
                        draft.base_url,
                        enc,
                        draft.kind,
                        draft.models_json,
                        draft.default_model,
                        draft.timeout_secs as i64,
                        draft.template_url,
                        draft.template_body,
                        draft.template_response_path,
                        existing
                    ],
                )?;
                existing
            }
            None => {
                let enc = encrypt_secret(draft.api_key.unwrap_or(""))?;
                c.execute(
                    "INSERT INTO providers (name, base_url, api_key_enc, kind, models_json,
                     default_model, timeout_secs, template_url, template_body, template_response_path)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                    params![
                        draft.name,
                        draft.base_url,
                        enc,
                        draft.kind,
                        draft.models_json,
                        draft.default_model,
                        draft.timeout_secs as i64,
                        draft.template_url,
                        draft.template_body,
                        draft.template_response_path
                    ],
                )?;
                c.last_insert_rowid()
            }
        }
    };
    get_provider(id)?.ok_or_else(|| AppError::NotFound("provider not found after save".into()))
}

pub fn get_provider(id: i64) -> AppResult<Option<ProviderRow>> {
    let c = conn()?;
    let mut stmt = c.prepare(
        "SELECT id, name, base_url, api_key_enc, kind, models_json, default_model,
         timeout_secs, template_url, template_body, template_response_path
         FROM providers WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], row_to_provider)?;
    Ok(rows.next().transpose()?)
}

pub fn list_providers() -> AppResult<Vec<ProviderRow>> {
    let c = conn()?;
    let mut stmt = c.prepare(
        "SELECT id, name, base_url, api_key_enc, kind, models_json, default_model,
         timeout_secs, template_url, template_body, template_response_path
         FROM providers ORDER BY id",
    )?;
    let rows = stmt.query_map([], row_to_provider)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

pub fn delete_provider(id: i64) -> AppResult<()> {
    conn()?.execute("DELETE FROM providers WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn set_setting(key: &str, value: &str) -> AppResult<()> {
    conn()?.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn get_setting(key: &str) -> AppResult<Option<String>> {
    let c = conn()?;
    let mut stmt = c.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let mut rows = stmt.query_map(params![key], |r| r.get(0))?;
    Ok(rows.next().transpose()?)
}

/// 事务内导入配置（替换语义，R5）：先清空旧 providers 及其 extraParams 设置项，
/// 再写入全部导入内容；中途任何失败整体回滚，不留半导入状态。
/// `data` 为前端导出的 JSON（version 校验由调用方完成），返回导入的服务商数量。
pub fn import_config(data: &serde_json::Value) -> AppResult<usize> {
    let providers = data
        .get("providers")
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default();
    let mut c = conn()?;
    let tx = c.transaction()?;
    // 替换语义：删除旧服务商及与之关联的 extraParams 设置
    let old_ids: Vec<i64> = {
        let mut stmt = tx.prepare("SELECT id FROM providers")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect::<Result<Vec<i64>, _>>()?
    };
    tx.execute("DELETE FROM providers", [])?;
    for id in old_ids {
        tx.execute(
            "DELETE FROM settings WHERE key = ?1",
            params![format!("extraParams:{id}")],
        )?;
    }
    for p in &providers {
        let get = |k: &str| {
            p.get(k)
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string()
        };
        let enc = encrypt_secret(&get("apiKey"))?;
        tx.execute(
            "INSERT INTO providers (name, base_url, api_key_enc, kind, models_json,
             default_model, timeout_secs, template_url, template_body, template_response_path)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                get("name"),
                get("baseUrl"),
                enc,
                get("kind"),
                get("modelsJson"),
                get("defaultModel"),
                p.get("timeoutSecs").and_then(|v| v.as_u64()).unwrap_or(60) as i64,
                get("templateUrl"),
                get("templateBody"),
                get("templateResponsePath")
            ],
        )?;
        let new_id = tx.last_insert_rowid();
        // 恢复透传参数（extraParams 存于 settings KV，导入时必须一并恢复）
        if let Some(ep) = p.get("extraParams").and_then(|v| v.as_str()) {
            tx.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![format!("extraParams:{new_id}"), ep],
            )?;
        }
    }
    if let Some(settings) = data.get("settings").and_then(|s| s.as_object()) {
        for (k, v) in settings {
            if let Some(s) = v.as_str() {
                tx.execute(
                    "INSERT INTO settings (key, value) VALUES (?1, ?2)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    params![k, s],
                )?;
            }
        }
    }
    tx.commit()?;
    Ok(providers.len())
}

pub fn add_history(h: &HistoryRow) -> AppResult<i64> {
    let c = conn()?;
    c.execute(
        "INSERT INTO history (prompt, negative_prompt, model, provider_name, seed, width,
         height, guidance, steps, style, file_path, favorite, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![
            h.prompt,
            h.negative_prompt,
            h.model,
            h.provider_name,
            h.seed,
            h.width,
            h.height,
            h.guidance,
            h.steps,
            h.style,
            h.file_path,
            h.favorite as i64,
            h.created_at
        ],
    )?;
    Ok(c.last_insert_rowid())
}

pub fn list_history(limit: i64, offset: i64, model_filter: &str) -> AppResult<Vec<HistoryRow>> {
    let c = conn()?;
    let sql = if model_filter.is_empty() {
        "SELECT id, prompt, negative_prompt, model, provider_name, seed, width, height,
         guidance, steps, style, file_path, favorite, created_at
         FROM history ORDER BY id DESC LIMIT ?1 OFFSET ?2"
            .to_string()
    } else {
        "SELECT id, prompt, negative_prompt, model, provider_name, seed, width, height,
         guidance, steps, style, file_path, favorite, created_at
         FROM history WHERE model = ?3 ORDER BY id DESC LIMIT ?1 OFFSET ?2"
            .to_string()
    };
    let mut stmt = c.prepare(&sql)?;
    let rows = if model_filter.is_empty() {
        stmt.query_map(params![limit, offset], history_from_row)?
    } else {
        stmt.query_map(params![limit, offset, model_filter], history_from_row)?
    };
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

fn history_from_row(row: &rusqlite::Row) -> rusqlite::Result<HistoryRow> {
    Ok(HistoryRow {
        id: row.get(0)?,
        prompt: row.get(1)?,
        negative_prompt: row.get(2)?,
        model: row.get(3)?,
        provider_name: row.get(4)?,
        seed: row.get(5)?,
        width: row.get(6)?,
        height: row.get(7)?,
        guidance: row.get(8)?,
        steps: row.get(9)?,
        style: row.get(10)?,
        file_path: row.get(11)?,
        favorite: row.get::<_, i64>(12)? != 0,
        created_at: row.get(13)?,
    })
}

pub fn set_favorite(id: i64, favorite: bool) -> AppResult<()> {
    conn()?.execute(
        "UPDATE history SET favorite = ?2 WHERE id = ?1",
        params![id, favorite as i64],
    )?;
    Ok(())
}

pub fn delete_history(id: i64) -> AppResult<Option<String>> {
    let c = conn()?;
    let path: Option<String> = c
        .query_row(
            "SELECT file_path FROM history WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .ok();
    c.execute("DELETE FROM history WHERE id = ?1", params![id])?;
    Ok(path)
}

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
    pub id: i64,
    pub conversation_id: i64,
    pub role: String,
    pub content: String,
    pub refined_content: String,
    pub images_json: String,
    pub params_json: String,
    pub created_at: String,
}

pub fn create_conversation(title: &str) -> AppResult<i64> {
    let c = conn()?;
    c.execute(
        "INSERT INTO conversations (title, created_at) VALUES (?1, ?2)",
        params![title, timestamp_millis()],
    )?;
    Ok(c.last_insert_rowid())
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
    c.execute(
        "DELETE FROM messages WHERE conversation_id = ?1",
        params![id],
    )?;
    c.execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn add_message(m: &MessageRow) -> AppResult<i64> {
    let c = conn()?;
    c.execute(
        "INSERT INTO messages (conversation_id, role, content, refined_content, images_json,
         params_json, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![
            m.conversation_id,
            m.role,
            m.content,
            m.refined_content,
            m.images_json,
            m.params_json,
            m.created_at
        ],
    )?;
    Ok(c.last_insert_rowid())
}

pub fn list_messages(conversation_id: i64) -> AppResult<Vec<MessageRow>> {
    let c = conn()?;
    let mut stmt = c.prepare(
        "SELECT id, conversation_id, role, content, refined_content, images_json,
         params_json, created_at FROM messages WHERE conversation_id = ?1 ORDER BY id",
    )?;
    let rows = stmt.query_map(params![conversation_id], |r| {
        Ok(MessageRow {
            id: r.get(0)?,
            conversation_id: r.get(1)?,
            role: r.get(2)?,
            content: r.get(3)?,
            refined_content: r.get(4)?,
            images_json: r.get(5)?,
            params_json: r.get(6)?,
            created_at: r.get(7)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

/// 可排序的毫秒时间戳（秒.毫秒格式），不依赖 chrono
pub fn timestamp_millis() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:03}", dur.as_secs(), dur.subsec_millis())
}

/// 回写消息的图片条目（仅在读路径惰性迁移触发时调用，见 image_store::enrich_image_entries）
pub fn update_message_images(id: i64, images_json: &str) -> AppResult<()> {
    conn()?.execute(
        "UPDATE messages SET images_json = ?2 WHERE id = ?1",
        params![id, images_json],
    )?;
    Ok(())
}

// 避免引入 hex crate 的小工具
mod hex {
    pub fn decode_inner(s: &str) -> Result<Vec<u8>, String> {
        if !s.len().is_multiple_of(2) {
            return Err("hex 长度异常".into());
        }
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| e.to_string()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 串行化所有改动 MOLING_MASTER_KEY_HEX 的测试（cargo test 默认多线程并行）
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn test_dir() -> PathBuf {
        std::env::temp_dir().join(format!("moling-test-{}", std::process::id()))
    }

    fn draft<'a>(
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
        }
    }

    #[test]
    fn mask_key_is_utf8_safe() {
        assert_eq!(mask_key("sk-test-1234567890"), "sk-t...7890");
        // 中文/多字节字符不按字节切片
        assert_eq!(mask_key("密钥甲乙丙丁戊己庚辛壬癸"), "密钥甲乙...庚辛壬癸");
        assert_eq!(mask_key("日本語のキーですよ"), "日本語の...ーですよ");
        // 短 Key 整体遮蔽
        assert_eq!(mask_key("short"), "****");
        assert_eq!(mask_key(""), "****");
        assert_eq!(mask_key("12345678"), "****");
        assert_eq!(mask_key("123456789"), "1234...6789");
    }

    #[test]
    fn timestamp_millis_format() {
        let ts = timestamp_millis();
        let (secs, millis) = ts.split_once('.').expect("秒.毫秒 格式");
        assert!(secs.parse::<u64>().is_ok());
        assert_eq!(millis.len(), 3);
    }

    #[test]
    fn master_key_env_var_path_and_errors() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var(MASTER_KEY_ENV, "aa".repeat(32));
        let enc = encrypt_secret("hello").expect("encrypt with env master key");
        assert_eq!(decrypt_secret(&enc).unwrap(), "hello");
        // 非法长度必须报错而不是生成新密钥
        std::env::set_var(MASTER_KEY_ENV, "abcd".repeat(10));
        assert!(encrypt_secret("x").is_err());
        std::env::remove_var(MASTER_KEY_ENV);
    }

    #[test]
    fn hex_key_parsing() {
        assert!(parse_hex_key(&"aa".repeat(32)).is_ok());
        assert!(parse_hex_key("zzzz").is_err());
        assert!(parse_hex_key("aabb").is_err()); // 长度不足 32 字节
    }

    /// 所有依赖全局 DB 的断言集中在一个测试中（DB 为进程级 OnceLock，无法重复 init）
    #[test]
    fn storage_roundtrip_key_safety_and_import_tx() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var(MASTER_KEY_ENV, "aa".repeat(32));
        let dir = test_dir();
        let _ = std::fs::remove_dir_all(&dir);
        init(dir.clone()).expect("init storage");

        let secret = "sk-test-1234567890";
        let row =
            save_provider(None, &draft("Mock 服务商", Some(secret), None)).expect("save provider");
        assert_eq!(row.api_key_masked, "sk-t...7890");
        assert!(row.has_key);
        assert!(!row.key_error);
        // 密文不应包含明文
        assert!(!row.api_key_enc.contains(secret));

        let decrypted = decrypt_secret(&row.api_key_enc).expect("decrypt");
        assert_eq!(decrypted, secret);

        let list = list_providers().expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "Mock 服务商");

        // 不传 Key 更新时保留旧密文
        let updated =
            save_provider(Some(row.id), &draft("改名", None, None)).expect("update without key");
        assert_eq!(decrypt_secret(&updated.api_key_enc).unwrap(), secret);
        assert_eq!(updated.timeout_secs, 60);

        // R2：主密钥变化后旧密文解密失败 → key_error 标记透出，而非静默空 Key
        std::env::set_var(MASTER_KEY_ENV, "bb".repeat(32));
        let broken = get_provider(row.id).expect("get").expect("row exists");
        assert!(broken.key_error);
        assert!(!broken.has_key);
        assert_eq!(broken.api_key_masked, "****");
        // 用当前主密钥重新加密后可恢复
        let re_saved =
            save_provider(Some(row.id), &draft("改名", Some(secret), None)).expect("re-save key");
        assert!(!re_saved.key_error);
        std::env::set_var(MASTER_KEY_ENV, "aa".repeat(32));

        // 设置项
        set_setting("defaultProviderId", "42").unwrap();
        assert_eq!(
            get_setting("defaultProviderId").unwrap().as_deref(),
            Some("42")
        );

        // R5：import_config 事务 + 替换语义 + extraParams 恢复
        set_setting(&format!("extraParams:{}", row.id), r#"{"steps":30}"#).unwrap();
        let data = serde_json::json!({
            "version": 1,
            "providers": [{
                "name": "导入的服务商",
                "baseUrl": "https://api.example.com",
                "apiKey": "sk-imported-0000",
                "kind": "openai",
                "modelsJson": "[\"m1\"]",
                "defaultModel": "m1",
                "timeoutSecs": 30,
                "templateUrl": "",
                "templateBody": "",
                "templateResponsePath": "",
                "extraParams": r#"{"quality":"high"}"#,
            }],
            "settings": { "defaultProviderId": "7" },
        });
        let count = import_config(&data).expect("import");
        assert_eq!(count, 1);
        let after = list_providers().unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].name, "导入的服务商");
        assert_eq!(after[0].timeout_secs, 30);
        // 旧服务商及其 extraParams 已随替换删除
        assert!(get_setting(&format!("extraParams:{}", row.id))
            .unwrap()
            .is_none());
        // 新服务商的 extraParams 已恢复
        assert_eq!(
            get_setting(&format!("extraParams:{}", after[0].id))
                .unwrap()
                .as_deref(),
            Some(r#"{"quality":"high"}"#)
        );
        assert_eq!(
            get_setting("defaultProviderId").unwrap().as_deref(),
            Some("7")
        );

        // 替换语义：导入空 providers 数组 = 清空全部服务商
        let empty = serde_json::json!({ "version": 1, "providers": [] });
        import_config(&empty).unwrap();
        assert!(list_providers().unwrap().is_empty());

        // 历史记录
        let hid = add_history(&HistoryRow {
            id: 0,
            prompt: "a cat".into(),
            negative_prompt: String::new(),
            model: "mock-draw-v1".into(),
            provider_name: "Mock".into(),
            seed: Some(7),
            width: 1024,
            height: 1024,
            guidance: 7.5,
            steps: 30,
            style: String::new(),
            file_path: "/tmp/x.png".into(),
            favorite: false,
            created_at: "1".into(),
        })
        .unwrap();
        let history = list_history(10, 0, "").unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].id, hid);
        assert_eq!(history[0].seed, Some(7));
        set_favorite(hid, true).unwrap();
        assert!(list_history(10, 0, "").unwrap()[0].favorite);
        let path = delete_history(hid).unwrap();
        assert_eq!(path.as_deref(), Some("/tmp/x.png"));
        assert!(list_history(10, 0, "").unwrap().is_empty());

        delete_provider(after[0].id).unwrap();
        assert!(list_providers().unwrap().is_empty());

        std::env::remove_var(MASTER_KEY_ENV);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
