use crate::error::{AppError, AppResult};
use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use base64::Engine;
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
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

/// 服务商 Key 列表中的一项。整组以 JSON 加密存于 `providers.api_keys_enc`；
/// `api_key_enc` 始终镜像首项，兼容旧代码/旧备份/思考模型复用路径。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderKey {
    pub key: String,
    #[serde(default)]
    pub invalid: bool,
    #[serde(default)]
    pub invalid_at: Option<String>,
}

impl ProviderKey {
    pub fn new(key: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            invalid: false,
            invalid_at: None,
        }
    }

    /// 备份恢复用：保留失效标记，时间戳记为导入时刻
    pub fn restored(key: impl Into<String>, invalid: bool) -> Self {
        Self {
            key: key.into(),
            invalid,
            invalid_at: if invalid {
                Some(timestamp_millis())
            } else {
                None
            },
        }
    }
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

/// 建表 SQL（迁移 001 的基线）。**发布后不要再改这里**：旧库已经跑过 001，
/// 后续结构变更请追加一条新的迁移，否则老库永远拿不到新列。
const SCHEMA_SQL: &str = "
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
";

/// 索引（迁移 002）。会话消息按 (conversation_id, id) 翻页、画廊按时间倒序、
/// 按模型过滤，都是高频路径；没有索引时数据量一上来就是全表扫。
const INDEXES_SQL: &str = "
        CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);
        CREATE INDEX IF NOT EXISTS idx_history_created ON history(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_history_model ON history(model);
";

/// 迁移 003：多 Key 列表密文。`api_key_enc` 保留为首 Key 的镜像列，
/// 存量单 Key 由 `backfill_provider_keys` 在迁移后幂等回填。
const PROVIDER_KEYS_SQL: &str = "
        ALTER TABLE providers ADD COLUMN api_keys_enc TEXT NOT NULL DEFAULT '';
";

/// 迁移 004：批量队列。所有状态迁移都必须带前置状态条件（见 jobs::transition_*），
/// 否则「取消」与「完成」并发时后写的一方会覆盖先写的终态。
const JOBS_SQL: &str = "
        CREATE TABLE IF NOT EXISTS jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            status TEXT NOT NULL DEFAULT 'queued',
            provider_id INTEGER NOT NULL,
            provider_name TEXT NOT NULL DEFAULT '',
            model TEXT NOT NULL DEFAULT '',
            prompt TEXT NOT NULL DEFAULT '',
            negative_prompt TEXT NOT NULL DEFAULT '',
            style TEXT NOT NULL DEFAULT '',
            width INTEGER NOT NULL DEFAULT 1024,
            height INTEGER NOT NULL DEFAULT 1024,
            guidance REAL,
            steps INTEGER,
            seed INTEGER,
            count INTEGER NOT NULL DEFAULT 1,
            job_key TEXT NOT NULL DEFAULT '',
            images_json TEXT NOT NULL DEFAULT '[]',
            error TEXT,
            created_at TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, id);
";

/// (名称, SQL)，按顺序执行；`PRAGMA user_version` 记录已应用到的序号（从 1 起）。
const MIGRATIONS: &[(&str, &str)] = &[
    ("001_tables", SCHEMA_SQL),
    ("002_indexes", INDEXES_SQL),
    ("003_provider_keys", PROVIDER_KEYS_SQL),
    ("004_jobs", JOBS_SQL),
];

/// 当前 schema 版本 = 迁移条数
const SCHEMA_VERSION: i64 = MIGRATIONS.len() as i64;

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

fn current_version(conn: &Connection) -> AppResult<i64> {
    Ok(conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}

fn table_missing(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![name],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n == 0)
    .unwrap_or(true)
}

fn backup_before_migration(db_path: &std::path::Path) {
    let ts = timestamp_millis().replace('.', "-");
    let backup = db_path.with_file_name(format!("moling.db.bak-migrate-{ts}"));
    match std::fs::copy(db_path, &backup) {
        Ok(bytes) => tracing::warn!("数据库迁移前已备份到 {}（{bytes} 字节）", backup.display()),
        Err(e) => tracing::warn!("数据库迁移前备份失败（{e}），继续迁移"),
    }
}

pub(crate) fn apply_migrations(conn: &mut Connection) -> AppResult<()> {
    apply_migrations_with(conn, MIGRATIONS)
}

/// 每条迁移单独一个事务：失败即回滚该步，且不推进 user_version（下次启动重试）。
fn apply_migrations_with(conn: &mut Connection, migrations: &[(&str, &str)]) -> AppResult<()> {
    for (i, (name, sql)) in migrations.iter().enumerate() {
        let target = (i + 1) as i64;
        if target <= current_version(conn)? {
            continue;
        }
        let tx = conn.transaction()?;
        tx.execute_batch(sql)
            .map_err(|e| AppError::Other(format!("迁移 {name} 失败: {e}")))?;
        tx.pragma_update(None, "user_version", target)?;
        tx.commit()?;
        tracing::info!("已应用数据库迁移 {name}（schema v{target}）");
    }
    Ok(())
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
        // 元数据与 Key 列表同事务写入：避免「编辑资料 + 换主 Key」中途失败留下两列不一致
        let mut c = conn()?;
        let tx = c.transaction()?;
        let id = match id {
            Some(existing) => {
                let n = tx.execute(
                    "UPDATE providers SET name=?1, base_url=?2, kind=?3, models_json=?4,
                     default_model=?5, timeout_secs=?6, template_url=?7, template_body=?8,
                     template_response_path=?9 WHERE id=?10",
                    params![
                        draft.name,
                        draft.base_url,
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
                if n == 0 {
                    return Err(AppError::NotFound(format!("服务商 #{existing} 不存在")));
                }
                existing
            }
            None => {
                // Key 统一由下面的 replace_first 逻辑写两列，这里先落空密文
                let enc = encrypt_secret("")?;
                tx.execute(
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
                tx.last_insert_rowid()
            }
        };
        // 未填新 Key 时保持整组 Key 与密文原样，避免解密失败的旧数据在纯改资料时被清空
        if let Some(new_key) = draft.api_key {
            let (keys_enc, legacy_enc): (String, String) = tx.query_row(
                "SELECT api_keys_enc, api_key_enc FROM providers WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            // 主密钥变化后旧密文解不开：按用户新填的 Key 重建列表，而不是让保存失败
            let mut keys = decode_keys(&keys_enc, &legacy_enc).unwrap_or_else(|e| {
                tracing::warn!("保存服务商时旧 Key 解密失败，按新 Key 重建列表: {e}");
                Vec::new()
            });
            if keys.is_empty() {
                keys.push(ProviderKey::new(new_key));
            } else {
                keys[0] = ProviderKey::new(new_key);
            }
            write_keys_tx(&tx, id, &keys)?;
        }
        tx.commit()?;
        id
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

/// 优先读 Key 列表密文；为空时回退旧单 Key 列（迁移回填完成前/旧备份导入后）。
fn decode_keys(keys_enc: &str, legacy_enc: &str) -> AppResult<Vec<ProviderKey>> {
    if !keys_enc.trim().is_empty() {
        let plain = decrypt_secret(keys_enc)?;
        let mut keys: Vec<ProviderKey> = serde_json::from_str(&plain)
            .map_err(|e| AppError::Crypto(format!("Key 列表解析失败: {e}")))?;
        keys.retain(|k| !k.key.trim().is_empty());
        return Ok(keys);
    }
    if legacy_enc.trim().is_empty() {
        return Ok(Vec::new());
    }
    let key = decrypt_secret(legacy_enc)?;
    Ok(if key.trim().is_empty() {
        Vec::new()
    } else {
        vec![ProviderKey::new(key)]
    })
}

/// 返回 (Key 列表密文, 首 Key 密文)；空列表两列都写空串。
fn encode_keys(keys: &[ProviderKey]) -> AppResult<(String, String)> {
    if keys.is_empty() {
        return Ok((String::new(), String::new()));
    }
    let json = serde_json::to_string(keys).map_err(|e| AppError::Other(e.to_string()))?;
    Ok((encrypt_secret(&json)?, encrypt_secret(&keys[0].key)?))
}

fn write_keys_tx(tx: &rusqlite::Transaction<'_>, id: i64, keys: &[ProviderKey]) -> AppResult<()> {
    let (keys_enc, first_enc) = encode_keys(keys)?;
    let n = tx.execute(
        "UPDATE providers SET api_keys_enc = ?1, api_key_enc = ?2 WHERE id = ?3",
        params![keys_enc, first_enc, id],
    )?;
    if n == 0 {
        return Err(AppError::NotFound(format!("服务商 #{id} 不存在")));
    }
    Ok(())
}

pub fn load_provider_keys(id: i64) -> AppResult<Vec<ProviderKey>> {
    let c = conn()?;
    let (keys_enc, legacy_enc): (String, String) = c
        .query_row(
            "SELECT api_keys_enc, api_key_enc FROM providers WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("服务商 #{id} 不存在")))?;
    decode_keys(&keys_enc, &legacy_enc)
}

/// 读 → 改 → 写在同一事务内，避免并发生成标记失效与 UI 增删 Key 互相覆盖。
fn mutate_keys<F>(id: i64, f: F) -> AppResult<Vec<ProviderKey>>
where
    F: FnOnce(&mut Vec<ProviderKey>) -> AppResult<()>,
{
    let mut c = conn()?;
    let tx = c.transaction()?;
    let (keys_enc, legacy_enc): (String, String) = tx
        .query_row(
            "SELECT api_keys_enc, api_key_enc FROM providers WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("服务商 #{id} 不存在")))?;
    let mut keys = decode_keys(&keys_enc, &legacy_enc)?;
    f(&mut keys)?;
    write_keys_tx(&tx, id, &keys)?;
    tx.commit()?;
    Ok(keys)
}

pub fn add_provider_key(id: i64, key: &str) -> AppResult<()> {
    let key = key.trim();
    if key.is_empty() {
        return Err(AppError::Other("Key 不能为空".into()));
    }
    mutate_keys(id, |keys| {
        if keys.iter().any(|k| k.key == key) {
            return Err(AppError::Other("该 Key 已存在".into()));
        }
        keys.push(ProviderKey::new(key));
        Ok(())
    })
    .map(|_| ())
}

pub fn delete_provider_key(id: i64, index: usize) -> AppResult<()> {
    mutate_keys(id, |keys| {
        if index >= keys.len() {
            return Err(AppError::NotFound("Key 序号不存在".into()));
        }
        keys.remove(index);
        Ok(())
    })
    .map(|_| ())
}

/// 标记/恢复单个 Key 的失效状态；序号越界时静默忽略（轮换与删除存在竞态）。
pub fn mark_key_invalid(id: i64, index: usize, invalid: bool) -> AppResult<()> {
    mutate_keys(id, |keys| {
        if let Some(key) = keys.get_mut(index) {
            key.invalid = invalid;
            key.invalid_at = if invalid {
                Some(timestamp_millis())
            } else {
                None
            };
        }
        Ok(())
    })
    .map(|_| ())
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

/// 删除设置项（不存在时静默成功）。用于清理指向已删除服务商的 defaultProviderId。
pub fn delete_setting(key: &str) -> AppResult<()> {
    conn()?.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
    Ok(())
}

/// 当前代码期望的 schema 版本（诊断包用）
pub fn schema_version() -> i64 {
    SCHEMA_VERSION
}

/// 各业务表行数（诊断包用）。表名取自 sqlite_master，随迁移自动扩展。
pub fn table_row_counts() -> AppResult<Vec<(String, i64)>> {
    let c = conn()?;
    let names: Vec<String> = {
        let mut stmt = c.prepare(
            "SELECT name FROM sqlite_master
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let mut out = Vec::new();
    for name in names {
        // 表名来自 sqlite_master 而非用户输入，拼接安全
        let n: i64 = c.query_row(&format!("SELECT COUNT(*) FROM \"{name}\""), [], |r| {
            r.get(0)
        })?;
        out.push((name, n));
    }
    Ok(out)
}

/// 取导入文件中的 providers 数组；缺失或类型不对直接报错。
/// 必须在任何 DELETE 之前调用（P0-2：否则会先清空用户旧配置再报错/静默成功）。
fn require_providers(data: &serde_json::Value) -> AppResult<&[serde_json::Value]> {
    data.get("providers")
        .and_then(|p| p.as_array())
        .map(|p| p.as_slice())
        .ok_or_else(|| AppError::Other("导入文件缺少 providers 数组，已取消导入".into()))
}

/// 导入时允许写入的设置项。v1 只有旧版导出的两项；v2 增加主题与自定义模板。
const IMPORT_SETTINGS_V1: &[&str] = &["defaultProviderId", "defaultParams"];
const IMPORT_SETTINGS_V2: &[&str] = &[
    "defaultProviderId",
    "defaultParams",
    "theme",
    "promptTemplates",
];

fn invalid_import(msg: &str) -> AppError {
    AppError::Other(format!("{msg}，已取消导入"))
}

/// v2 新增设置项的结构校验，必须在事务与 DELETE 之前调用。
fn validate_import_settings(
    settings: Option<&serde_json::Map<String, serde_json::Value>>,
    version: u64,
) -> AppResult<()> {
    let Some(settings) = settings else {
        return Ok(());
    };
    // v1 导出没有这些字段，保持原有的宽松导入行为
    if version < 2 {
        return Ok(());
    }
    if let Some(theme) = settings.get("theme") {
        let ok = theme
            .as_str()
            .is_some_and(|t| matches!(t, "system" | "light" | "dark"));
        if !ok {
            return Err(invalid_import("导入文件中的主题取值非法"));
        }
    }
    if let Some(templates) = settings.get("promptTemplates") {
        validate_import_templates(templates)?;
    }
    Ok(())
}

/// 自定义模板在 settings 中以 JSON 字符串保存，必须是 `[{id,title,text}]` 数组。
fn validate_import_templates(value: &serde_json::Value) -> AppResult<()> {
    let raw = value
        .as_str()
        .ok_or_else(|| invalid_import("自定义模板必须是 JSON 字符串"))?;
    let parsed: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| invalid_import("自定义模板不是合法 JSON"))?;
    let list = parsed
        .as_array()
        .ok_or_else(|| invalid_import("自定义模板必须是数组"))?;
    for item in list {
        let obj = item
            .as_object()
            .ok_or_else(|| invalid_import("自定义模板项必须是对象"))?;
        for key in ["id", "title", "text"] {
            let ok = obj
                .get(key)
                .and_then(|v| v.as_str())
                .is_some_and(|s| !s.trim().is_empty());
            if !ok {
                return Err(invalid_import("自定义模板项缺少 id/title/text"));
            }
        }
    }
    Ok(())
}

/// v3 Key 列表与失效标记的格式校验，与其余导入校验一样在事务与 DELETE 之前执行。
fn validate_import_keys(providers: &[serde_json::Value], version: u64) -> AppResult<()> {
    if version < 3 {
        return Ok(());
    }
    for p in providers {
        if let Some(keys) = p.get("apiKeys") {
            let list = keys
                .as_array()
                .ok_or_else(|| invalid_import("apiKeys 必须是数组"))?;
            if list.iter().any(|k| !k.is_string()) {
                return Err(invalid_import("apiKeys 只能包含字符串"));
            }
        }
        if let Some(indexes) = p.get("invalidKeyIndexes") {
            let list = indexes
                .as_array()
                .ok_or_else(|| invalid_import("invalidKeyIndexes 必须是数组"))?;
            if list.iter().any(|v| v.as_u64().is_none()) {
                return Err(invalid_import("invalidKeyIndexes 只能包含整数"));
            }
        }
    }
    Ok(())
}

/// 从导入项取出整组 Key：优先 v3 `apiKeys`，兼容 v1/v2 单个 `apiKey`。
/// 失效标记按 `apiKeys` 原始下标给出，过滤空串后下标仍对应原数组。
fn import_keys(p: &serde_json::Value) -> Vec<ProviderKey> {
    let invalid: HashSet<usize> = p
        .get("invalidKeyIndexes")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_u64())
                .map(|n| n as usize)
                .collect()
        })
        .unwrap_or_default();
    let mut keys = Vec::new();
    let mut seen = HashSet::new();
    let mut push = |key: &str, index: usize| {
        let key = key.trim();
        if !key.is_empty() && seen.insert(key.to_string()) {
            keys.push(ProviderKey::restored(key, invalid.contains(&index)));
        }
    };
    match p.get("apiKeys").and_then(|v| v.as_array()) {
        Some(list) => {
            for (i, v) in list.iter().enumerate() {
                push(v.as_str().unwrap_or_default(), i);
            }
        }
        None => {
            if let Some(single) = p.get("apiKey").and_then(|v| v.as_str()) {
                push(single, 0);
            }
        }
    }
    keys
}

fn validate_import_thinking(value: &serde_json::Value) -> AppResult<()> {
    let obj = value
        .as_object()
        .ok_or_else(|| invalid_import("思考模型配置必须是对象"))?;
    if obj.get("enabled").is_some_and(|v| !v.is_boolean()) {
        return Err(invalid_import("思考模型 enabled 必须是布尔值"));
    }
    if let Some(mode) = obj.get("mode") {
        let ok = mode
            .as_str()
            .is_some_and(|m| matches!(m, "standalone" | "reuse"));
        if !ok {
            return Err(invalid_import("思考模型 mode 只能是 standalone 或 reuse"));
        }
    }
    if let Some(pid) = obj.get("providerId") {
        if !(pid.is_null() || pid.as_i64().is_some()) {
            return Err(invalid_import("思考模型 providerId 必须是整数或 null"));
        }
    }
    for key in ["baseUrl", "model"] {
        if obj.get(key).is_some_and(|v| v.as_str().is_none()) {
            return Err(invalid_import("思考模型配置字段类型非法"));
        }
    }
    Ok(())
}

/// v3 代理配置校验：只接受非密钥字段，手动代理必须带可解析的 http(s) 地址。
fn validate_import_network(value: &serde_json::Value) -> AppResult<()> {
    let obj = value
        .as_object()
        .ok_or_else(|| invalid_import("network 必须是对象"))?;
    let mode = obj.get("mode").and_then(|v| v.as_str()).unwrap_or("system");
    if !matches!(mode, "system" | "direct" | "manual") {
        return Err(invalid_import("代理模式只能是 system/direct/manual"));
    }
    for key in ["url", "noProxy"] {
        if obj.get(key).is_some_and(|v| !v.is_string()) {
            return Err(invalid_import("代理配置字段类型非法"));
        }
    }
    if mode == "manual" {
        let url = obj
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim();
        let parsed = reqwest::Url::parse(url).map_err(|_| invalid_import("代理地址无效"))?;
        let has_host = !parsed.host_str().unwrap_or_default().is_empty();
        if !matches!(parsed.scheme(), "http" | "https") || !has_host {
            return Err(invalid_import("代理地址无效"));
        }
    }
    Ok(())
}

/// 写入导入的代理配置：密码/用户名不随备份走，代理地址未变时沿用本机凭据，
/// 换地址则清空，避免把旧密码发到新代理上。
fn import_network(tx: &rusqlite::Transaction<'_>, value: &serde_json::Value) -> AppResult<()> {
    use crate::adapters::http::{ProxyConfig, PROXY_SETTING_KEY};
    let obj = value.as_object().expect("代理配置已在事务前校验为对象");
    let url = obj.get("url").and_then(|v| v.as_str()).unwrap_or_default();
    let old = tx
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![PROXY_SETTING_KEY],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .map(|raw| ProxyConfig::from_stored(Some(&raw)))
        .filter(|cfg| cfg.url == url);
    let cfg = ProxyConfig {
        mode: obj
            .get("mode")
            .and_then(|v| v.as_str())
            .unwrap_or("system")
            .to_string(),
        url: url.to_string(),
        username: old.as_ref().map(|o| o.username.clone()).unwrap_or_default(),
        password_enc: old
            .as_ref()
            .map(|o| o.password_enc.clone())
            .unwrap_or_default(),
        no_proxy: obj
            .get("noProxy")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
    };
    let json = serde_json::to_string(&cfg).map_err(|e| AppError::Other(e.to_string()))?;
    tx.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![PROXY_SETTING_KEY, json],
    )?;
    Ok(())
}

/// 事务内导入配置（替换语义，R5）：先清空旧 providers 及其 extraParams 设置项，
/// 再写入全部导入内容；中途任何失败整体回滚，不留半导入状态。
/// `data` 为前端导出的 JSON（version 校验由调用方完成），返回导入的服务商数量。
pub fn import_config(data: &serde_json::Value) -> AppResult<usize> {
    let mut c = conn()?;
    import_config_in(&mut c, data)
}

/// import_config 的可测接缝：在给定连接上执行导入（单测用内存库，避免共享全局 DB）。
/// 入参校验放在事务与 DELETE 之前，非法导入绝不触碰表内旧数据。
fn import_config_in(c: &mut Connection, data: &serde_json::Value) -> AppResult<usize> {
    let version = data.get("version").and_then(|v| v.as_u64()).unwrap_or(1);
    let providers = require_providers(data)?;
    let settings = match data.get("settings") {
        Some(v) => {
            let obj = v.as_object();
            if version >= 2 && obj.is_none() {
                return Err(invalid_import("导入文件中的 settings 必须是对象"));
            }
            obj
        }
        None => None,
    };
    validate_import_settings(settings, version)?;
    let thinking = if version >= 2 {
        data.get("thinking")
    } else {
        None
    };
    if let Some(t) = thinking {
        validate_import_thinking(t)?;
    }
    validate_import_keys(providers, version)?;
    if version >= 3 {
        if let Some(net) = data.get("network") {
            validate_import_network(net)?;
        }
    }

    let tx = c.transaction()?;
    // v2/v3 默认不导出明文 Key：删除前记录旧密文，导入项无 Key 且
    // name+baseUrl 一致时复用，避免「不含 Key 的备份」在换机/回滚时清空密钥。
    let old_keys: HashMap<(String, String), (String, String)> = {
        let mut stmt =
            tx.prepare("SELECT name, base_url, api_keys_enc, api_key_enc FROM providers")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                (r.get::<_, String>(0)?, r.get::<_, String>(1)?),
                (r.get::<_, String>(2)?, r.get::<_, String>(3)?),
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?.into_iter().collect()
    };
    // thinkingConfig 不参与替换，但 v2 导出从不含 Key，导入时必须沿用本机密文
    let old_thinking_enc = if thinking.is_some() {
        tx.query_row(
            "SELECT value FROM settings WHERE key = 'thinkingConfig'",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| {
            v.get("apiKeyEnc")
                .and_then(|s| s.as_str())
                .map(str::to_string)
        })
        .unwrap_or_default()
    } else {
        String::new()
    };

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
    // 导出时的旧服务商 id → 导入后的新 id（自增 id 会变，设置项需据此重映射）
    let mut id_map: HashMap<i64, i64> = HashMap::new();
    for p in providers {
        let get = |k: &str| {
            p.get(k)
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string()
        };
        let name = get("name");
        let base_url = get("baseUrl");
        // v3 带整组 Key；v1/v2 只有单个 apiKey；都没有时沿用本机旧密文（含整组列表）
        let keys = import_keys(p);
        let (keys_enc, enc) = if keys.is_empty() {
            match old_keys.get(&(name.clone(), base_url.clone())) {
                Some((old_keys_enc, old_enc)) => (old_keys_enc.clone(), old_enc.clone()),
                None => (String::new(), encrypt_secret("")?),
            }
        } else {
            encode_keys(&keys)?
        };
        tx.execute(
            "INSERT INTO providers (name, base_url, api_key_enc, api_keys_enc, kind, models_json,
             default_model, timeout_secs, template_url, template_body, template_response_path)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                name,
                base_url,
                enc,
                keys_enc,
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
        // 仅新版导出（provider 带整数 id）才能建立旧→新映射；旧导出无 id 则无从映射
        if let Some(old_id) = p.get("id").and_then(|v| v.as_i64()) {
            id_map.insert(old_id, new_id);
        }
        // 恢复透传参数（extraParams 存于 settings KV，导入时必须一并恢复）
        if let Some(ep) = p.get("extraParams").and_then(|v| v.as_str()) {
            tx.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![format!("extraParams:{new_id}"), ep],
            )?;
        }
    }
    if let Some(settings) = settings {
        let allowed = if version >= 2 {
            IMPORT_SETTINGS_V2
        } else {
            IMPORT_SETTINGS_V1
        };
        for k in allowed {
            let Some(value) = settings.get(*k).and_then(|v| v.as_str()) else {
                continue;
            };
            // P0-2：defaultProviderId 存的是服务商 id，导入后 id 已变，必须重映射；
            // 无法映射（旧格式导出 / 指向不存在的服务商）时删除该设置，避免默认服务商悬空
            if *k == "defaultProviderId" {
                let mapped = value
                    .trim()
                    .parse::<i64>()
                    .ok()
                    .and_then(|old_id| id_map.get(&old_id).copied());
                match mapped {
                    Some(new_id) => {
                        tx.execute(
                            "INSERT INTO settings (key, value) VALUES (?1, ?2)
                             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                            params![k, new_id.to_string()],
                        )?;
                    }
                    None => {
                        tx.execute("DELETE FROM settings WHERE key = ?1", params![k])?;
                        tracing::warn!(
                            "配置导入：defaultProviderId={value} 无法映射到导入后的服务商，已清除该设置"
                        );
                    }
                }
                continue;
            }
            tx.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![k, value],
            )?;
        }
    }
    // 思考模型：只覆盖导出的非密钥字段，providerId 按 id_map 重映射，密文沿用本机
    if let Some(t) = thinking {
        let obj = t.as_object().expect("思考模型配置已在事务前校验为对象");
        let old_pid = obj.get("providerId").and_then(|v| v.as_i64());
        let provider_id = old_pid.and_then(|old| id_map.get(&old).copied());
        if old_pid.is_some() && provider_id.is_none() {
            tracing::warn!("配置导入：思考模型 providerId 无法映射到导入后的服务商，已清空");
        }
        let value = serde_json::json!({
            "enabled": obj.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false),
            "mode": obj.get("mode").and_then(|v| v.as_str()).unwrap_or("reuse"),
            "providerId": provider_id,
            "baseUrl": obj.get("baseUrl").and_then(|v| v.as_str()).unwrap_or_default(),
            "apiKeyEnc": old_thinking_enc,
            "model": obj.get("model").and_then(|v| v.as_str()).unwrap_or_default(),
        });
        tx.execute(
            "INSERT INTO settings (key, value) VALUES ('thinkingConfig', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![value.to_string()],
        )?;
    }
    // v3 备份携带代理的非密钥字段；密码与用户名留在本机
    if version >= 3 {
        if let Some(net) = data.get("network") {
            import_network(&tx, net)?;
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

pub fn list_history(
    limit: i64,
    offset: i64,
    model_filter: &str,
    style_filter: &str,
) -> AppResult<Vec<HistoryRow>> {
    let c = conn()?;
    let mut conditions = Vec::new();
    if !model_filter.is_empty() {
        conditions.push("model = ?");
    }
    if !style_filter.is_empty() {
        conditions.push("style = ?");
    }
    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };
    let sql = format!(
        "SELECT id, prompt, negative_prompt, model, provider_name, seed, width, height,
         guidance, steps, style, file_path, favorite, created_at
         FROM history{where_clause} ORDER BY id DESC LIMIT ? OFFSET ?"
    );
    let mut stmt = c.prepare(&sql)?;
    let mut values: Vec<&dyn rusqlite::ToSql> = Vec::new();
    if !model_filter.is_empty() {
        values.push(&model_filter);
    }
    if !style_filter.is_empty() {
        values.push(&style_filter);
    }
    values.push(&limit);
    values.push(&offset);
    let rows = stmt.query_map(values.as_slice(), history_from_row)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

/// 画廊记录的原图路径（get_history_image 用）；记录不存在返回 None
pub fn history_file_path(id: i64) -> AppResult<Option<String>> {
    let c = conn()?;
    let mut stmt = c.prepare("SELECT file_path FROM history WHERE id = ?1")?;
    let mut rows = stmt.query_map(params![id], |r| r.get(0))?;
    Ok(rows.next().transpose()?)
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

/// 文件删除决策：调用方据此决定是否回收磁盘文件。
pub struct HistoryDeletion {
    pub file_path: Option<String>,
    /// true = 仍有 messages 或其它 history 行引用该文件，**不得删除文件**
    pub still_referenced: bool,
}

pub fn delete_history(id: i64) -> AppResult<HistoryDeletion> {
    let c = conn()?;
    delete_history_in(&c, id)
}

/// 先删行、再取引用集合：被删的那一行不能为文件"自我担保"，
/// 否则任何删除都会被判定为"仍被引用"。整个过程在一个事务内，
/// 避免与并发的消息写入交错导致漏判。
pub(crate) fn delete_history_in(c: &Connection, id: i64) -> AppResult<HistoryDeletion> {
    let tx = c.unchecked_transaction()?;
    let path: Option<String> = tx
        .query_row(
            "SELECT file_path FROM history WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .ok();
    tx.execute("DELETE FROM history WHERE id = ?1", params![id])?;
    let still_referenced = match path.as_deref() {
        Some(p) if !p.is_empty() => {
            collect_referenced_paths_in(&tx)?.contains(&normalize_path_key(p))
        }
        _ => false,
    };
    tx.commit()?;
    Ok(HistoryDeletion {
        file_path: path,
        still_referenced,
    })
}

/// 路径比较键：分隔符统一为 `\`、忽略大小写。
///
/// Windows 上同一文件可能写成 `C:/a/b.png` 或 `c:\A\B.PNG`，直接字符串比较
/// 会漏判"仍被引用"，进而误删聊天里正在显示的图。
pub(crate) fn normalize_path_key(p: &str) -> String {
    p.trim().replace('/', "\\").to_lowercase()
}

/// 引用集合 = `history.file_path` ∪ `messages.images_json[].path`。
///
/// 用 JSON 结构化解析而不是 LIKE：JSON 里的 Windows 路径是转义双反斜杠，
/// LIKE 匹配不上；子串匹配还会让 `a.png` 命中 `xa.png`。
/// `CASE + json_valid` 是必需的：`json_each` 遇到坏 JSON 会让整条查询报错，
/// 一行脏数据就能让回收链路全线失效。
pub(crate) fn collect_referenced_paths_in(c: &Connection) -> AppResult<HashSet<String>> {
    const SQL: &str = "
        SELECT file_path FROM history WHERE file_path <> ''
        UNION
        SELECT json_extract(j.value, '$.path')
        FROM messages m
        JOIN json_each(CASE WHEN json_valid(m.images_json)
                            THEN m.images_json ELSE '[]' END) AS j
        WHERE json_type(j.value, '$.path') = 'text'
    ";
    let mut stmt = c.prepare(SQL)?;
    let rows = stmt.query_map([], |r| r.get::<_, Option<String>>(0))?;
    let mut out = HashSet::new();
    for row in rows {
        if let Some(p) = row? {
            let key = normalize_path_key(&p);
            if !key.is_empty() {
                out.insert(key);
            }
        }
    }
    Ok(out)
}

/// 供启动扫描使用的快照入口：内部短暂持锁，返回后即释放，
/// 扫描线程不在遍历磁盘期间占用数据库锁。
pub(crate) fn referenced_image_paths_snapshot() -> AppResult<HashSet<String>> {
    let c = conn()?;
    collect_referenced_paths_in(&c)
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
         params_json, created_at FROM messages
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
            })
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::from)?;
    let has_more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    rows.reverse();
    Ok((rows, has_more))
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

// ---------------------------------------------------------------------------
// 批量队列（迁移 004）
// ---------------------------------------------------------------------------

/// 终态：到达这些状态的 job 不会被 worker 再次取用。
pub const JOB_TERMINAL_STATUSES: &[&str] = &["done", "failed", "canceled", "interrupted"];

const JOB_COLUMNS: &str = "id, status, provider_id, provider_name, model, prompt, \
     negative_prompt, style, width, height, guidance, steps, seed, count, job_key, \
     images_json, error, created_at, started_at, finished_at";

/// 队列任务。`images_json` 只存 `[{historyId,path}]`，绝不存 base64。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRow {
    pub id: i64,
    pub status: String,
    pub provider_id: i64,
    pub provider_name: String,
    pub model: String,
    pub prompt: String,
    pub negative_prompt: String,
    pub style: String,
    pub width: i64,
    pub height: i64,
    pub guidance: Option<f64>,
    pub steps: Option<i64>,
    pub seed: Option<i64>,
    pub count: i64,
    /// 取消注册表键（`queue:<id>`），worker 与 cancel_queue_job 共用
    pub job_key: String,
    pub images_json: String,
    pub error: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

/// 入队参数快照（入队后不再与聊天输入联动）
pub struct NewJob<'a> {
    pub provider_id: i64,
    pub provider_name: &'a str,
    pub model: &'a str,
    pub prompt: &'a str,
    pub negative_prompt: &'a str,
    pub style: &'a str,
    pub width: i64,
    pub height: i64,
    pub guidance: Option<f64>,
    pub steps: Option<i64>,
    pub seed: Option<i64>,
    pub count: i64,
}

fn job_from_row(row: &rusqlite::Row) -> rusqlite::Result<JobRow> {
    Ok(JobRow {
        id: row.get(0)?,
        status: row.get(1)?,
        provider_id: row.get(2)?,
        provider_name: row.get(3)?,
        model: row.get(4)?,
        prompt: row.get(5)?,
        negative_prompt: row.get(6)?,
        style: row.get(7)?,
        width: row.get(8)?,
        height: row.get(9)?,
        guidance: row.get(10)?,
        steps: row.get(11)?,
        seed: row.get(12)?,
        count: row.get(13)?,
        job_key: row.get(14)?,
        images_json: row.get(15)?,
        error: row.get(16)?,
        created_at: row.get(17)?,
        started_at: row.get(18)?,
        finished_at: row.get(19)?,
    })
}

pub fn insert_job(job: &NewJob) -> AppResult<i64> {
    let c = conn()?;
    insert_job_in(&c, job)
}

fn insert_job_in(c: &Connection, job: &NewJob) -> AppResult<i64> {
    c.execute(
        "INSERT INTO jobs (status, provider_id, provider_name, model, prompt, negative_prompt,
         style, width, height, guidance, steps, seed, count, created_at)
         VALUES ('queued', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            job.provider_id,
            job.provider_name,
            job.model,
            job.prompt,
            job.negative_prompt,
            job.style,
            job.width,
            job.height,
            job.guidance,
            job.steps,
            job.seed,
            job.count,
            timestamp_millis(),
        ],
    )?;
    Ok(c.last_insert_rowid())
}

/// 取消注册表键固定在 id 生成后写入（`queue:<id>`），保证重启后仍可取消
pub fn set_job_key(id: i64, key: &str) -> AppResult<()> {
    conn()?.execute(
        "UPDATE jobs SET job_key = ?2 WHERE id = ?1",
        params![id, key],
    )?;
    Ok(())
}

pub fn get_job(id: i64) -> AppResult<Option<JobRow>> {
    let c = conn()?;
    get_job_in(&c, id)
}

fn get_job_in(c: &Connection, id: i64) -> AppResult<Option<JobRow>> {
    let sql = format!("SELECT {JOB_COLUMNS} FROM jobs WHERE id = ?1");
    Ok(c.query_row(&sql, params![id], job_from_row).optional()?)
}

pub fn list_jobs() -> AppResult<Vec<JobRow>> {
    let c = conn()?;
    let sql = format!("SELECT {JOB_COLUMNS} FROM jobs ORDER BY id DESC");
    let mut stmt = c.prepare(&sql)?;
    let rows = stmt.query_map([], job_from_row)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

/// 各状态计数（含数量为 0 的状态由调用方补齐）
pub fn job_counts() -> AppResult<Vec<(String, i64)>> {
    let c = conn()?;
    let mut stmt = c.prepare("SELECT status, COUNT(*) FROM jobs GROUP BY status")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

pub fn next_queued_job() -> AppResult<Option<JobRow>> {
    let c = conn()?;
    next_queued_job_in(&c)
}

fn next_queued_job_in(c: &Connection) -> AppResult<Option<JobRow>> {
    let sql =
        format!("SELECT {JOB_COLUMNS} FROM jobs WHERE status = 'queued' ORDER BY id ASC LIMIT 1");
    Ok(c.query_row(&sql, [], job_from_row).optional()?)
}

/// queued → running。返回 false 表示该 job 已被取消/被其它 worker 取走。
pub fn start_job(id: i64) -> AppResult<bool> {
    let c = conn()?;
    start_job_in(&c, id)
}

fn start_job_in(c: &Connection, id: i64) -> AppResult<bool> {
    let affected = c.execute(
        "UPDATE jobs SET status = 'running', started_at = ?2 WHERE id = ?1 AND status = 'queued'",
        params![id, timestamp_millis()],
    )?;
    Ok(affected > 0)
}

/// running → 终态。只允许从 running 迁移，防止已 canceled 的行被 done 覆盖。
pub fn finish_job(
    id: i64,
    status: &str,
    images_json: &str,
    error: Option<&str>,
) -> AppResult<bool> {
    let c = conn()?;
    finish_job_in(&c, id, status, images_json, error)
}

fn finish_job_in(
    c: &Connection,
    id: i64,
    status: &str,
    images_json: &str,
    error: Option<&str>,
) -> AppResult<bool> {
    debug_assert!(JOB_TERMINAL_STATUSES.contains(&status));
    let affected = c.execute(
        "UPDATE jobs SET status = ?2, images_json = ?3, error = ?4, finished_at = ?5
         WHERE id = ?1 AND status = 'running'",
        params![id, status, images_json, error, timestamp_millis()],
    )?;
    Ok(affected > 0)
}

/// queued → canceled（立即生效，worker 不会再来取）。
pub fn cancel_queued_job(id: i64) -> AppResult<bool> {
    let c = conn()?;
    cancel_queued_job_in(&c, id)
}

fn cancel_queued_job_in(c: &Connection, id: i64) -> AppResult<bool> {
    let affected = c.execute(
        "UPDATE jobs SET status = 'canceled', finished_at = ?2 WHERE id = ?1 AND status = 'queued'",
        params![id, timestamp_millis()],
    )?;
    Ok(affected > 0)
}

/// 失败/取消/中断的任务重新入队（清空上次的错误与结果）。
pub fn requeue_job(id: i64) -> AppResult<bool> {
    let c = conn()?;
    requeue_job_in(&c, id)
}

fn requeue_job_in(c: &Connection, id: i64) -> AppResult<bool> {
    let affected = c.execute(
        "UPDATE jobs SET status = 'queued', error = NULL, images_json = '[]',
         started_at = NULL, finished_at = NULL
         WHERE id = ?1 AND status IN ('failed', 'canceled', 'interrupted')",
        params![id],
    )?;
    Ok(affected > 0)
}

/// 启动时把上次残留的 running 标为 interrupted：不自动重跑，避免重启即扣费。
pub fn mark_running_interrupted() -> AppResult<usize> {
    let c = conn()?;
    mark_running_interrupted_in(&c)
}

fn mark_running_interrupted_in(c: &Connection) -> AppResult<usize> {
    Ok(c.execute(
        "UPDATE jobs SET status = 'interrupted', finished_at = ?1 WHERE status = 'running'",
        params![timestamp_millis()],
    )?)
}

/// 清空终态任务，返回删除行数
pub fn clear_finished_jobs() -> AppResult<usize> {
    let c = conn()?;
    clear_finished_jobs_in(&c)
}

fn clear_finished_jobs_in(c: &Connection) -> AppResult<usize> {
    Ok(c.execute(
        "DELETE FROM jobs WHERE status IN ('done', 'failed', 'canceled', 'interrupted')",
        [],
    )?)
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

// 避免引入 hex crate 的小工具
mod hex {
    /// 按字节两两解析，并显式拒绝非 ASCII 输入。
    /// 旧实现先按字节长度判断偶数、再用 `&s[i..i + 2]` 切片，遇到多字节字符
    /// （例如把 MOLING_MASTER_KEY_HEX 误设成中文）会在 UTF-8 边界 panic。
    pub fn decode_inner(s: &str) -> Result<Vec<u8>, String> {
        let bytes = s.as_bytes();
        if !bytes.len().is_multiple_of(2) {
            return Err("hex 长度异常".into());
        }
        bytes
            .chunks(2)
            .map(|pair| {
                let text =
                    std::str::from_utf8(pair).map_err(|_| "hex 含非 ASCII 字符".to_string())?;
                u8::from_str_radix(text, 16).map_err(|e| e.to_string())
            })
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

    /// 单测用内存库：跑与线上完全相同的迁移序列，避免测试库 schema 漂移。
    /// （全局 DB 是 OnceLock，无法在测试里重复 init）
    fn mem_conn() -> Connection {
        let mut c = Connection::open_in_memory().expect("open in-memory db");
        apply_migrations(&mut c).expect("apply migrations");
        c
    }

    fn user_version_of(c: &Connection) -> i64 {
        c.query_row("PRAGMA user_version", [], |r| r.get(0))
            .expect("read user_version")
    }

    fn index_exists(c: &Connection, name: &str) -> bool {
        c.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
            params![name],
            |r| r.get::<_, i64>(0),
        )
        .expect("query sqlite_master")
            > 0
    }

    fn insert_message(c: &Connection, conversation_id: i64, content: &str) -> i64 {
        c.execute(
            "INSERT INTO messages (conversation_id, role, content, refined_content,
             images_json, params_json, created_at) VALUES (?1,'user',?2,'','[]','{}','0.000')",
            params![conversation_id, content],
        )
        .expect("insert message");
        c.last_insert_rowid()
    }

    fn count_providers(c: &Connection) -> i64 {
        c.query_row("SELECT COUNT(*) FROM providers", [], |r| r.get(0))
            .expect("count providers")
    }

    fn provider_id_by_name(c: &Connection, name: &str) -> i64 {
        c.query_row(
            "SELECT id FROM providers WHERE name = ?1",
            params![name],
            |r| r.get(0),
        )
        .expect("provider id")
    }

    fn setting_of(c: &Connection, key: &str) -> Option<String> {
        c.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |r| r.get(0),
        )
        .ok()
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
        // P0-2：旧格式导出（provider 无 id）无法映射 defaultProviderId，导入后应清除而非悬空
        assert!(get_setting("defaultProviderId").unwrap().is_none());

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
        let history = list_history(10, 0, "", "").unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].id, hid);
        assert_eq!(history[0].seed, Some(7));
        set_favorite(hid, true).unwrap();
        assert!(list_history(10, 0, "", "").unwrap()[0].favorite);
        let plan = delete_history(hid).unwrap();
        assert_eq!(plan.file_path.as_deref(), Some("/tmp/x.png"));
        assert!(!plan.still_referenced, "无消息引用时应允许回收文件");
        assert!(list_history(10, 0, "", "").unwrap().is_empty());

        delete_provider(after[0].id).unwrap();
        assert!(list_providers().unwrap().is_empty());

        std::env::remove_var(MASTER_KEY_ENV);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// P0-2：缺 providers 数组必须在任何 DELETE 之前拒绝，表内旧数据保持不变
    #[test]
    fn import_config_requires_providers_array() {
        let mut c = mem_conn();
        c.execute(
            "INSERT INTO providers (name, base_url, api_key_enc) VALUES ('旧服务商', '', '')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO settings (key, value) VALUES ('defaultProviderId', '1')",
            [],
        )
        .unwrap();
        // 缺失与类型错误都必须报错，且错误文案指明已取消导入
        for bad in [
            serde_json::json!({ "version": 1 }),
            serde_json::json!({ "version": 1, "providers": "oops" }),
        ] {
            let err = import_config_in(&mut c, &bad).expect_err("providers 非法应报错");
            assert!(err.to_string().contains("缺少 providers 数组"), "{err}");
            assert_eq!(count_providers(&c), 1);
            assert_eq!(setting_of(&c, "defaultProviderId").as_deref(), Some("1"));
        }
    }

    /// P0-2：导入后 extraParams 必须挂到新自增 id 上，不能留在旧 id
    #[test]
    fn import_config_realigns_extra_params_to_new_ids() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var(MASTER_KEY_ENV, "aa".repeat(32));
        let mut c = mem_conn();
        c.execute(
            "INSERT INTO providers (name, base_url, api_key_enc) VALUES ('旧服务商', '', '')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO settings (key, value) VALUES ('extraParams:1', '{\"old\":true}')",
            [],
        )
        .unwrap();
        let data = serde_json::json!({
            "version": 1,
            "providers": [{
                "id": 5,
                "name": "新服务商",
                "extraParams": r#"{"quality":"high"}"#,
            }],
        });
        import_config_in(&mut c, &data).expect("import");
        let new_id = provider_id_by_name(&c, "新服务商");
        assert_ne!(new_id, 1);
        assert_eq!(
            setting_of(&c, &format!("extraParams:{new_id}")).as_deref(),
            Some(r#"{"quality":"high"}"#)
        );
        // 旧 id 的 extraParams 随替换语义一并删除
        assert!(setting_of(&c, "extraParams:1").is_none());
        std::env::remove_var(MASTER_KEY_ENV);
    }

    /// P0-2：defaultProviderId 按旧 id → 新 id 重映射，其它设置原样恢复
    #[test]
    fn import_config_maps_default_provider_id_to_new_id() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var(MASTER_KEY_ENV, "aa".repeat(32));
        let mut c = mem_conn();
        let data = serde_json::json!({
            "version": 1,
            "providers": [
                { "id": 5, "name": "A" },
                { "id": 9, "name": "B" },
            ],
            "settings": { "defaultProviderId": "9", "defaultParams": "{\"steps\":30}" },
        });
        import_config_in(&mut c, &data).expect("import");
        let b_id = provider_id_by_name(&c, "B").to_string();
        assert_eq!(
            setting_of(&c, "defaultProviderId").as_deref(),
            Some(b_id.as_str())
        );
        assert_eq!(
            setting_of(&c, "defaultParams").as_deref(),
            Some("{\"steps\":30}")
        );
        std::env::remove_var(MASTER_KEY_ENV);
    }

    /// P0-2：旧格式导出（provider 无 id）无法映射 defaultProviderId，导入后清除该设置
    #[test]
    fn import_config_clears_default_provider_id_for_legacy_export() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var(MASTER_KEY_ENV, "aa".repeat(32));
        let mut c = mem_conn();
        c.execute(
            "INSERT INTO settings (key, value) VALUES ('defaultProviderId', '7')",
            [],
        )
        .unwrap();
        let data = serde_json::json!({
            "version": 1,
            "providers": [{ "name": "旧格式服务商" }],
            "settings": { "defaultProviderId": "7", "defaultParams": "{}" },
        });
        import_config_in(&mut c, &data).expect("import");
        assert!(setting_of(&c, "defaultProviderId").is_none());
        // 其它设置项照旧写入
        assert_eq!(setting_of(&c, "defaultParams").as_deref(), Some("{}"));
        std::env::remove_var(MASTER_KEY_ENV);
    }

    /// v2：无 Key 导入按 name+baseUrl 复用旧密文；主题 / 模板 / 思考配置恢复，
    /// 思考模型 providerId 重映射到新 id 且密文保留
    #[test]
    fn import_config_v2_reuses_keys_and_restores_settings() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var(MASTER_KEY_ENV, "aa".repeat(32));
        let mut c = mem_conn();
        let old_enc = encrypt_secret("sk-old-secret").unwrap();
        c.execute(
            "INSERT INTO providers (name, base_url, api_key_enc)
             VALUES ('同机服务商', 'https://api.example.com', ?1)",
            params![old_enc],
        )
        .unwrap();
        let old_pid: i64 = c.last_insert_rowid();
        let thinking = serde_json::json!({
            "enabled": true,
            "mode": "reuse",
            "providerId": old_pid,
            "baseUrl": "https://api.example.com",
            "model": "gpt-4o-mini",
            "apiKeyEnc": encrypt_secret("thinking-secret").unwrap(),
        });
        c.execute(
            "INSERT INTO settings (key, value) VALUES ('thinkingConfig', ?1)",
            params![thinking.to_string()],
        )
        .unwrap();

        let data = serde_json::json!({
            "version": 2,
            "exportedAt": "1.000",
            "providers": [
                {
                    "id": 9,
                    "name": "同机服务商",
                    "baseUrl": "https://api.example.com",
                    "apiKey": "",
                    "hasKey": true,
                    "kind": "openai",
                    "defaultModel": "gpt-image-1",
                },
                {
                    "id": 10,
                    "name": "新服务商",
                    "baseUrl": "https://new.example.com",
                    "apiKey": "sk-new-secret",
                    "kind": "openai",
                },
            ],
            "settings": {
                "defaultProviderId": "9",
                "theme": "dark",
                "promptTemplates": r#"[{"id":"my","title":"我的模板","text":"a {subject}"}]"#,
                "unknownKey": "ignored",
            },
            "thinking": {
                "enabled": true,
                "mode": "reuse",
                "providerId": 9,
                "baseUrl": "https://api.example.com",
                "model": "gpt-4o-mini",
            },
        });
        import_config_in(&mut c, &data).expect("import v2");

        let reused_id = provider_id_by_name(&c, "同机服务商");
        let reused_enc: String = c
            .query_row(
                "SELECT api_key_enc FROM providers WHERE id = ?1",
                params![reused_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(decrypt_secret(&reused_enc).unwrap(), "sk-old-secret");
        let new_id = provider_id_by_name(&c, "新服务商");
        let new_enc: String = c
            .query_row(
                "SELECT api_key_enc FROM providers WHERE id = ?1",
                params![new_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(decrypt_secret(&new_enc).unwrap(), "sk-new-secret");

        assert_eq!(setting_of(&c, "theme").as_deref(), Some("dark"));
        let default_id = setting_of(&c, "defaultProviderId").expect("默认服务商已恢复");
        assert_eq!(default_id, reused_id.to_string());
        assert!(setting_of(&c, "promptTemplates")
            .expect("模板已导入")
            .contains("我的模板"));
        // 白名单外的设置项不落库
        assert!(setting_of(&c, "unknownKey").is_none());

        let raw = setting_of(&c, "thinkingConfig").expect("思考配置已导入");
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["providerId"].as_i64(), Some(reused_id));
        assert_eq!(v["model"].as_str(), Some("gpt-4o-mini"));
        // 密文沿用本机旧值，换机导入不会丢思考模型 Key
        assert_eq!(
            decrypt_secret(v["apiKeyEnc"].as_str().unwrap()).unwrap(),
            "thinking-secret"
        );
        std::env::remove_var(MASTER_KEY_ENV);
    }

    /// v2：非法主题 / 模板 / 思考配置必须在 DELETE 前拒绝，旧数据保持不变
    #[test]
    fn import_config_v2_validates_before_delete() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var(MASTER_KEY_ENV, "aa".repeat(32));
        let mut c = mem_conn();
        c.execute(
            "INSERT INTO providers (name, base_url, api_key_enc) VALUES ('旧服务商', '', '')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO settings (key, value) VALUES ('theme', 'light')",
            [],
        )
        .unwrap();
        let bad_settings = [
            (serde_json::json!({ "theme": "purple" }), "主题取值非法"),
            (
                serde_json::json!({ "promptTemplates": "not-json" }),
                "自定义模板",
            ),
            (
                serde_json::json!({ "promptTemplates": "[{\"id\":\"a\"}]" }),
                "自定义模板",
            ),
        ];
        for (settings, needle) in bad_settings {
            let data = serde_json::json!({
                "version": 2,
                "providers": [{ "name": "新服务商" }],
                "settings": settings,
            });
            let err = import_config_in(&mut c, &data).expect_err("应拒绝导入");
            assert!(err.to_string().contains(needle), "{err}");
            assert_eq!(count_providers(&c), 1);
            assert_eq!(setting_of(&c, "theme").as_deref(), Some("light"));
        }
        let bad_thinking = serde_json::json!({
            "version": 2,
            "providers": [],
            "thinking": { "enabled": true, "mode": "weird" },
        });
        let err = import_config_in(&mut c, &bad_thinking).expect_err("应拒绝导入");
        assert!(err.to_string().contains("思考模型"), "{err}");
        assert_eq!(count_providers(&c), 1);
        std::env::remove_var(MASTER_KEY_ENV);
    }

    /// A1：迁移跑完 user_version 等于迁移条数，且三张高频索引都存在
    #[test]
    fn migrations_set_schema_version_and_indexes() {
        let c = mem_conn();
        assert_eq!(user_version_of(&c), SCHEMA_VERSION);
        for name in [
            "idx_messages_conversation",
            "idx_history_created",
            "idx_history_model",
        ] {
            assert!(index_exists(&c, name), "缺少索引 {name}");
        }
    }

    /// A1：重复执行迁移是幂等的（每次启动都会跑一遍）
    #[test]
    fn migrations_are_idempotent() {
        let mut c = mem_conn();
        apply_migrations(&mut c).expect("second run");
        assert_eq!(user_version_of(&c), SCHEMA_VERSION);
    }

    /// A1：旧库（user_version=0，只有表没有索引）升级后数据原样保留
    #[test]
    fn legacy_database_upgrade_preserves_rows() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA_SQL).expect("legacy tables");
        assert_eq!(user_version_of(&c), 0);
        c.execute(
            "INSERT INTO providers (name, base_url, api_key_enc) VALUES ('旧服务商', '', '')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO conversations (title, created_at) VALUES ('旧会话', '0.000')",
            [],
        )
        .unwrap();
        let cid = c.last_insert_rowid();
        insert_message(&c, cid, "旧消息");

        apply_migrations(&mut c).expect("upgrade");

        assert_eq!(user_version_of(&c), SCHEMA_VERSION);
        assert!(index_exists(&c, "idx_messages_conversation"));
        assert_eq!(count_providers(&c), 1);
        let (messages, has_more) = list_messages_in(&c, cid, 50, None).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content, "旧消息");
        assert!(!has_more);
    }

    /// A1：迁移失败必须整体回滚，且不推进 user_version（否则下次启动会跳过它）
    #[test]
    fn failed_migration_rolls_back_and_keeps_version() {
        let mut c = Connection::open_in_memory().unwrap();
        let bad = "CREATE TABLE half_done (id INTEGER); INSERT INTO nope VALUES (1);";
        let err = apply_migrations_with(&mut c, &[("999_bad", bad)]).expect_err("必须失败");
        assert!(err.to_string().contains("999_bad"), "{err}");
        assert_eq!(user_version_of(&c), 0);
        let half_table: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='half_done'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(half_table, 0, "失败迁移创建的表应被回滚");
    }

    /// A1：升级已有数据的库文件前会留一份 moling.db.bak-migrate-* 快照
    #[test]
    fn legacy_file_is_backed_up_before_migration() {
        let dir = std::env::temp_dir().join(format!("moling-migrate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("moling.db");
        {
            let c = Connection::open(&db_path).unwrap();
            c.execute_batch(SCHEMA_SQL).unwrap();
            c.execute(
                "INSERT INTO providers (name, base_url, api_key_enc) VALUES ('老库', '', '')",
                [],
            )
            .unwrap();
        }

        let upgraded = open_and_migrate(&db_path).expect("upgrade legacy file");
        assert_eq!(user_version_of(&upgraded), SCHEMA_VERSION);
        assert_eq!(count_providers(&upgraded), 1);
        drop(upgraded);

        let backups: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with("moling.db.bak-migrate-"))
            .collect();
        assert_eq!(backups.len(), 1, "应有一份迁移前备份：{backups:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

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

    /// B1 同类：非 ASCII 主密钥必须报错而不是在 UTF-8 边界 panic
    #[test]
    fn hex_key_parsing_rejects_non_ascii() {
        assert!(parse_hex_key("密钥密钥").is_err());
        assert!(parse_hex_key("aa密").is_err());
    }

    fn insert_history_row(c: &Connection, file_path: &str) -> i64 {
        c.execute(
            "INSERT INTO history (prompt, negative_prompt, model, provider_name, seed, width,
             height, guidance, steps, style, file_path, favorite, created_at)
             VALUES ('p','','m','pv',NULL,1024,1024,0,0,'', ?1, 0, '0.000')",
            params![file_path],
        )
        .expect("insert history");
        c.last_insert_rowid()
    }

    fn set_message_images(c: &Connection, id: i64, images_json: &str) {
        c.execute(
            "UPDATE messages SET images_json = ?2 WHERE id = ?1",
            params![id, images_json],
        )
        .expect("update images_json");
    }

    fn count_history_rows(c: &Connection) -> i64 {
        c.query_row("SELECT COUNT(*) FROM history", [], |r| r.get(0))
            .expect("count history")
    }

    /// 路径归一化：分隔符与大小写差异不得影响"是否仍被引用"的判定
    #[test]
    fn normalize_path_key_unifies_separators_and_case() {
        assert_eq!(
            normalize_path_key("C:/Users/A/b.PNG"),
            normalize_path_key(r"C:\users\a\B.png")
        );
        assert_eq!(normalize_path_key("  x  "), "x");
    }

    /// 引用集合必须覆盖 history.file_path 与 messages 里的两种 path 形态
    /// （生成图 `{historyId,path}`、附件 `{id,name,path}`）
    #[test]
    fn referenced_paths_cover_history_and_messages() {
        let c = mem_conn();
        insert_history_row(&c, r"C:\data\images\a.png");
        let generated = insert_message(&c, 1, "hi");
        set_message_images(
            &c,
            generated,
            r#"[{"historyId":1,"path":"C:\\data\\images\\b.png"}]"#,
        );
        let attachment = insert_message(&c, 1, "ref");
        set_message_images(
            &c,
            attachment,
            r#"[{"id":"x","name":"n","path":"C:\\data\\images\\c.png"}]"#,
        );
        let set = collect_referenced_paths_in(&c).expect("collect");
        for p in [
            r"C:\data\images\a.png",
            r"C:\data\images\b.png",
            r"C:\data\images\c.png",
        ] {
            assert!(set.contains(&normalize_path_key(p)), "缺少引用: {p}");
        }
        assert_eq!(set.len(), 3, "同路径重复出现应去重");
    }

    /// 坏 JSON 不能拖垮整条查询：一行脏数据就会让回收链路全线失效
    #[test]
    fn referenced_paths_survive_corrupt_images_json() {
        let c = mem_conn();
        insert_history_row(&c, "/tmp/keep.png");
        let bad = insert_message(&c, 1, "bad");
        set_message_images(&c, bad, "not-json");
        let set = collect_referenced_paths_in(&c).expect("坏 JSON 不应导致查询失败");
        assert_eq!(set.len(), 1);
        assert!(set.contains(&normalize_path_key("/tmp/keep.png")));
    }

    /// 删除判定：被消息引用必须保留；无引用才允许回收；删行不影响判定自身的引用
    #[test]
    fn delete_history_keeps_file_when_still_referenced() {
        let c = mem_conn();
        let shared = insert_history_row(&c, r"C:\data\images\shared.png");
        let msg = insert_message(&c, 1, "ref");
        set_message_images(
            &c,
            msg,
            r#"[{"historyId":1,"path":"C:\\data\\images\\shared.png"}]"#,
        );

        let plan = delete_history_in(&c, shared).expect("delete shared");
        assert!(plan.still_referenced, "消息仍引用时必须保留文件");
        assert_eq!(count_history_rows(&c), 0, "画廊行本身仍应删掉");

        let solo = insert_history_row(&c, r"C:\data\images\solo.png");
        let plan = delete_history_in(&c, solo).expect("delete solo");
        assert!(!plan.still_referenced, "无其它引用时应允许回收文件");
        assert_eq!(
            plan.file_path.as_deref(),
            Some(r"C:\data\images\solo.png"),
            "返回值必须是原始路径，不能被归一化改写"
        );
    }

    /// C2：迁移 003 之后把存量单 Key 幂等回填成 Key 列表
    #[test]
    fn backfill_moves_legacy_key_into_list() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var(MASTER_KEY_ENV, "cc".repeat(32));
        let c = mem_conn();
        let enc = encrypt_secret("sk-legacy").expect("encrypt");
        c.execute(
            "INSERT INTO providers (name, base_url, api_key_enc) VALUES ('旧', '', ?1)",
            params![enc],
        )
        .unwrap();
        let id = c.last_insert_rowid();

        backfill_provider_keys(&c);
        let read = |c: &Connection| -> Vec<ProviderKey> {
            let (keys_enc, legacy): (String, String) = c
                .query_row(
                    "SELECT api_keys_enc, api_key_enc FROM providers WHERE id = ?1",
                    params![id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            decode_keys(&keys_enc, &legacy).expect("decode keys")
        };
        let keys = read(&c);
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].key, "sk-legacy");
        assert!(!keys[0].invalid);

        // 幂等：再跑一次不会重复追加
        backfill_provider_keys(&c);
        assert_eq!(read(&c).len(), 1);
        std::env::remove_var(MASTER_KEY_ENV);
    }

    /// C2：写 Key 列表时 `api_key_enc` 必须镜像首 Key（旧代码/思考模型复用路径依赖它）
    #[test]
    fn key_list_write_mirrors_first_key() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var(MASTER_KEY_ENV, "dd".repeat(32));
        let mut c = mem_conn();
        let enc = encrypt_secret("").unwrap();
        c.execute(
            "INSERT INTO providers (name, base_url, api_key_enc) VALUES ('P', '', ?1)",
            params![enc],
        )
        .unwrap();
        let id = c.last_insert_rowid();
        {
            let tx = c.transaction().unwrap();
            write_keys_tx(&tx, id, &[ProviderKey::new("k1"), ProviderKey::new("k2")]).unwrap();
            tx.commit().unwrap();
        }
        let (keys_enc, first): (String, String) = c
            .query_row(
                "SELECT api_keys_enc, api_key_enc FROM providers WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(decrypt_secret(&first).unwrap(), "k1");
        // 密文是 base64（随机 nonce + 密文），短子串可能偶然出现，只能断言不是明文 JSON
        assert!(!keys_enc.starts_with('['), "Key 列表必须整体加密");
        let decoded = decode_keys(&keys_enc, &first).unwrap();
        assert_eq!(
            decoded.iter().map(|k| k.key.as_str()).collect::<Vec<_>>(),
            vec!["k1", "k2"]
        );
        std::env::remove_var(MASTER_KEY_ENV);
    }

    /// C2：v3 备份导入恢复整组 Key 与失效状态；不含 Key 的备份沿用本机整组密文
    #[test]
    fn import_v3_roundtrip_keeps_keys_and_invalid_state() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var(MASTER_KEY_ENV, "ee".repeat(32));
        let mut c = mem_conn();
        let provider = |keys: serde_json::Value, invalid: serde_json::Value| {
            serde_json::json!({
                "name": "P",
                "baseUrl": "https://api.example.com",
                "kind": "openai",
                "hasKeys": 3,
                "apiKeys": keys,
                "invalidKeyIndexes": invalid,
                "modelsJson": "[\"m1\"]",
                "defaultModel": "m1",
                "timeoutSecs": 30,
                "templateUrl": "",
                "templateBody": "",
                "templateResponsePath": "",
            })
        };
        let data = serde_json::json!({
            "version": 3,
            "providers": [provider(
                serde_json::json!(["sk-a", "sk-b", "sk-c"]),
                serde_json::json!([1]),
            )],
            "settings": {},
            "network": {
                "mode": "manual",
                "url": "http://127.0.0.1:7890",
                "noProxy": "localhost",
            },
        });
        import_config_in(&mut c, &data).expect("import v3");

        let read_keys = |c: &Connection| -> Vec<ProviderKey> {
            let (keys_enc, first): (String, String) = c
                .query_row("SELECT api_keys_enc, api_key_enc FROM providers", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .unwrap();
            decode_keys(&keys_enc, &first).expect("decode keys")
        };
        let keys = read_keys(&c);
        assert_eq!(
            keys.iter().map(|k| k.key.as_str()).collect::<Vec<_>>(),
            vec!["sk-a", "sk-b", "sk-c"]
        );
        assert!(!keys[0].invalid);
        assert!(keys[1].invalid, "失效下标必须随备份恢复");
        assert!(!keys[2].invalid);

        // 代理只恢复非密钥字段，密码永远不来自备份
        let net: serde_json::Value =
            serde_json::from_str(&setting_of(&c, "networkProxy").expect("networkProxy")).unwrap();
        assert_eq!(net["mode"], "manual");
        assert_eq!(net["url"], "http://127.0.0.1:7890");
        assert_eq!(net["noProxy"], "localhost");
        assert_eq!(net["passwordEnc"], "");

        // includeKeys=false 的备份（apiKeys 为空）：按 name+baseUrl 复用本机整组 Key
        let no_keys = serde_json::json!({
            "version": 3,
            "providers": [provider(serde_json::json!([]), serde_json::json!([]))],
            "settings": {},
        });
        import_config_in(&mut c, &no_keys).expect("import v3 without keys");
        let keys = read_keys(&c);
        assert_eq!(keys.len(), 3);
        assert!(keys[1].invalid);
        std::env::remove_var(MASTER_KEY_ENV);
    }

    /// C2：v3 的 Key 字段类型错误必须在事务与 DELETE 之前被拒绝
    #[test]
    fn import_v3_rejects_bad_keys_before_touching_data() {
        let mut c = mem_conn();
        c.execute(
            "INSERT INTO providers (name, base_url, api_key_enc) VALUES ('旧', '', '')",
            [],
        )
        .unwrap();
        for bad in [
            serde_json::json!({
                "version": 3,
                "providers": [{ "name": "P", "baseUrl": "", "apiKeys": "oops" }],
                "settings": {},
            }),
            serde_json::json!({
                "version": 3,
                "providers": [{ "name": "P", "baseUrl": "", "apiKeys": [], "invalidKeyIndexes": ["x"] }],
                "settings": {},
            }),
            serde_json::json!({
                "version": 3,
                "providers": [{ "name": "P", "baseUrl": "", "apiKeys": [] }],
                "settings": {},
                "network": { "mode": "manual", "url": "socks5://127.0.0.1:1080" },
            }),
        ] {
            import_config_in(&mut c, &bad).expect_err("非法 Key/代理配置应拒绝导入");
            assert_eq!(count_providers(&c), 1, "拒绝时不得删除旧数据");
        }
    }

    fn new_job<'a>(prompt: &'a str) -> NewJob<'a> {
        NewJob {
            provider_id: 1,
            provider_name: "P",
            model: "m",
            prompt,
            negative_prompt: "",
            style: "",
            width: 1024,
            height: 1024,
            guidance: None,
            steps: None,
            seed: None,
            count: 1,
        }
    }

    /// C4：启动时残留的 running 必须标为 interrupted，且不回到 queued
    #[test]
    fn startup_marks_running_interrupted() {
        let c = mem_conn();
        let running = insert_job_in(&c, &new_job("running")).unwrap();
        let queued = insert_job_in(&c, &new_job("queued")).unwrap();
        assert!(start_job_in(&c, running).unwrap());
        assert_eq!(mark_running_interrupted_in(&c).unwrap(), 1);
        assert_eq!(
            get_job_in(&c, running).unwrap().unwrap().status,
            "interrupted"
        );
        assert_eq!(
            get_job_in(&c, queued).unwrap().unwrap().status,
            "queued",
            "排队中的任务不应被启动逻辑改写"
        );
    }

    /// C4：状态迁移必须带前置状态条件，已取消的任务不能被完成覆盖
    #[test]
    fn queue_transition_requires_expected_state() {
        let c = mem_conn();
        let id = insert_job_in(&c, &new_job("job")).unwrap();
        // 未启动时不能直接 finish（只有 running 才能收尾）
        assert!(!finish_job_in(&c, id, "done", "[]", None).unwrap());
        assert!(start_job_in(&c, id).unwrap());
        // 重复启动（worker 竞争）必须失败
        assert!(!start_job_in(&c, id).unwrap());
        assert!(finish_job_in(&c, id, "done", "[]", None).unwrap());
        // 终态不可再次迁移
        assert!(!finish_job_in(&c, id, "canceled", "[]", None).unwrap());
        assert_eq!(get_job_in(&c, id).unwrap().unwrap().status, "done");
    }

    /// C4：失败任务重试回 queued，终态与运行中任务不能重试
    #[test]
    fn retry_requeues_failed() {
        let c = mem_conn();
        let id = insert_job_in(&c, &new_job("job")).unwrap();
        assert!(!requeue_job_in(&c, id).unwrap(), "queued 任务无需重试");
        assert!(start_job_in(&c, id).unwrap());
        assert!(!requeue_job_in(&c, id).unwrap(), "running 任务不能重试");
        assert!(finish_job_in(&c, id, "failed", "[]", Some("boom")).unwrap());
        assert!(requeue_job_in(&c, id).unwrap());
        let row = get_job_in(&c, id).unwrap().unwrap();
        assert_eq!(row.status, "queued");
        assert!(row.error.is_none());
        assert_eq!(row.images_json, "[]");
        assert!(row.started_at.is_none());
        assert!(row.finished_at.is_none());
    }

    /// C4：取消排队任务立即生效，worker 之后取不到它
    #[test]
    fn cancel_queued_is_immediate() {
        let c = mem_conn();
        let first = insert_job_in(&c, &new_job("first")).unwrap();
        let second = insert_job_in(&c, &new_job("second")).unwrap();
        assert!(cancel_queued_job_in(&c, first).unwrap());
        assert!(!cancel_queued_job_in(&c, first).unwrap(), "取消应幂等");
        let next = next_queued_job_in(&c).unwrap().expect("仍有排队任务");
        assert_eq!(next.id, second, "被取消的任务不能再被取到");
        let row = get_job_in(&c, first).unwrap().unwrap();
        assert_eq!(row.status, "canceled");
        assert!(row.finished_at.is_some());
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
