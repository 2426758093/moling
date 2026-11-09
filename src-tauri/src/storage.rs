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
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

static DB: OnceLock<Mutex<Connection>> = OnceLock::new();

/// 测试期间串行化全局 DB 初始化：OnceLock 只能 init 一次，多个测试模块会争抢
#[cfg(test)]
pub(crate) static TEST_DB_LOCK: Mutex<()> = Mutex::new(());

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
    /// 编辑/变换模板（JSON：{url, body, responsePath}），空串表示未配置
    pub edit_template_json: String,
    pub transform_template_json: String,
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
    /// 派生图的父记录（放大 / 风格 / 编辑 / 画布导出）；原创为 None
    #[serde(default)]
    pub parent_id: Option<i64>,
    /// generate | edit | erase | outpaint | upscale | style | background | basic-edit | canvas | paste
    #[serde(default = "default_op")]
    pub op: String,
}

fn default_op() -> String {
    "generate".to_string()
}

/// 提示词收藏与工作流预设的上限：与参考图上限保持一致，避免预设比一次生成能用的图还多。
pub const MAX_PRESET_REFS: usize = 4;
pub const MAX_FAVORITE_TAGS: usize = 8;
pub const MAX_PRESET_NAME_CHARS: usize = 80;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptFavorite {
    pub id: i64,
    pub text: String,
    pub tags: Vec<String>,
    pub created_at: String,
}

/// 预设里的参考图：只存文件路径，角色 / 强度随路径一起打包。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetRef {
    pub path: String,
    #[serde(default = "default_preset_role")]
    pub role: String,
    #[serde(default = "default_preset_strength")]
    pub strength: u32,
}

fn default_preset_role() -> String {
    "composition".to_string()
}

fn default_preset_strength() -> u32 {
    crate::reference::DEFAULT_STRENGTH
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowPreset {
    pub id: i64,
    pub name: String,
    pub prompt: String,
    pub negative_prompt: String,
    pub params_json: String,
    pub refs: Vec<PresetRef>,
    pub created_at: String,
    pub updated_at: String,
}

/// 画布上限：JSON 2MB / 500 节点，避免一次保存把 SQLite 与 IPC 拖垮。
pub const MAX_CANVAS_NODES: usize = 500;
pub const MAX_CANVAS_JSON_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_CANVAS_NAME_CHARS: usize = 80;

pub const CANVAS_DEFAULT_DATA: &str =
    r#"{"version":1,"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}"#;

/// 画布列表只带元信息，避免把所有画布的节点数据一起读出来。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasBoardMeta {
    pub id: i64,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasBoard {
    pub id: i64,
    pub name: String,
    pub data_json: String,
    pub created_at: String,
    pub updated_at: String,
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
    pub edit_template_json: &'a str,
    pub transform_template_json: &'a str,
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

/// 迁移 005：自定义模板服务商的编辑 / 变换端点。存 JSON（{url, body, responsePath}）
/// 而不是拆成多列：模板端点后续可能扩展 method/headers，JSON 不需要再加迁移。
const PROVIDER_TEMPLATES_SQL: &str = "
        ALTER TABLE providers ADD COLUMN edit_template_json TEXT NOT NULL DEFAULT '';
        ALTER TABLE providers ADD COLUMN transform_template_json TEXT NOT NULL DEFAULT '';
";

/// 迁移 006：模型能力元数据（只驱动界面开关，不改变请求形状）。
const MODEL_CAPS_SQL: &str = "
        CREATE TABLE IF NOT EXISTS model_caps (
            provider_id INTEGER NOT NULL,
            model TEXT NOT NULL,
            caps_json TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (provider_id, model)
        );
";

/// (名称, SQL)，按顺序执行；`PRAGMA user_version` 记录已应用到的序号（从 1 起）。
/// 迁移 007：派生图血统。`op` 记录这张图是怎么来的（放大 / 风格 / 编辑 / 画布…），
/// `parent_id` 指向父图；两者都只增列，存量行自动是 generate + NULL。
const HISTORY_LINEAGE_SQL: &str = "
        ALTER TABLE history ADD COLUMN parent_id INTEGER;
        ALTER TABLE history ADD COLUMN op TEXT NOT NULL DEFAULT 'generate';
        CREATE INDEX IF NOT EXISTS idx_history_parent ON history(parent_id);
";

/// 迁移 008：队列参考图。`input_json` 存列里没有的入队扩展字段
/// （参考图路径 + 角色 / 强度），老行为空串按「无参考图」处理。
const JOBS_INPUT_SQL: &str = "
        ALTER TABLE jobs ADD COLUMN input_json TEXT NOT NULL DEFAULT '';
";

/// 迁移 009：提示词资产。收藏按文本去重（UNIQUE + upsert），标签存 JSON 数组；
/// 工作流预设的参考图仍只存路径（`{path, role, strength}`），备份导出时才内联 dataUrl。
const PROMPT_ASSETS_SQL: &str = "
        CREATE TABLE IF NOT EXISTS prompt_favorites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            text TEXT NOT NULL UNIQUE,
            tags_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_prompt_favorites_created
            ON prompt_favorites(created_at DESC);
        CREATE TABLE IF NOT EXISTS workflow_presets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            prompt TEXT NOT NULL DEFAULT '',
            negative_prompt TEXT NOT NULL DEFAULT '',
            params_json TEXT NOT NULL DEFAULT '{}',
            refs_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_workflow_presets_updated
            ON workflow_presets(updated_at DESC);
";

/// 迁移 011：运行中任务心跳。长任务（多张参考图、慢服务商）可能超过回收阈值，
/// 只按 started_at 回收会误伤；worker 每 60s 刷新 heartbeat_at。
const JOBS_HEARTBEAT_SQL: &str = "
        ALTER TABLE jobs ADD COLUMN heartbeat_at TEXT;
";

/// 迁移 012：把旧版 60s 默认超时抬到 600s。60 是建表默认值，也是旧版前端新建
/// 服务商时写入的值；图片接口在 60s 内经常还没返回响应头（生成未完成），
/// 客户端先断开后上游仍会跑完并计费。用户显式设置成其它值的行保持不动。
const PROVIDER_TIMEOUT_DEFAULT_SQL: &str = "
        UPDATE providers SET timeout_secs = 600 WHERE timeout_secs = 60;
";

/// 迁移 010：画布工作区。只存 historyId 与布局，不存 dataUrl / base64；
/// 画布引用本机 history，不参与配置备份。
const CANVAS_SQL: &str = "
        CREATE TABLE IF NOT EXISTS canvas_boards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            data_json TEXT NOT NULL DEFAULT '{\"version\":1,\"nodes\":[],\"edges\":[],\"viewport\":{\"x\":0,\"y\":0,\"zoom\":1}}',
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_canvas_boards_updated
            ON canvas_boards(updated_at DESC);
";

/// 迁移 013：「已扣费却没图」防护。记录每次计费请求的意图与结果，
/// 使断线/超时/崩溃后能区分「确定没扣费」与「可能已扣费」；raw 响应体
/// 先落盘再解析，供本地恢复。`messages.status/error` 让失败轮次重启后不再
/// 显示成「已完成的空回复」。
const IMAGE_REQUESTS_SQL: &str = "
        CREATE TABLE IF NOT EXISTS image_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL,
            client_request_id TEXT NOT NULL,
            entry TEXT NOT NULL,
            op TEXT NOT NULL DEFAULT 'generate',
            job_id INTEGER,
            provider_id INTEGER NOT NULL,
            provider_name TEXT NOT NULL DEFAULT '',
            model TEXT NOT NULL DEFAULT '',
            prompt TEXT NOT NULL DEFAULT '',
            endpoint TEXT NOT NULL DEFAULT '',
            attempt INTEGER NOT NULL DEFAULT 1,
            state TEXT NOT NULL DEFAULT 'created',
            http_status INTEGER,
            provider_request_id TEXT NOT NULL DEFAULT '',
            param_hash TEXT NOT NULL DEFAULT '',
            image_count INTEGER NOT NULL DEFAULT 1,
            artifacts_json TEXT NOT NULL DEFAULT '[]',
            raw_path TEXT NOT NULL DEFAULT '',
            error_json TEXT,
            created_at TEXT NOT NULL,
            sent_at TEXT,
            billed_at TEXT,
            finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_image_requests_state
            ON image_requests(state, id);
        CREATE INDEX IF NOT EXISTS idx_image_requests_group
            ON image_requests(group_id);
        CREATE INDEX IF NOT EXISTS idx_image_requests_fingerprint
            ON image_requests(param_hash, state);
        ALTER TABLE jobs ADD COLUMN billing_state TEXT NOT NULL DEFAULT '';
        ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'done';
        ALTER TABLE messages ADD COLUMN error TEXT;
";

const MIGRATIONS: &[(&str, &str)] = &[
    ("001_tables", SCHEMA_SQL),
    ("002_indexes", INDEXES_SQL),
    ("003_provider_keys", PROVIDER_KEYS_SQL),
    ("004_jobs", JOBS_SQL),
    ("005_provider_templates", PROVIDER_TEMPLATES_SQL),
    ("006_model_caps", MODEL_CAPS_SQL),
    ("007_history_lineage", HISTORY_LINEAGE_SQL),
    ("008_jobs_input", JOBS_INPUT_SQL),
    ("009_prompt_assets", PROMPT_ASSETS_SQL),
    ("010_canvas", CANVAS_SQL),
    ("011_jobs_heartbeat", JOBS_HEARTBEAT_SQL),
    ("012_provider_timeout_default", PROVIDER_TIMEOUT_DEFAULT_SQL),
    ("013_image_requests", IMAGE_REQUESTS_SQL),
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

pub(crate) fn conn() -> AppResult<std::sync::MutexGuard<'static, Connection>> {
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

/// 启动预热主密钥（F-013）：把 keyring 读取提前到启动期，避免首个「保存服务商」
/// 或首次解密 Key 时才在持锁路径上做 keyring IO；失败只记日志，不阻断启动。
pub fn warm_master_key() {
    if let Err(e) = master_key() {
        tracing::warn!("主密钥预热失败（将在首次使用 Key 时重试）: {e}");
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
        edit_template_json: row.get(11)?,
        transform_template_json: row.get(12)?,
        api_key_masked: mask_key(&key),
        has_key: !key.is_empty(),
        key_error,
    })
}

/// 服务商请求超时的合法区间（秒）：过小会截断正常出图，过大则像卡死
pub const MIN_PROVIDER_TIMEOUT_SECS: u64 = 5;
pub const MAX_PROVIDER_TIMEOUT_SECS: u64 = 1800;
/// 默认等待上限：与 OpenAI 官方 SDK 的 600s 默认一致。
/// 图片接口是同步长请求（gpt-image 类模型实测中位约 195s、p95 约 280s），
/// 旧的 60s 默认会在上游正常出图前掐断连接，而断开后上游仍会跑完并计费。
pub const DEFAULT_PROVIDER_TIMEOUT_SECS: u64 = 600;

/// 超时越界值静默夹到合法区间，避免 0s 必超时 / 10 万秒像卡死
pub fn clamp_provider_timeout(secs: u64) -> u64 {
    secs.clamp(MIN_PROVIDER_TIMEOUT_SECS, MAX_PROVIDER_TIMEOUT_SECS)
}

/// 保存服务商：读-改-写走两阶段 CAS（D1）。
///
/// 加解密是慢操作（首次读 keyring 可达数百毫秒），必须在拿 DB 锁之前算好（F-013）。
/// 先短锁读取 Key 密文 → 锁外解密重建 → `BEGIN IMMEDIATE` 内重读比对；
/// 期间被其它保存改过就重试，避免把并发写入的 Key 列表覆盖掉。
pub fn save_provider(id: Option<i64>, draft: &ProviderDraft) -> AppResult<ProviderRow> {
    const MAX_CAS_ATTEMPTS: usize = 3;
    let empty_enc = encrypt_secret("")?;
    // D10：超时只接受 5–1800 秒，越界值静默夹住，避免 0s 必超时 / 10 万秒像卡死
    let timeout_secs = clamp_provider_timeout(draft.timeout_secs);
    for attempt in 1..=MAX_CAS_ATTEMPTS {
        // 短锁只读：换 Key 时需要旧密文才能保留整组列表，解密放到锁外
        let observed = match id {
            Some(existing) => {
                let c = conn()?;
                c.query_row(
                    "SELECT api_keys_enc, api_key_enc FROM providers WHERE id = ?1",
                    params![existing],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                )
                .optional()?
            }
            None => None,
        };
        // 主密钥变化后旧密文解不开：按用户新填的 Key 重建列表，而不是让保存失败
        let rebuilt_keys = match draft.api_key {
            Some(new_key) => {
                let mut keys = match &observed {
                    Some((keys_enc, legacy_enc)) => decode_keys(keys_enc, legacy_enc)
                        .unwrap_or_else(|e| {
                            tracing::warn!("保存服务商时旧 Key 解密失败，按新 Key 重建列表: {e}");
                            Vec::new()
                        }),
                    None => Vec::new(),
                };
                if keys.is_empty() {
                    keys.push(ProviderKey::new(new_key));
                } else {
                    keys[0] = ProviderKey::new(new_key);
                }
                Some(encode_keys(&keys)?)
            }
            None => None,
        };

        // 元数据与 Key 列表同事务写入：避免「编辑资料 + 换主 Key」中途失败留下两列不一致。
        // 事务必须放在独立作用域里：ConnGuard 未释放时再调用 get_provider 会自锁。
        let saved_id = {
            let mut c = conn()?;
            // IMMEDIATE：读后升级写不会触发 SQLITE_BUSY_SNAPSHOT
            let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            if draft.api_key.is_some() {
                if let Some(existing) = id {
                    let current = tx
                        .query_row(
                            "SELECT api_keys_enc, api_key_enc FROM providers WHERE id = ?1",
                            params![existing],
                            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                        )
                        .optional()?;
                    if current != observed {
                        drop(tx);
                        if attempt < MAX_CAS_ATTEMPTS {
                            tracing::debug!(
                                "服务商 #{existing} 保存期间 Key 被修改，重试第 {attempt} 次"
                            );
                            continue;
                        }
                        return Err(AppError::Other(
                            "服务商 Key 在保存期间被其它操作修改，请重试".into(),
                        ));
                    }
                }
            }
            let id = match id {
                Some(existing) => {
                    let n = tx.execute(
                        "UPDATE providers SET name=?1, base_url=?2, kind=?3, models_json=?4,
                     default_model=?5, timeout_secs=?6, template_url=?7, template_body=?8,
                     template_response_path=?9, edit_template_json=?10,
                     transform_template_json=?11 WHERE id=?12",
                        params![
                            draft.name,
                            draft.base_url,
                            draft.kind,
                            draft.models_json,
                            draft.default_model,
                            timeout_secs as i64,
                            draft.template_url,
                            draft.template_body,
                            draft.template_response_path,
                            draft.edit_template_json,
                            draft.transform_template_json,
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
                    tx.execute(
                        "INSERT INTO providers (name, base_url, api_key_enc, kind, models_json,
                     default_model, timeout_secs, template_url, template_body, template_response_path,
                     edit_template_json, transform_template_json)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                        params![
                            draft.name,
                            draft.base_url,
                            empty_enc,
                            draft.kind,
                            draft.models_json,
                            draft.default_model,
                            timeout_secs as i64,
                            draft.template_url,
                            draft.template_body,
                            draft.template_response_path,
                            draft.edit_template_json,
                            draft.transform_template_json
                        ],
                    )?;
                    tx.last_insert_rowid()
                }
            };
            // 未填新 Key 时保持整组 Key 与密文原样，避免解密失败的旧数据在纯改资料时被清空
            if let Some((keys_enc, first_enc)) = &rebuilt_keys {
                let n = tx.execute(
                    "UPDATE providers SET api_keys_enc = ?1, api_key_enc = ?2 WHERE id = ?3",
                    params![keys_enc, first_enc, id],
                )?;
                if n == 0 {
                    return Err(AppError::NotFound(format!("服务商 #{id} 不存在")));
                }
            }
            tx.commit()?;
            id
        };
        return get_provider(saved_id)?
            .ok_or_else(|| AppError::NotFound("provider not found after save".into()));
    }
    unreachable!("CAS 循环至少返回一次")
}

pub fn get_provider(id: i64) -> AppResult<Option<ProviderRow>> {
    let c = conn()?;
    let mut stmt = c.prepare(
        "SELECT id, name, base_url, api_key_enc, kind, models_json, default_model,
         timeout_secs, template_url, template_body, template_response_path,
         edit_template_json, transform_template_json
         FROM providers WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], row_to_provider)?;
    Ok(rows.next().transpose()?)
}

pub fn list_providers() -> AppResult<Vec<ProviderRow>> {
    let c = conn()?;
    let mut stmt = c.prepare(
        "SELECT id, name, base_url, api_key_enc, kind, models_json, default_model,
         timeout_secs, template_url, template_body, template_response_path,
         edit_template_json, transform_template_json
         FROM providers ORDER BY id",
    )?;
    let rows = stmt.query_map([], row_to_provider)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

pub fn delete_provider(id: i64) -> AppResult<()> {
    let mut c = conn()?;
    let tx = c.transaction()?;
    tx.execute("DELETE FROM model_caps WHERE provider_id = ?1", params![id])?;
    tx.execute("DELETE FROM providers WHERE id = ?1", params![id])?;
    tx.commit()?;
    Ok(())
}

/// 写入模型能力覆盖值（JSON）；同 (provider, model) 覆盖旧值。
pub fn save_model_caps(provider_id: i64, model: &str, caps_json: &str) -> AppResult<()> {
    let guard = conn()?;
    save_model_caps_in(&guard, provider_id, model, caps_json)
}

fn save_model_caps_in(
    c: &Connection,
    provider_id: i64,
    model: &str,
    caps_json: &str,
) -> AppResult<()> {
    c.execute(
        "INSERT INTO model_caps (provider_id, model, caps_json, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(provider_id, model)
         DO UPDATE SET caps_json = excluded.caps_json, updated_at = excluded.updated_at",
        params![provider_id, model, caps_json, timestamp_millis()],
    )?;
    Ok(())
}

/// 批量写入模型能力：单事务提交，避免弹窗保存时出现「存了一半」的半成功状态。
pub fn save_model_caps_batch(provider_id: i64, entries: &[(String, String)]) -> AppResult<()> {
    let mut guard = conn()?;
    save_model_caps_batch_in(&mut guard, provider_id, entries)
}

fn save_model_caps_batch_in(
    c: &mut Connection,
    provider_id: i64,
    entries: &[(String, String)],
) -> AppResult<()> {
    let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    for (model, caps_json) in entries {
        save_model_caps_in(&tx, provider_id, model, caps_json)?;
    }
    tx.commit()?;
    Ok(())
}

/// 读取某服务商全部模型的能力覆盖值（model, caps_json）。
pub fn list_model_caps(provider_id: i64) -> AppResult<Vec<(String, String)>> {
    let guard = conn()?;
    list_model_caps_in(&guard, provider_id)
}

fn list_model_caps_in(c: &Connection, provider_id: i64) -> AppResult<Vec<(String, String)>> {
    let mut stmt =
        c.prepare("SELECT model, caps_json FROM model_caps WHERE provider_id = ?1 ORDER BY model")?;
    let rows = stmt.query_map(params![provider_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
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

/// 经由「通用 set/get_setting」通道持久化、并且会进备份与诊断包的设置项。
///
/// 与 `commands::settings::ALLOWED_SETTING_KEYS` 必须逐项一致（有单测守住）：
/// 新增一项只改动其中一处的后果是"设置能存但备份丢了"或反过来，两者都不报错。
pub const BACKUP_SETTING_KEYS: &[&str] = &[
    "defaultProviderId",
    "defaultParams",
    "promptTemplates",
    "stylePresets",
    "theme",
    "glassAppearance",
    "uiMode",
    "locale",
    "queueConcurrency",
    "queueProviderConcurrency",
    "queueAutoResume",
    "cacheRetentionDays",
    "bodyIdleTimeoutSecs",
    "bodyTotalTimeoutSecs",
    "smartMask",
];

/// 缓存（回收站）保留天数的合法区间与默认值
pub const MIN_CACHE_RETENTION_DAYS: i64 = 1;
pub const MAX_CACHE_RETENTION_DAYS: i64 = 365;
pub const DEFAULT_CACHE_RETENTION_DAYS: i64 = 30;

/// 响应体读取超时的合法区间与默认值（秒）
pub const MIN_BODY_IDLE_TIMEOUT_SECS: i64 = 5;
pub const MAX_BODY_IDLE_TIMEOUT_SECS: i64 = 300;
pub const DEFAULT_BODY_IDLE_TIMEOUT_SECS: u64 = 60;
pub const MIN_BODY_TOTAL_TIMEOUT_SECS: i64 = 30;
pub const MAX_BODY_TOTAL_TIMEOUT_SECS: i64 = 1800;
pub const DEFAULT_BODY_TOTAL_TIMEOUT_SECS: u64 = 600;

/// 读缓存保留天数；未设置/脏值回退默认（启动清理不能因为设置损坏而停摆）
pub fn cache_retention_days() -> i64 {
    let c = match conn() {
        Ok(c) => c,
        Err(_) => return DEFAULT_CACHE_RETENTION_DAYS,
    };
    cache_retention_days_in(&c)
}

pub(crate) fn cache_retention_days_in(c: &Connection) -> i64 {
    c.query_row(
        "SELECT value FROM settings WHERE key = 'cacheRetentionDays'",
        [],
        |r| r.get::<_, String>(0),
    )
    .ok()
    .and_then(|v| v.trim().parse::<i64>().ok())
    .filter(|n| (MIN_CACHE_RETENTION_DAYS..=MAX_CACHE_RETENTION_DAYS).contains(n))
    .unwrap_or(DEFAULT_CACHE_RETENTION_DAYS)
}

/// 读响应体读取超时（无数据 / 总时长，秒）。
/// 未设置、脏值或越界一律回退默认；总时长低于空闲时抬到空闲值，
/// 避免配置损坏导致「空闲阈值永远等不到」。
pub fn body_timeout_secs() -> (u64, u64) {
    match conn() {
        Ok(c) => body_timeout_secs_in(&c),
        Err(_) => (
            DEFAULT_BODY_IDLE_TIMEOUT_SECS,
            DEFAULT_BODY_TOTAL_TIMEOUT_SECS,
        ),
    }
}

pub(crate) fn body_timeout_secs_in(c: &Connection) -> (u64, u64) {
    let read = |key: &str, min: i64, max: i64| -> Option<u64> {
        c.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|n| (min..=max).contains(n))
        .map(|n| n as u64)
    };
    let idle = read(
        "bodyIdleTimeoutSecs",
        MIN_BODY_IDLE_TIMEOUT_SECS,
        MAX_BODY_IDLE_TIMEOUT_SECS,
    )
    .unwrap_or(DEFAULT_BODY_IDLE_TIMEOUT_SECS);
    let total = read(
        "bodyTotalTimeoutSecs",
        MIN_BODY_TOTAL_TIMEOUT_SECS,
        MAX_BODY_TOTAL_TIMEOUT_SECS,
    )
    .unwrap_or(DEFAULT_BODY_TOTAL_TIMEOUT_SECS);
    (idle, total.max(idle))
}

/// 导入时允许写入的设置项。v1 只有旧版导出的两项；v2 增加主题与自定义模板。
const IMPORT_SETTINGS_V1: &[&str] = &["defaultProviderId", "defaultParams"];
const IMPORT_SETTINGS_V2: &[&str] = &[
    "defaultProviderId",
    "defaultParams",
    "theme",
    "promptTemplates",
    "stylePresets",
    "glassAppearance",
    "uiMode",
    "locale",
    "queueConcurrency",
    "queueProviderConcurrency",
    "queueAutoResume",
    "cacheRetentionDays",
    "bodyIdleTimeoutSecs",
    "bodyTotalTimeoutSecs",
    "smartMask",
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
    if let Some(glass) = settings.get("glassAppearance") {
        let ok = glass
            .as_str()
            .is_some_and(|g| matches!(g, "clear" | "standard" | "tinted"));
        if !ok {
            return Err(invalid_import("导入文件中的玻璃质感取值非法"));
        }
    }
    if let Some(templates) = settings.get("promptTemplates") {
        validate_import_templates(templates)?;
    }
    if let Some(styles) = settings.get("stylePresets") {
        validate_import_style_presets(styles)?;
    }
    if let Some(mode) = settings.get("uiMode") {
        let ok = mode
            .as_str()
            .is_some_and(|m| matches!(m, "simple" | "expert"));
        if !ok {
            return Err(invalid_import("导入文件中的界面模式取值非法"));
        }
    }
    if let Some(locale) = settings.get("locale") {
        let ok = locale
            .as_str()
            .is_some_and(|l| matches!(l, "zh-CN" | "en-US"));
        if !ok {
            return Err(invalid_import("导入文件中的界面语言取值非法"));
        }
    }
    if let Some(smart) = settings.get("smartMask") {
        let ok = smart.as_str().is_some_and(|v| matches!(v, "on" | "off"));
        if !ok {
            return Err(invalid_import("导入文件中的智能蒙版开关取值非法"));
        }
    }
    if let Some(auto) = settings.get("queueAutoResume") {
        let ok = auto.as_str().is_some_and(|v| matches!(v, "on" | "off"));
        if !ok {
            return Err(invalid_import("导入文件中的队列自动续跑开关取值非法"));
        }
    }
    if let Some(concurrency) = settings.get("queueConcurrency") {
        let ok = concurrency
            .as_str()
            .and_then(|v| v.trim().parse::<i64>().ok())
            .is_some_and(|n| {
                (crate::commands::queue::MIN_CONCURRENCY..=crate::commands::queue::MAX_CONCURRENCY)
                    .contains(&n)
            });
        if !ok {
            return Err(invalid_import("导入文件中的队列并发数取值非法"));
        }
    }
    if let Some(concurrency) = settings.get("queueProviderConcurrency") {
        let ok = concurrency
            .as_str()
            .and_then(|v| v.trim().parse::<i64>().ok())
            .is_some_and(|n| {
                (crate::commands::queue::MIN_PROVIDER_CONCURRENCY
                    ..=crate::commands::queue::MAX_PROVIDER_CONCURRENCY)
                    .contains(&n)
            });
        if !ok {
            return Err(invalid_import("导入文件中的每服务商并发数取值非法"));
        }
    }
    if let Some(days) = settings.get("cacheRetentionDays") {
        let ok = days
            .as_str()
            .and_then(|v| v.trim().parse::<i64>().ok())
            .is_some_and(|n| (MIN_CACHE_RETENTION_DAYS..=MAX_CACHE_RETENTION_DAYS).contains(&n));
        if !ok {
            return Err(invalid_import(
                "导入文件中的缓存保留天数取值非法（应为 1–365）",
            ));
        }
    }
    let idle = match settings.get("bodyIdleTimeoutSecs") {
        None => None,
        Some(v) => match v
            .as_str()
            .and_then(|s| s.trim().parse::<i64>().ok())
            .filter(|n| (MIN_BODY_IDLE_TIMEOUT_SECS..=MAX_BODY_IDLE_TIMEOUT_SECS).contains(n))
        {
            Some(n) => Some(n),
            None => {
                return Err(invalid_import(
                    "导入文件中的无数据超时取值非法（应为 5–300）",
                ))
            }
        },
    };
    let total = match settings.get("bodyTotalTimeoutSecs") {
        None => None,
        Some(v) => match v
            .as_str()
            .and_then(|s| s.trim().parse::<i64>().ok())
            .filter(|n| (MIN_BODY_TOTAL_TIMEOUT_SECS..=MAX_BODY_TOTAL_TIMEOUT_SECS).contains(n))
        {
            Some(n) => Some(n),
            None => {
                return Err(invalid_import(
                    "导入文件中的响应体总超时取值非法（应为 30–1800）",
                ))
            }
        },
    };
    if let (Some(idle), Some(total)) = (idle, total) {
        if total < idle {
            return Err(invalid_import("导入文件中的响应体总超时不能小于无数据超时"));
        }
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

fn validate_import_style_presets(value: &serde_json::Value) -> AppResult<()> {
    let raw = value
        .as_str()
        .ok_or_else(|| invalid_import("自定义风格必须是 JSON 字符串"))?;
    let parsed: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| invalid_import("自定义风格不是合法 JSON"))?;
    let list = parsed
        .as_array()
        .ok_or_else(|| invalid_import("自定义风格必须是数组"))?;
    for item in list {
        let obj = item
            .as_object()
            .ok_or_else(|| invalid_import("自定义风格项必须是对象"))?;
        for key in ["id", "label", "prompt"] {
            let ok = obj
                .get(key)
                .and_then(|v| v.as_str())
                .is_some_and(|s| !s.trim().is_empty());
            if !ok {
                return Err(invalid_import("自定义风格项缺少 id/label/prompt"));
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
/// 把编辑/变换模板的三项字段拼成 JSON 存列；全空时存空串（= 未配置）。
/// providers/save 与 import 共用，保证两条写入路径的格式一致。
pub(crate) fn template_spec_json(url: &str, body: &str, response_path: &str) -> String {
    if url.trim().is_empty() && body.trim().is_empty() && response_path.trim().is_empty() {
        return String::new();
    }
    serde_json::json!({
        "url": url,
        "body": body,
        "responsePath": response_path,
    })
    .to_string()
}

#[cfg(test)]
pub fn import_config(data: &serde_json::Value) -> AppResult<usize> {
    let mut c = conn()?;
    import_config_in(&mut c, data)
}

/// 预设参考图的落盘回调：输入 data URL，返回保存后的绝对路径。
pub type RefWriter<'a> = Option<&'a dyn Fn(&str) -> AppResult<String>>;

/// 备份 v4 的预设参考图需要重新落盘：由调用方注入写文件闭包（单测传 None）。
pub fn import_config_with_refs(
    data: &serde_json::Value,
    write_ref: RefWriter<'_>,
) -> AppResult<usize> {
    // F-013：参考图落盘（慢 IO）在取 DB 锁之前完成，导入期间 UI 的读写不再被堵住。
    let assets = prepare_import_assets(data, write_ref)?;
    let mut c = conn()?;
    import_config_in_prepared(&mut c, data, assets)
}

#[derive(Debug)]
struct ImportFavorite {
    text: String,
    tags_json: String,
    created_at: String,
}

#[derive(Debug)]
struct ImportPreset {
    name: String,
    prompt: String,
    negative_prompt: String,
    params_json: String,
    refs_json: String,
    created_at: String,
    updated_at: String,
}

const MAX_IMPORT_FAVORITES: usize = 500;
const MAX_IMPORT_PRESETS: usize = 200;
const MAX_IMPORT_REF_DATA_URL: usize = 12 * 1024 * 1024;

fn import_ref_role_ok(role: &str) -> bool {
    matches!(role, "composition" | "style" | "face" | "element")
}

/// v4：收藏与预设数组的结构校验。任何一项非法都在事务与 DELETE 之前失败。
fn parse_import_prompt_assets(
    data: &serde_json::Value,
    write_ref: RefWriter<'_>,
) -> AppResult<(Vec<ImportFavorite>, Vec<ImportPreset>)> {
    let favorites_raw = data
        .get("favorites")
        .and_then(|v| v.as_array())
        .ok_or_else(|| invalid_import("导入文件缺少 favorites 数组"))?;
    if favorites_raw.len() > MAX_IMPORT_FAVORITES {
        return Err(invalid_import("导入文件中的收藏数量过多"));
    }
    let mut favorites = Vec::with_capacity(favorites_raw.len());
    for item in favorites_raw {
        let text = item
            .get("text")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .ok_or_else(|| invalid_import("收藏条目缺少提示词文本"))?;
        let tags: Vec<String> = match item.get("tags") {
            None | Some(serde_json::Value::Null) => Vec::new(),
            Some(v) => {
                let arr = v
                    .as_array()
                    .ok_or_else(|| invalid_import("收藏标签必须是字符串数组"))?;
                arr.iter()
                    .map(|t| {
                        t.as_str()
                            .map(str::to_string)
                            .ok_or_else(|| invalid_import("收藏标签必须是字符串数组"))
                    })
                    .collect::<AppResult<Vec<_>>>()?
            }
        };
        let tags = normalize_tags(&tags);
        favorites.push(ImportFavorite {
            text: text.to_string(),
            tags_json: serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into()),
            created_at: item
                .get("createdAt")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
        });
    }

    let presets_raw = data
        .get("presets")
        .and_then(|v| v.as_array())
        .ok_or_else(|| invalid_import("导入文件缺少 presets 数组"))?;
    if presets_raw.len() > MAX_IMPORT_PRESETS {
        return Err(invalid_import("导入文件中的预设数量过多"));
    }
    let mut presets = Vec::with_capacity(presets_raw.len());
    for item in presets_raw {
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .ok_or_else(|| invalid_import("预设缺少名称"))?;
        if name.chars().count() > MAX_PRESET_NAME_CHARS {
            return Err(invalid_import("预设名称过长"));
        }
        let params = match item.get("params") {
            None | Some(serde_json::Value::Null) => serde_json::json!({}),
            Some(v) if v.is_object() => v.clone(),
            Some(_) => return Err(invalid_import("预设参数必须是对象")),
        };
        let refs_raw = match item.get("refs") {
            None | Some(serde_json::Value::Null) => Vec::new(),
            Some(v) => v
                .as_array()
                .cloned()
                .ok_or_else(|| invalid_import("预设参考图必须是数组"))?,
        };
        if refs_raw.len() > MAX_PRESET_REFS {
            return Err(invalid_import("预设参考图超过上限"));
        }
        let mut refs = Vec::with_capacity(refs_raw.len());
        for r in refs_raw {
            let role = r.get("role").and_then(|v| v.as_str()).unwrap_or_default();
            if !import_ref_role_ok(role) {
                return Err(invalid_import("预设参考角色非法"));
            }
            let strength = r.get("strength").and_then(|v| v.as_u64()).unwrap_or(60);
            if strength > 100 {
                return Err(invalid_import("预设参考强度必须在 0–100 之间"));
            }
            let data_url = r
                .get("dataUrl")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if !data_url.starts_with("data:image/") {
                return Err(invalid_import("预设参考图缺少有效的 dataUrl"));
            }
            if data_url.len() > MAX_IMPORT_REF_DATA_URL {
                return Err(invalid_import("预设参考图过大"));
            }
            let path = match write_ref {
                Some(write) => write(data_url)?,
                None => String::new(),
            };
            if path.is_empty() {
                continue;
            }
            refs.push(PresetRef {
                path,
                role: role.to_string(),
                strength: strength as u32,
            });
        }
        presets.push(ImportPreset {
            name: name.to_string(),
            prompt: item
                .get("prompt")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            negative_prompt: item
                .get("negativePrompt")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            params_json: serde_json::to_string(&params).unwrap_or_else(|_| "{}".into()),
            refs_json: serde_json::to_string(&refs).unwrap_or_else(|_| "[]".into()),
            created_at: item
                .get("createdAt")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            updated_at: item
                .get("updatedAt")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
        });
    }
    Ok((favorites, presets))
}

fn insert_import_prompt_assets(
    tx: &rusqlite::Transaction<'_>,
    favorites: &[ImportFavorite],
    presets: &[ImportPreset],
) -> AppResult<()> {
    tx.execute("DELETE FROM prompt_favorites", [])?;
    tx.execute("DELETE FROM workflow_presets", [])?;
    let now = timestamp_millis();
    for f in favorites {
        let created = if f.created_at.is_empty() {
            now.as_str()
        } else {
            f.created_at.as_str()
        };
        tx.execute(
            "INSERT INTO prompt_favorites (text, tags_json, created_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(text) DO UPDATE SET tags_json = excluded.tags_json",
            params![f.text, f.tags_json, created],
        )?;
    }
    for p in presets {
        let created = if p.created_at.is_empty() {
            now.as_str()
        } else {
            p.created_at.as_str()
        };
        let updated = if p.updated_at.is_empty() {
            created
        } else {
            p.updated_at.as_str()
        };
        tx.execute(
            "INSERT INTO workflow_presets
             (name, prompt, negative_prompt, params_json, refs_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                p.name,
                p.prompt,
                p.negative_prompt,
                p.params_json,
                p.refs_json,
                created,
                updated
            ],
        )?;
    }
    Ok(())
}

/// import_config 的可测接缝：在给定连接上执行导入（单测用内存库，避免共享全局 DB）。
/// 入参校验放在事务与 DELETE 之前，非法导入绝不触碰表内旧数据。
#[cfg(test)]
fn import_config_in(c: &mut Connection, data: &serde_json::Value) -> AppResult<usize> {
    let assets = prepare_import_assets(data, None)?;
    import_config_in_prepared(c, data, assets)
}

/// 单测接缝：在给定连接上执行导入，参考图落盘仍走本连接（测试用内存库，无锁竞争）。
#[cfg(test)]
fn import_config_in_with_refs(
    c: &mut Connection,
    data: &serde_json::Value,
    write_ref: RefWriter<'_>,
) -> AppResult<usize> {
    let assets = prepare_import_assets(data, write_ref)?;
    import_config_in_prepared(c, data, assets)
}

/// 导入前的「慢准备」：预设参考图落盘。
///
/// F-013：这一步必须发生在拿 DB 锁之前——原先在 `conn()` 的 Mutex 内写文件，
/// 大导入期间所有 UI 读写都被堵在同一条连接后面。校验失败或事务回滚只会留下
/// 孤儿文件，由 image_gc 回收（与事务失败同口径）。
fn prepare_import_assets(
    data: &serde_json::Value,
    write_ref: RefWriter<'_>,
) -> AppResult<Option<(Vec<ImportFavorite>, Vec<ImportPreset>)>> {
    let version = data.get("version").and_then(|v| v.as_u64()).unwrap_or(1);
    if version < 4 {
        return Ok(None);
    }
    Ok(Some(parse_import_prompt_assets(data, write_ref)?))
}

fn import_config_in_prepared(
    c: &mut Connection,
    data: &serde_json::Value,
    prompt_assets: Option<(Vec<ImportFavorite>, Vec<ImportPreset>)>,
) -> AppResult<usize> {
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
    debug_assert!(
        version < 4 || prompt_assets.is_some(),
        "v4 导入必须先在锁外准备好预设参考图"
    );

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
             default_model, timeout_secs, template_url, template_body, template_response_path,
             edit_template_json, transform_template_json)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            params![
                name,
                base_url,
                enc,
                keys_enc,
                get("kind"),
                get("modelsJson"),
                get("defaultModel"),
                p.get("timeoutSecs")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(DEFAULT_PROVIDER_TIMEOUT_SECS) as i64,
                get("templateUrl"),
                get("templateBody"),
                get("templateResponsePath"),
                template_spec_json(
                    &get("editTemplateUrl"),
                    &get("editTemplateBody"),
                    &get("editTemplateResponsePath")
                ),
                template_spec_json(
                    &get("transformTemplateUrl"),
                    &get("transformTemplateBody"),
                    &get("transformTemplateResponsePath")
                )
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
            "titleEnabled": obj.get("titleEnabled").and_then(|v| v.as_bool()).unwrap_or(true),
            "optimizeEnabled": obj.get("optimizeEnabled").and_then(|v| v.as_bool()).unwrap_or(true),
            "autoTranslateOnBlur": obj
                .get("autoTranslateOnBlur")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
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
    // v4：收藏与预设为替换语义；v1–v3 备份不触碰本机现有资产
    if let Some((favorites, presets)) = &prompt_assets {
        insert_import_prompt_assets(&tx, favorites, presets)?;
    }
    tx.commit()?;
    Ok(providers.len())
}

pub fn add_history(h: &HistoryRow) -> AppResult<i64> {
    let c = conn()?;
    c.execute(
        "INSERT INTO history (prompt, negative_prompt, model, provider_name, seed, width,
         height, guidance, steps, style, file_path, favorite, created_at, parent_id, op)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
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
            h.created_at,
            h.parent_id,
            h.op
        ],
    )?;
    Ok(c.last_insert_rowid())
}

pub fn list_history(
    limit: i64,
    offset: i64,
    before_id: Option<i64>,
    model_filter: &str,
    style_filter: &str,
    favorite_only: bool,
) -> AppResult<Vec<HistoryRow>> {
    let c = conn()?;
    list_history_in(
        &c,
        limit,
        offset,
        before_id,
        model_filter,
        style_filter,
        favorite_only,
    )
}

pub(crate) fn list_history_in(
    c: &Connection,
    limit: i64,
    offset: i64,
    before_id: Option<i64>,
    model_filter: &str,
    style_filter: &str,
    favorite_only: bool,
) -> AppResult<Vec<HistoryRow>> {
    // 分页参数钳制（F-015）：SQLite 里 LIMIT -1 等于不限，负 offset 会被当成 0，
    // 直接绑定调用方传来的值等于把「一次拉全库」的能力暴露给 IPC。
    let limit = limit.clamp(1, 200);
    let offset = offset.max(0);
    let before_id = before_id.filter(|id| *id > 0);
    let mut conditions = Vec::new();
    if before_id.is_some() {
        conditions.push("id < ?");
    }
    if !model_filter.is_empty() {
        conditions.push("model = ?");
    }
    if !style_filter.is_empty() {
        conditions.push("style = ?");
    }
    if favorite_only {
        conditions.push("favorite = 1");
    }
    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };
    let sql = format!(
        "SELECT id, prompt, negative_prompt, model, provider_name, seed, width, height,
         guidance, steps, style, file_path, favorite, created_at, parent_id, op
         FROM history{where_clause} ORDER BY id DESC LIMIT ? OFFSET ?"
    );
    let mut stmt = c.prepare(&sql)?;
    let mut values: Vec<&dyn rusqlite::ToSql> = Vec::new();
    if let Some(before_id) = before_id.as_ref() {
        values.push(before_id);
    }
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
        parent_id: row.get(14)?,
        op: row.get(15)?,
    })
}

/// 按 id 取一条历史记录（transform_image 需要父图的尺寸与提示词）
pub fn history_row(id: i64) -> AppResult<Option<HistoryRow>> {
    let c = conn()?;
    let mut stmt = c.prepare(
        "SELECT id, prompt, negative_prompt, model, provider_name, seed, width, height,
         guidance, steps, style, file_path, favorite, created_at, parent_id, op
         FROM history WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], history_from_row)?;
    Ok(rows.next().transpose()?)
}

/// 同族图片：沿 parent_id 上溯到根，再返回「根 + 它的直接派生」。
/// 上溯最多 32 跳，防止脏数据成环时死循环。
pub fn list_derived(id: i64) -> AppResult<Vec<HistoryRow>> {
    let Some(mut row) = history_row(id)? else {
        return Ok(Vec::new());
    };
    let mut root = row.id;
    for _ in 0..32 {
        match row.parent_id {
            Some(p) if p != root => match history_row(p)? {
                Some(parent) => {
                    root = parent.id;
                    row = parent;
                }
                None => break,
            },
            _ => break,
        }
    }
    let c = conn()?;
    let mut stmt = c.prepare(
        "SELECT id, prompt, negative_prompt, model, provider_name, seed, width, height,
         guidance, steps, style, file_path, favorite, created_at, parent_id, op
         FROM history WHERE id = ?1 OR parent_id = ?1 ORDER BY id ASC",
    )?;
    let rows = stmt.query_map(params![root], history_from_row)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

pub fn set_favorite(id: i64, favorite: bool) -> AppResult<()> {
    conn()?.execute(
        "UPDATE history SET favorite = ?2 WHERE id = ?1",
        params![id, favorite as i64],
    )?;
    Ok(())
}

// ---------- 提示词资产（迁移 009） ----------

fn favorite_from_row(row: &rusqlite::Row) -> rusqlite::Result<PromptFavorite> {
    let tags_json: String = row.get(2)?;
    Ok(PromptFavorite {
        id: row.get(0)?,
        text: row.get(1)?,
        tags: parse_tags(&tags_json),
        created_at: row.get(3)?,
    })
}

fn parse_tags(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

fn normalize_tags(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tag in tags {
        let tag = tag.trim();
        if tag.is_empty() || out.iter().any(|t| t == tag) {
            continue;
        }
        out.push(tag.to_string());
        if out.len() >= MAX_FAVORITE_TAGS {
            break;
        }
    }
    out
}

pub fn list_favorites() -> AppResult<Vec<PromptFavorite>> {
    let c = conn()?;
    list_favorites_in(&c)
}

pub(crate) fn list_favorites_in(c: &Connection) -> AppResult<Vec<PromptFavorite>> {
    let mut stmt = c.prepare(
        "SELECT id, text, tags_json, created_at FROM prompt_favorites
         ORDER BY created_at DESC, id DESC",
    )?;
    let rows = stmt.query_map([], favorite_from_row)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

/// 同一段提示词重复收藏时只更新标签，不产生第二条记录。
pub fn upsert_favorite(text: &str, tags: &[String]) -> AppResult<PromptFavorite> {
    let c = conn()?;
    upsert_favorite_in(&c, text, tags)
}

pub(crate) fn upsert_favorite_in(
    c: &Connection,
    text: &str,
    tags: &[String],
) -> AppResult<PromptFavorite> {
    let text = text.trim();
    if text.is_empty() {
        return Err(AppError::Other("收藏的提示词不能为空".into()));
    }
    let tags = normalize_tags(tags);
    let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into());
    c.execute(
        "INSERT INTO prompt_favorites (text, tags_json, created_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(text) DO UPDATE SET tags_json = excluded.tags_json",
        params![text, tags_json, timestamp_millis()],
    )?;
    c.query_row(
        "SELECT id, text, tags_json, created_at FROM prompt_favorites WHERE text = ?1",
        params![text],
        favorite_from_row,
    )
    .map_err(AppError::from)
}

pub fn delete_favorite(id: i64) -> AppResult<bool> {
    let c = conn()?;
    delete_favorite_in(&c, id)
}

pub(crate) fn delete_favorite_in(c: &Connection, id: i64) -> AppResult<bool> {
    Ok(c.execute("DELETE FROM prompt_favorites WHERE id = ?1", params![id])? > 0)
}

fn preset_from_row(row: &rusqlite::Row) -> rusqlite::Result<WorkflowPreset> {
    let refs_json: String = row.get(5)?;
    Ok(WorkflowPreset {
        id: row.get(0)?,
        name: row.get(1)?,
        prompt: row.get(2)?,
        negative_prompt: row.get(3)?,
        params_json: row.get(4)?,
        refs: parse_preset_refs(&refs_json),
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn parse_preset_refs(raw: &str) -> Vec<PresetRef> {
    serde_json::from_str::<Vec<PresetRef>>(raw).unwrap_or_default()
}

fn validate_preset_refs(refs: &[PresetRef]) -> AppResult<()> {
    if refs.len() > MAX_PRESET_REFS {
        return Err(AppError::Other(format!(
            "预设最多保存 {MAX_PRESET_REFS} 张参考图"
        )));
    }
    for r in refs {
        if r.path.trim().is_empty() {
            return Err(AppError::Other("预设中的参考图路径不能为空".into()));
        }
        if !matches!(
            r.role.as_str(),
            "composition" | "style" | "face" | "element"
        ) {
            return Err(AppError::Other(format!("预设中的参考角色非法: {}", r.role)));
        }
        if r.strength > 100 {
            return Err(AppError::Other("预设中的参考强度必须在 0–100 之间".into()));
        }
    }
    Ok(())
}

pub fn list_presets() -> AppResult<Vec<WorkflowPreset>> {
    let c = conn()?;
    list_presets_in(&c)
}

pub(crate) fn list_presets_in(c: &Connection) -> AppResult<Vec<WorkflowPreset>> {
    let mut stmt = c.prepare(
        "SELECT id, name, prompt, negative_prompt, params_json, refs_json, created_at, updated_at
         FROM workflow_presets ORDER BY updated_at DESC, id DESC",
    )?;
    let rows = stmt.query_map([], preset_from_row)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

/// 保存预设：`id` 为空时新建，否则覆盖同名记录并刷新 `updated_at`。
pub fn save_preset(
    id: Option<i64>,
    name: &str,
    prompt: &str,
    negative_prompt: &str,
    params_json: &str,
    refs: &[PresetRef],
) -> AppResult<WorkflowPreset> {
    let c = conn()?;
    save_preset_in(&c, id, name, prompt, negative_prompt, params_json, refs)
}

pub(crate) fn save_preset_in(
    c: &Connection,
    id: Option<i64>,
    name: &str,
    prompt: &str,
    negative_prompt: &str,
    params_json: &str,
    refs: &[PresetRef],
) -> AppResult<WorkflowPreset> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Other("预设名称不能为空".into()));
    }
    if name.chars().count() > MAX_PRESET_NAME_CHARS {
        return Err(AppError::Other(format!(
            "预设名称不能超过 {MAX_PRESET_NAME_CHARS} 个字符"
        )));
    }
    if params_json.len() > 64 * 1024 {
        return Err(AppError::Other("预设参数过大".into()));
    }
    let params: serde_json::Value = serde_json::from_str(params_json)
        .map_err(|_| AppError::Other("预设参数不是合法 JSON".into()))?;
    if !params.is_object() {
        return Err(AppError::Other("预设参数必须是 JSON 对象".into()));
    }
    validate_preset_refs(refs)?;
    let refs_json = serde_json::to_string(refs).unwrap_or_else(|_| "[]".into());
    let now = timestamp_millis();
    let preset_id = match id {
        Some(id) => {
            let changed = c.execute(
                "UPDATE workflow_presets SET name = ?2, prompt = ?3, negative_prompt = ?4,
                 params_json = ?5, refs_json = ?6, updated_at = ?7 WHERE id = ?1",
                params![
                    id,
                    name,
                    prompt,
                    negative_prompt,
                    params_json,
                    refs_json,
                    now
                ],
            )?;
            if changed == 0 {
                return Err(AppError::Other("预设不存在或已被删除".into()));
            }
            id
        }
        None => {
            c.execute(
                "INSERT INTO workflow_presets
                 (name, prompt, negative_prompt, params_json, refs_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params![name, prompt, negative_prompt, params_json, refs_json, now],
            )?;
            c.last_insert_rowid()
        }
    };
    c.query_row(
        "SELECT id, name, prompt, negative_prompt, params_json, refs_json, created_at, updated_at
         FROM workflow_presets WHERE id = ?1",
        params![preset_id],
        preset_from_row,
    )
    .map_err(AppError::from)
}

pub fn delete_preset(id: i64) -> AppResult<bool> {
    let c = conn()?;
    delete_preset_in(&c, id)
}

pub(crate) fn delete_preset_in(c: &Connection, id: i64) -> AppResult<bool> {
    Ok(c.execute("DELETE FROM workflow_presets WHERE id = ?1", params![id])? > 0)
}

fn canvas_meta_from_row(row: &rusqlite::Row) -> rusqlite::Result<CanvasBoardMeta> {
    Ok(CanvasBoardMeta {
        id: row.get(0)?,
        name: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
    })
}

fn canvas_board_from_row(row: &rusqlite::Row) -> rusqlite::Result<CanvasBoard> {
    Ok(CanvasBoard {
        id: row.get(0)?,
        name: row.get(1)?,
        data_json: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

fn validate_canvas_name(name: &str) -> AppResult<&str> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Other("画布名称不能为空".into()));
    }
    if name.chars().count() > MAX_CANVAS_NAME_CHARS {
        return Err(AppError::Other(format!(
            "画布名称不能超过 {MAX_CANVAS_NAME_CHARS} 个字符"
        )));
    }
    Ok(name)
}

/// 画布数据校验：节点 id 唯一、边只引用已存在的节点、视口数值有限。
/// 只校验结构与引用关系，不约束节点业务字段（局部重绘等参数由编辑器自己校验）。
fn validate_canvas_data(raw: &str) -> AppResult<()> {
    if raw.len() > MAX_CANVAS_JSON_BYTES {
        return Err(AppError::Other("画布数据过大（上限 2MB）".into()));
    }
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| AppError::Other("画布数据不是合法 JSON".into()))?;
    let obj = value
        .as_object()
        .ok_or_else(|| AppError::Other("画布数据必须是 JSON 对象".into()))?;

    let nodes = obj
        .get("nodes")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| AppError::Other("画布数据缺少节点数组".into()))?;
    if nodes.len() > MAX_CANVAS_NODES {
        return Err(AppError::Other(format!(
            "画布节点不能超过 {MAX_CANVAS_NODES} 个"
        )));
    }
    let mut ids = HashSet::new();
    for node in nodes {
        let node = node
            .as_object()
            .ok_or_else(|| AppError::Other("画布节点必须是对象".into()))?;
        let id = match node.get("id") {
            Some(serde_json::Value::String(s)) if !s.trim().is_empty() => s.clone(),
            Some(serde_json::Value::Number(n)) => n.to_string(),
            _ => return Err(AppError::Other("画布节点缺少有效 id".into())),
        };
        if !ids.insert(id) {
            return Err(AppError::Other("画布节点 id 不能重复".into()));
        }
    }

    let edges = obj
        .get("edges")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| AppError::Other("画布数据缺少连线数组".into()))?;
    for edge in edges {
        let edge = edge
            .as_object()
            .ok_or_else(|| AppError::Other("画布连线必须是对象".into()))?;
        let from = edge
            .get("from")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| AppError::Other("画布连线缺少起点".into()))?;
        let to = edge
            .get("to")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| AppError::Other("画布连线缺少终点".into()))?;
        if !ids.contains(from) || !ids.contains(to) {
            return Err(AppError::Other("画布连线引用了不存在的节点".into()));
        }
    }

    let viewport = obj
        .get("viewport")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| AppError::Other("画布数据缺少视口".into()))?;
    for key in ["x", "y", "zoom"] {
        let value = viewport
            .get(key)
            .and_then(serde_json::Value::as_f64)
            .ok_or_else(|| AppError::Other(format!("画布视口缺少数值 {key}")))?;
        if !value.is_finite() {
            return Err(AppError::Other(format!("画布视口 {key} 必须是有限数值")));
        }
    }
    Ok(())
}

pub fn list_canvas_boards() -> AppResult<Vec<CanvasBoardMeta>> {
    let c = conn()?;
    list_canvas_boards_in(&c)
}

pub(crate) fn list_canvas_boards_in(c: &Connection) -> AppResult<Vec<CanvasBoardMeta>> {
    let mut stmt = c.prepare(
        "SELECT id, name, created_at, updated_at FROM canvas_boards
         ORDER BY updated_at DESC, id DESC",
    )?;
    let rows = stmt.query_map([], canvas_meta_from_row)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

fn get_canvas_board_in(c: &Connection, id: i64) -> AppResult<Option<CanvasBoard>> {
    c.query_row(
        "SELECT id, name, data_json, created_at, updated_at FROM canvas_boards WHERE id = ?1",
        params![id],
        canvas_board_from_row,
    )
    .optional()
    .map_err(AppError::from)
}

pub fn create_canvas_board(name: &str) -> AppResult<CanvasBoard> {
    let c = conn()?;
    create_canvas_board_in(&c, name)
}

pub(crate) fn create_canvas_board_in(c: &Connection, name: &str) -> AppResult<CanvasBoard> {
    let name = validate_canvas_name(name)?;
    let now = timestamp_millis();
    c.execute(
        "INSERT INTO canvas_boards (name, data_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![name, CANVAS_DEFAULT_DATA, now, now],
    )?;
    let id = c.last_insert_rowid();
    get_canvas_board_in(c, id)?.ok_or_else(|| AppError::Other("新建画布后读取失败".into()))
}

pub fn get_canvas_board(id: i64) -> AppResult<Option<CanvasBoard>> {
    let c = conn()?;
    get_canvas_board_in(&c, id)
}

pub fn save_canvas_board(id: i64, name: &str, data_json: &str) -> AppResult<CanvasBoard> {
    let c = conn()?;
    save_canvas_board_in(&c, id, name, data_json)
}

pub(crate) fn save_canvas_board_in(
    c: &Connection,
    id: i64,
    name: &str,
    data_json: &str,
) -> AppResult<CanvasBoard> {
    let name = validate_canvas_name(name)?;
    validate_canvas_data(data_json)?;
    let changed = c.execute(
        "UPDATE canvas_boards SET name = ?2, data_json = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, name, data_json, timestamp_millis()],
    )?;
    if changed == 0 {
        return Err(AppError::Other(format!("画布 #{id} 不存在")));
    }
    get_canvas_board_in(c, id)?.ok_or_else(|| AppError::Other(format!("画布 #{id} 保存后读取失败")))
}

pub fn delete_canvas_board(id: i64) -> AppResult<bool> {
    let c = conn()?;
    delete_canvas_board_in(&c, id)
}

pub(crate) fn delete_canvas_board_in(c: &Connection, id: i64) -> AppResult<bool> {
    Ok(c.execute("DELETE FROM canvas_boards WHERE id = ?1", params![id])? > 0)
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

/// 引用集合 = `history.file_path` ∪ `messages.images_json[].path`
/// ∪ `jobs.images_json[].path` ∪ `jobs.input_json.referencePaths`
/// ∪ `workflow_presets.refs_json[].path`。
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
        WHERE j.type = 'object' AND json_type(j.value, '$.path') = 'text'
        UNION
        SELECT json_extract(j.value, '$.path')
        FROM jobs q
        JOIN json_each(CASE WHEN json_valid(q.images_json)
                            THEN q.images_json ELSE '[]' END) AS j
        WHERE j.type = 'object' AND json_type(j.value, '$.path') = 'text'
        UNION
        SELECT rp.value
        FROM jobs q
        JOIN json_each(CASE WHEN json_valid(q.input_json)
                            THEN q.input_json ELSE '{}' END, '$.referencePaths') AS rp
        WHERE rp.type = 'text'
        UNION
        SELECT json_extract(r.value, '$.path')
        FROM workflow_presets p
        JOIN json_each(CASE WHEN json_valid(p.refs_json)
                            THEN p.refs_json ELSE '[]' END) AS r
        WHERE r.type = 'object' AND json_type(r.value, '$.path') = 'text'
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

/// 媒体根归一化键：分隔符统一、忽略大小写、去掉尾部分隔符。
fn media_root_key(p: &Path) -> String {
    normalize_path_key(&p.to_string_lossy())
        .trim_end_matches('\\')
        .to_string()
}

/// 单条路径改写：只有落在旧根之下的路径才改写，其余原样不动。
fn rewrite_path(p: &str, old_key: &str, new_root: &str) -> Option<String> {
    let orig = p.trim();
    let key = normalize_path_key(orig);
    let prefix = format!("{old_key}\\");
    if !key.starts_with(&prefix) {
        return None;
    }
    // 保留原路径的相对部分与大小写；非 ASCII 大小写折叠可能改变字节长度，
    // 切不出原串时退回归一化尾段（Windows 下大小写不敏感，仍可解析）。
    let tail = orig
        .get(old_key.len()..)
        .map(|t| t.replace('/', "\\"))
        .unwrap_or_else(|| key[old_key.len()..].to_string());
    Some(format!("{new_root}{tail}"))
}

/// 改写 `[{path}]` 形态的 JSON 列（messages / jobs 的 images_json、预设 refs_json）
fn rewrite_json_path_array(
    tx: &Connection,
    table: &str,
    column: &str,
    old_key: &str,
    new_root: &str,
) -> AppResult<usize> {
    let rows: Vec<(i64, String)> = {
        let sql = format!("SELECT id, \"{column}\" FROM \"{table}\" WHERE \"{column}\" <> ''");
        let mut stmt = tx.prepare(&sql)?;
        let mapped = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        mapped.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut changed = 0usize;
    for (id, raw) in rows {
        let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let Some(items) = value.as_array_mut() else {
            continue;
        };
        let mut touched = 0usize;
        for item in items {
            let Some(path) = item.get("path").and_then(|v| v.as_str()) else {
                continue;
            };
            if let Some(next) = rewrite_path(path, old_key, new_root) {
                if let Some(obj) = item.as_object_mut() {
                    obj.insert("path".into(), next.into());
                    touched += 1;
                }
            }
        }
        if touched == 0 {
            continue;
        }
        let sql = format!("UPDATE \"{table}\" SET \"{column}\" = ?1 WHERE id = ?2");
        tx.execute(&sql, params![json_string(&value)?, id])?;
        changed += touched;
    }
    Ok(changed)
}

/// 改写后的 JSON 序列化（`AppError` 没有 serde_json 转换，就地映射）
fn json_string(value: &serde_json::Value) -> AppResult<String> {
    serde_json::to_string(value).map_err(|e| AppError::Other(format!("序列化 JSON 失败: {e}")))
}

/// 改写 `jobs.input_json.referencePaths`（队列参考图路径数组）
fn rewrite_job_inputs(tx: &Connection, old_key: &str, new_root: &str) -> AppResult<usize> {
    let rows: Vec<(i64, String)> = {
        let mut stmt = tx.prepare("SELECT id, input_json FROM jobs WHERE input_json <> ''")?;
        let mapped = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        mapped.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut changed = 0usize;
    for (id, raw) in rows {
        let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let Some(paths) = value
            .get_mut("referencePaths")
            .and_then(|v| v.as_array_mut())
        else {
            continue;
        };
        let mut touched = 0usize;
        for item in paths.iter_mut() {
            let Some(path) = item.as_str() else { continue };
            if let Some(next) = rewrite_path(path, old_key, new_root) {
                *item = serde_json::Value::String(next);
                touched += 1;
            }
        }
        if touched == 0 {
            continue;
        }
        tx.execute(
            "UPDATE jobs SET input_json = ?1 WHERE id = ?2",
            params![json_string(&value)?, id],
        )?;
        changed += touched;
    }
    Ok(changed)
}

/// 媒体根搬家后的路径改写：覆盖库中全部 5 处引用，单事务提交。
///
/// 只改写落在旧根下的路径（前缀按目录边界比较，`images2` 不会被 `images` 命中）；
/// 对已经是新根的库再次调用不会产生任何变更，可安全重试。
pub fn rewrite_media_root(old: &Path, new: &Path) -> AppResult<usize> {
    let c = conn()?;
    rewrite_media_root_in(&c, old, new)
}

pub(crate) fn rewrite_media_root_in(c: &Connection, old: &Path, new: &Path) -> AppResult<usize> {
    let old_key = media_root_key(old);
    let new_root = new
        .to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_string();
    if old_key.is_empty() || new_root.is_empty() {
        return Err(AppError::Other("媒体目录路径为空，无法改写".into()));
    }
    let tx = c.unchecked_transaction()?;
    let mut changed = 0usize;

    // 1) history.file_path
    let history_rows: Vec<(i64, String)> = {
        let mut stmt = tx.prepare("SELECT id, file_path FROM history WHERE file_path <> ''")?;
        let mapped = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        mapped.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (id, path) in history_rows {
        if let Some(next) = rewrite_path(&path, &old_key, &new_root) {
            tx.execute(
                "UPDATE history SET file_path = ?1 WHERE id = ?2",
                params![next, id],
            )?;
            changed += 1;
        }
    }

    // 2) messages.images_json、3) jobs.images_json、5) workflow_presets.refs_json
    changed += rewrite_json_path_array(&tx, "messages", "images_json", &old_key, &new_root)?;
    changed += rewrite_json_path_array(&tx, "jobs", "images_json", &old_key, &new_root)?;
    changed += rewrite_json_path_array(&tx, "workflow_presets", "refs_json", &old_key, &new_root)?;

    // 4) jobs.input_json.referencePaths
    changed += rewrite_job_inputs(&tx, &old_key, &new_root)?;

    tx.commit()?;
    Ok(changed)
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
     images_json, error, created_at, started_at, finished_at, input_json, billing_state";

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
    /// 列里没有的扩展参数（参考图路径 / 角色），空串表示没有
    pub input_json: String,
    /// 计费状态：`unknown` / `billed_unrecovered` 表示结果未确认，重试前需人工确认
    #[serde(default)]
    pub billing_state: String,
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
    pub input_json: &'a str,
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
        input_json: row.get(20)?,
        billing_state: row.get(21)?,
    })
}

pub fn insert_job(job: &NewJob) -> AppResult<i64> {
    let c = conn()?;
    insert_job_in(&c, job)
}

fn insert_job_in(c: &Connection, job: &NewJob) -> AppResult<i64> {
    c.execute(
        "INSERT INTO jobs (status, provider_id, provider_name, model, prompt, negative_prompt,
         style, width, height, guidance, steps, seed, count, created_at, input_json)
         VALUES ('queued', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
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
            job.input_json,
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

/// 领取任务：同时受全局并发与服务商并发约束（服务商图像端点并发能力普遍很低）。
pub fn claim_next_job_limited(global_limit: i64, provider_limit: i64) -> AppResult<Option<JobRow>> {
    let c = conn()?;
    claim_next_job_in(&c, global_limit, provider_limit)
}

fn claim_next_job_in(c: &Connection, limit: i64, provider_limit: i64) -> AppResult<Option<JobRow>> {
    let now = timestamp_millis();
    let id: Option<i64> = c
        .query_row(
            "UPDATE jobs SET status = 'running', started_at = ?1, heartbeat_at = ?1
             WHERE id = (SELECT j.id FROM jobs j
                         WHERE j.status = 'queued'
                           AND (SELECT COUNT(*) FROM jobs r
                                WHERE r.status = 'running' AND r.provider_id = j.provider_id) < ?3
                         ORDER BY j.id ASC LIMIT 1)
               AND (SELECT COUNT(*) FROM jobs WHERE status = 'running') < ?2
             RETURNING id",
            params![now, limit.max(1), provider_limit.max(1)],
            |r| r.get(0),
        )
        .optional()?;
    match id {
        Some(id) => get_job_in(c, id),
        None => Ok(None),
    }
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

/// 兜底收尾（F-006）：只要还没落终态，就强制写成终态。
///
/// 正常路径必须走 `finish_job`（只允许 running → 终态）；这里给 worker 在正常收尾
/// 写库失败后的补偿用。否则一次写库抖动就会把任务永久留在 running，而
/// `claim_next_job` 按 running 计数判断并发上限，槽位就此泄漏。
pub fn finish_job_force(
    id: i64,
    status: &str,
    images_json: &str,
    error: Option<&str>,
) -> AppResult<bool> {
    let c = conn()?;
    finish_job_force_in(&c, id, status, images_json, error)
}

fn finish_job_force_in(
    c: &Connection,
    id: i64,
    status: &str,
    images_json: &str,
    error: Option<&str>,
) -> AppResult<bool> {
    debug_assert!(JOB_TERMINAL_STATUSES.contains(&status));
    let affected = c.execute(
        "UPDATE jobs SET status = ?2, images_json = ?3, error = ?4, finished_at = ?5
         WHERE id = ?1 AND status NOT IN ('done', 'failed', 'canceled', 'interrupted')",
        params![id, status, images_json, error, timestamp_millis()],
    )?;
    Ok(affected > 0)
}

/// 与 `timestamp_millis` 同格式、但取 `age` 之前的时刻，用于 TEXT 时间戳的字典序比较。
fn timestamp_millis_ago(age: std::time::Duration) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let then = now.saturating_sub(age);
    format!("{}.{:03}", then.as_secs(), then.subsec_millis())
}

/// 回收卡死任务（F-006）：running 且 `started_at` 早于 now-max_age 的标为 interrupted。
///
/// 启动时 `mark_running_interrupted` 覆盖「进程崩溃」；这里覆盖「进程还活着但
/// worker 卡死/收尾写库一直失败」——不回收的话这些行会永久占住并发槽位。
pub fn reap_stale_running(max_age: std::time::Duration) -> AppResult<usize> {
    let c = conn()?;
    reap_stale_running_in(&c, max_age)
}

fn reap_stale_running_in(c: &Connection, max_age: std::time::Duration) -> AppResult<usize> {
    // 有心跳的任务按心跳判断，长任务不会因为 started_at 太老被误回收
    let affected = c.execute(
        "UPDATE jobs SET status = 'interrupted', finished_at = ?1,
         error = COALESCE(error, '任务长时间未收尾，已标记为中断')
         WHERE status = 'running'
           AND COALESCE(heartbeat_at, started_at) IS NOT NULL
           AND COALESCE(heartbeat_at, started_at) < ?2",
        params![timestamp_millis(), timestamp_millis_ago(max_age)],
    )?;
    Ok(affected)
}

/// 运行中任务心跳：worker 每 60s 刷新，reaper 以它判断任务是否真的卡死
pub fn touch_job_heartbeat(id: i64) -> AppResult<bool> {
    let c = conn()?;
    touch_job_heartbeat_in(&c, id, timestamp_millis())
}

fn touch_job_heartbeat_in(c: &Connection, id: i64, at: String) -> AppResult<bool> {
    let affected = c.execute(
        "UPDATE jobs SET heartbeat_at = ?2 WHERE id = ?1 AND status = 'running'",
        params![id, at],
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
/// 结果未确认（可能已计费）的任务默认拒绝，需用户显式 `force` 才重发。
pub fn requeue_job(id: i64, force: bool) -> AppResult<bool> {
    let c = conn()?;
    requeue_job_in(&c, id, force)
}

/// 用户显式恢复全部中断任务；启动时仍不自动重跑，避免重复扣费。
/// `unknown` / `billed_unrecovered` 的任务不在此列，必须逐条确认。
pub fn requeue_interrupted_jobs() -> AppResult<usize> {
    let c = conn()?;
    let affected = c.execute(
        "UPDATE jobs SET status = 'queued', error = NULL, images_json = '[]',
         started_at = NULL, finished_at = NULL, heartbeat_at = NULL, billing_state = ''
         WHERE status = 'interrupted'
           AND COALESCE(billing_state, '') NOT IN ('unknown', 'billed_unrecovered')",
        [],
    )?;
    Ok(affected)
}

fn requeue_job_in(c: &Connection, id: i64, force: bool) -> AppResult<bool> {
    let guard = if force {
        ""
    } else {
        " AND COALESCE(billing_state, '') NOT IN ('unknown', 'billed_unrecovered')"
    };
    let sql = format!(
        "UPDATE jobs SET status = 'queued', error = NULL, images_json = '[]',
         started_at = NULL, finished_at = NULL, heartbeat_at = NULL, billing_state = ''
         WHERE id = ?1 AND status IN ('failed', 'canceled', 'interrupted'){guard}"
    );
    let affected = c.execute(&sql, params![id])?;
    Ok(affected > 0)
}

/// 写入任务的计费状态（`unknown` / `billed_unrecovered` 会阻止自动重试）
pub fn set_job_billing_state(id: i64, state: &str) -> AppResult<()> {
    conn()?.execute(
        "UPDATE jobs SET billing_state = ?2 WHERE id = ?1",
        params![id, state],
    )?;
    Ok(())
}

/// 429 退避重试：running 直接回到 queued，并写入更新后的扩展参数（重试次数）
pub fn requeue_running_job(id: i64, input_json: &str) -> AppResult<bool> {
    let c = conn()?;
    let affected = c.execute(
        "UPDATE jobs SET status = 'queued', error = NULL, images_json = '[]',
         started_at = NULL, finished_at = NULL, heartbeat_at = NULL, input_json = ?2
         WHERE id = ?1 AND status = 'running'",
        params![id, input_json],
    )?;
    Ok(affected > 0)
}

/// 待执行任务数：入队前做上限判断，避免队列无限堆积
pub fn queued_job_count() -> AppResult<i64> {
    let c = conn()?;
    let n: i64 = c.query_row(
        "SELECT COUNT(*) FROM jobs WHERE status = 'queued'",
        [],
        |r| r.get(0),
    )?;
    Ok(n)
}

/// 启动时把上次残留的 running 标为 interrupted：不自动重跑，避免重启即扣费。
pub fn mark_running_interrupted() -> AppResult<usize> {
    let c = conn()?;
    mark_running_interrupted_in(&c)
}

/// 是否有正在执行的任务（媒体根迁移前必须为空：运行中的任务正在写图片）
pub fn has_running_jobs() -> AppResult<bool> {
    let c = conn()?;
    has_running_jobs_in(&c)
}

pub(crate) fn has_running_jobs_in(c: &Connection) -> AppResult<bool> {
    let n: i64 = c.query_row(
        "SELECT COUNT(*) FROM jobs WHERE status = 'running'",
        [],
        |r| r.get(0),
    )?;
    Ok(n > 0)
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
            edit_template_json: "",
            transform_template_json: "",
        }
    }

    #[test]
    fn provider_timeout_clamped_to_5_1800() {
        assert_eq!(clamp_provider_timeout(0), 5);
        assert_eq!(clamp_provider_timeout(4), 5);
        // 60 仍是合法取值：迁移只抬旧默认，用户显式保留的短超时不强行改
        assert_eq!(clamp_provider_timeout(60), 60);
        assert_eq!(clamp_provider_timeout(600), 600);
        assert_eq!(clamp_provider_timeout(1800), 1800);
        assert_eq!(clamp_provider_timeout(100_000), 1800);
    }

    /// 迁移 012：旧版默认 60s 的行抬到 600s，用户显式设置的其他值不动
    #[test]
    fn migration_012_lifts_legacy_provider_timeout() {
        let mut c = Connection::open_in_memory().unwrap();
        apply_migrations_with(&mut c, &MIGRATIONS[..11]).unwrap();
        for (name, secs) in [("旧默认", 60), ("自定义", 120)] {
            c.execute(
                "INSERT INTO providers (name, base_url, api_key_enc, timeout_secs)
                 VALUES (?1, '', '', ?2)",
                params![name, secs],
            )
            .unwrap();
        }

        apply_migrations(&mut c).unwrap();
        assert_eq!(user_version_of(&c), MIGRATIONS.len() as i64);
        fn timeout_of(c: &Connection, name: &str) -> i64 {
            c.query_row(
                "SELECT timeout_secs FROM providers WHERE name = ?1",
                params![name],
                |r| r.get(0),
            )
            .unwrap()
        }
        assert_eq!(timeout_of(&c, "旧默认"), 600);
        assert_eq!(timeout_of(&c, "自定义"), 120);

        // 幂等：重复执行不会把用户后来改回 60 的值再次抬走
        c.execute(
            "UPDATE providers SET timeout_secs = 60 WHERE name = '自定义'",
            [],
        )
        .unwrap();
        apply_migrations(&mut c).unwrap();
        assert_eq!(timeout_of(&c, "自定义"), 60);
    }

    /// 迁移 013：新增计费流水表、任务计费状态与消息失败态；可重复执行
    #[test]
    fn migration_013_adds_request_journal() {
        let mut c = Connection::open_in_memory().unwrap();
        apply_migrations_with(&mut c, &MIGRATIONS[..12]).unwrap();
        apply_migrations(&mut c).unwrap();
        assert_eq!(user_version_of(&c), MIGRATIONS.len() as i64);
        assert!(index_exists(&c, "idx_image_requests_state"));
        assert!(index_exists(&c, "idx_image_requests_group"));
        assert!(index_exists(&c, "idx_image_requests_fingerprint"));

        fn has_column(c: &Connection, table: &str, column: &str) -> bool {
            let mut stmt = c
                .prepare(&format!("PRAGMA table_info({table})"))
                .expect("table_info");
            let names = stmt
                .query_map([], |r| r.get::<_, String>(1))
                .expect("column names");
            let names: Vec<String> = names.flatten().collect();
            names.iter().any(|n| n == column)
        }
        assert!(has_column(&c, "image_requests", "client_request_id"));
        assert!(has_column(&c, "image_requests", "param_hash"));
        assert!(has_column(&c, "jobs", "billing_state"));
        assert!(has_column(&c, "messages", "status"));
        assert!(has_column(&c, "messages", "error"));

        // 幂等：已是最新版本时再次执行不报错
        apply_migrations(&mut c).unwrap();
        assert_eq!(user_version_of(&c), MIGRATIONS.len() as i64);
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
        // 全局 DB 可能已被其它测试模块先初始化，此时沿用对方的连接
        let _db_guard = TEST_DB_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var(MASTER_KEY_ENV, "aa".repeat(32));
        let dir = test_dir();
        let owns_db = DB.get().is_none();
        if owns_db {
            let _ = std::fs::remove_dir_all(&dir);
            init(dir.clone()).expect("init storage");
        }

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

        // M2：编辑/变换模板 JSON 列往返（保存 → 重读 → 清空写回）
        let spec = template_spec_json(
            "https://api.example.com/edit",
            "{\"m\":\"{{mask}}\"}",
            "data.0.url",
        );
        let mut tpl_draft = draft("模板服务商", None, None);
        tpl_draft.kind = "template";
        tpl_draft.edit_template_json = &spec;
        let tpl = save_provider(None, &tpl_draft).expect("save template provider");
        assert_eq!(tpl.edit_template_json, spec);
        assert_eq!(tpl.transform_template_json, "");
        let reloaded = get_provider(tpl.id)
            .unwrap()
            .expect("template provider exists");
        assert_eq!(reloaded.edit_template_json, spec);
        assert_eq!(reloaded.transform_template_json, "");
        tpl_draft.edit_template_json = "";
        let cleared = save_provider(Some(tpl.id), &tpl_draft).expect("clear template spec");
        assert_eq!(cleared.edit_template_json, "");
        delete_provider(tpl.id).unwrap();

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
                "editTemplateUrl": "https://api.example.com/edit?img={{image}}",
                "editTemplateBody": "{\"mask\":\"{{mask}}\"}",
                "editTemplateResponsePath": "data.0.url",
                "transformTemplateUrl": "https://api.example.com/up",
                "transformTemplateBody": "{\"scale\":{{scale}}}",
                "transformTemplateResponsePath": "",
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
        // M2：模板列随备份导入还原
        let edit_spec: serde_json::Value =
            serde_json::from_str(&after[0].edit_template_json).expect("edit spec json");
        assert_eq!(
            edit_spec["url"],
            "https://api.example.com/edit?img={{image}}"
        );
        assert_eq!(edit_spec["body"], "{\"mask\":\"{{mask}}\"}");
        assert_eq!(edit_spec["responsePath"], "data.0.url");
        let transform_spec: serde_json::Value =
            serde_json::from_str(&after[0].transform_template_json).expect("transform spec json");
        assert_eq!(transform_spec["url"], "https://api.example.com/up");
        assert_eq!(transform_spec["body"], "{\"scale\":{{scale}}}");
        assert_eq!(transform_spec["responsePath"], "");
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
            parent_id: None,
            op: "generate".into(),
        })
        .unwrap();
        let history = list_history(10, 0, None, "", "", false).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].id, hid);
        assert_eq!(history[0].seed, Some(7));
        set_favorite(hid, true).unwrap();
        assert!(list_history(10, 0, None, "", "", false).unwrap()[0].favorite);
        let plan = delete_history(hid).unwrap();
        assert_eq!(plan.file_path.as_deref(), Some("/tmp/x.png"));
        assert!(!plan.still_referenced, "无消息引用时应允许回收文件");
        assert!(list_history(10, 0, None, "", "", false).unwrap().is_empty());

        // 迁移 007：派生图血统 —— 父图 + 放大子图，list_derived 以根为单位返回同族
        let parent = add_history(&HistoryRow {
            id: 0,
            prompt: "root".into(),
            negative_prompt: String::new(),
            model: "mock-draw-v1".into(),
            provider_name: "Mock".into(),
            seed: None,
            width: 1024,
            height: 1024,
            guidance: 0.0,
            steps: 0,
            style: String::new(),
            file_path: "/tmp/root.png".into(),
            favorite: false,
            created_at: "2".into(),
            parent_id: None,
            op: "generate".into(),
        })
        .unwrap();
        let child = add_history(&HistoryRow {
            id: 0,
            prompt: "upscale 2x".into(),
            negative_prompt: String::new(),
            model: "mock-draw-v1".into(),
            provider_name: "Mock".into(),
            seed: None,
            width: 2048,
            height: 2048,
            guidance: 0.0,
            steps: 0,
            style: String::new(),
            file_path: "/tmp/child.png".into(),
            favorite: false,
            created_at: "3".into(),
            parent_id: Some(parent),
            op: "upscale".into(),
        })
        .unwrap();
        let family = list_derived(child).unwrap();
        assert_eq!(
            family.iter().map(|r| r.id).collect::<Vec<_>>(),
            vec![parent, child]
        );
        assert_eq!(family[1].parent_id, Some(parent));
        assert_eq!(family[1].op, "upscale");
        // 从父图查同族结果一致（根节点不因入参不同而变）
        assert_eq!(list_derived(parent).unwrap().len(), 2);
        assert!(list_derived(999_999).unwrap().is_empty());

        delete_provider(after[0].id).unwrap();
        assert!(list_providers().unwrap().is_empty());

        std::env::remove_var(MASTER_KEY_ENV);
        if owns_db {
            let _ = std::fs::remove_dir_all(&dir);
        }
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
                "glassAppearance": "tinted",
                "locale": "en-US",
                "bodyIdleTimeoutSecs": "45",
                "bodyTotalTimeoutSecs": "900",
                "promptTemplates": r#"[{"id":"my","title":"我的模板","text":"a {subject}"}]"#,
                "stylePresets": r#"[{"id":"c_1","label":"我的风格","prompt":"warm tones"}]"#,
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
        assert!(setting_of(&c, "stylePresets")
            .expect("风格已导入")
            .contains("我的风格"));
        // 白名单外的设置项不落库
        assert!(setting_of(&c, "unknownKey").is_none());
        assert_eq!(
            setting_of(&c, "glassAppearance").as_deref(),
            Some("tinted"),
            "玻璃质感随备份往返"
        );
        assert_eq!(
            setting_of(&c, "locale").as_deref(),
            Some("en-US"),
            "界面语言随备份往返"
        );
        assert_eq!(
            setting_of(&c, "bodyIdleTimeoutSecs").as_deref(),
            Some("45"),
            "响应体无数据超时随备份往返"
        );
        assert_eq!(
            setting_of(&c, "bodyTotalTimeoutSecs").as_deref(),
            Some("900"),
            "响应体总超时随备份往返"
        );

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
                serde_json::json!({ "glassAppearance": "blurred" }),
                "玻璃质感取值非法",
            ),
            (serde_json::json!({ "locale": "fr-FR" }), "界面语言取值非法"),
            (
                serde_json::json!({ "promptTemplates": "not-json" }),
                "自定义模板",
            ),
            (
                serde_json::json!({ "promptTemplates": "[{\"id\":\"a\"}]" }),
                "自定义模板",
            ),
            (
                serde_json::json!({ "stylePresets": "[{\"id\":\"c_1\",\"label\":\"A\"}]" }),
                "自定义风格",
            ),
            (
                serde_json::json!({ "bodyIdleTimeoutSecs": "4" }),
                "无数据超时",
            ),
            (
                serde_json::json!({ "bodyTotalTimeoutSecs": "1801" }),
                "总超时",
            ),
            (
                serde_json::json!({
                    "bodyIdleTimeoutSecs": "60",
                    "bodyTotalTimeoutSecs": "30"
                }),
                "不能小于",
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

    /// 引用集合还要覆盖队列参考图与工作流预设参考图：
    /// 漏掉任何一处，清理缓存都会把仍在排队/预设里的参考图当孤儿移走
    #[test]
    fn referenced_paths_include_jobs_and_presets() {
        let c = mem_conn();
        insert_history_row(&c, r"C:\media\images\h.png");
        c.execute(
            "INSERT INTO jobs (provider_id, created_at, images_json, input_json)
             VALUES (1, '0', ?1, ?2)",
            params![
                r#"[{"historyId":1,"path":"C:\\media\\images\\job.png"}]"#,
                r#"{"referencePaths":["C:\\media\\refs\\queue.png"],"references":[]}"#
            ],
        )
        .unwrap();
        save_preset_in(
            &c,
            None,
            "夜景",
            "",
            "",
            "{}",
            &[PresetRef {
                path: r"C:\media\refs\preset.png".into(),
                role: "style".into(),
                strength: 60,
            }],
        )
        .expect("save preset");

        let set = collect_referenced_paths_in(&c).expect("collect");
        for p in [
            r"C:\media\images\h.png",
            r"C:\media\images\job.png",
            r"C:\media\refs\queue.png",
            r"C:\media\refs\preset.png",
        ] {
            assert!(set.contains(&normalize_path_key(p)), "缺少引用: {p}");
        }
        assert_eq!(set.len(), 4);
    }

    /// 队列 input_json / 预设 refs_json 损坏时不得让整条引用查询失败
    #[test]
    fn referenced_paths_survive_corrupt_job_and_preset_json() {
        let c = mem_conn();
        c.execute(
            "INSERT INTO jobs (provider_id, created_at, images_json, input_json)
             VALUES (1, '0', 'not-json', 'not-json')",
            [],
        )
        .unwrap();
        let preset = save_preset_in(&c, None, "p", "", "", "{}", &[]).expect("save preset");
        c.execute(
            "UPDATE workflow_presets SET refs_json = 'oops' WHERE id = ?1",
            params![preset.id],
        )
        .unwrap();
        let set = collect_referenced_paths_in(&c).expect("坏 JSON 不应导致查询失败");
        assert!(set.is_empty());
    }

    /// 媒体根改写必须覆盖全部 5 处引用、保留大小写、不动旧根之外的路径，且幂等
    #[test]
    fn rewrite_media_root_updates_all_references_and_is_idempotent() {
        let c = mem_conn();
        let old = Path::new(r"E:\old root");
        let new = Path::new(r"D:\new\media");

        let history_id = insert_history_row(&c, r"E:\old root\images\a.PNG");
        let message_id = insert_message(&c, 1, "hi");
        set_message_images(
            &c,
            message_id,
            r#"[{"historyId":1,"path":"E:\\old root\\images\\b.png"},{"path":"E:\\other\\keep.png"}]"#,
        );
        c.execute(
            "INSERT INTO jobs (provider_id, created_at, images_json, input_json)
             VALUES (1, '0', ?1, ?2)",
            params![
                r#"[{"historyId":1,"path":"E:\\old root\\images\\c.png"}]"#,
                r#"{"referencePaths":["E:\\old root\\refs\\q.png","E:\\other\\r2.png"],"references":[]}"#
            ],
        )
        .unwrap();
        let preset = save_preset_in(
            &c,
            None,
            "p",
            "",
            "",
            "{}",
            &[PresetRef {
                path: r"E:\old root\refs\preset.png".into(),
                role: "style".into(),
                strength: 80,
            }],
        )
        .expect("save preset");
        // 旧根的「兄弟目录」不能被前缀误改
        insert_history_row(&c, r"E:\old root2\images\sibling.png");

        let changed = rewrite_media_root_in(&c, old, new).expect("rewrite");
        assert_eq!(
            changed, 5,
            "history/message/job 图/队列参考图/预设参考图各一处"
        );

        let file_path: String = c
            .query_row(
                "SELECT file_path FROM history WHERE id = ?1",
                params![history_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(file_path, r"D:\new\media\images\a.PNG");

        let images_json: String = c
            .query_row(
                "SELECT images_json FROM messages WHERE id = ?1",
                params![message_id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(images_json.contains(r"D:\\new\\media\\images\\b.png"));
        assert!(
            images_json.contains(r"E:\\other\\keep.png"),
            "旧根外路径不动"
        );

        let (job_images, job_input): (String, String) = c
            .query_row(
                "SELECT images_json, input_json FROM jobs LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(job_images.contains(r"D:\\new\\media\\images\\c.png"));
        assert!(job_input.contains(r"D:\\new\\media\\refs\\q.png"));
        assert!(job_input.contains(r"E:\\other\\r2.png"), "旧根外路径不动");

        let refs_json: String = c
            .query_row(
                "SELECT refs_json FROM workflow_presets WHERE id = ?1",
                params![preset.id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(refs_json.contains(r"D:\\new\\media\\refs\\preset.png"));

        let sibling: String = c
            .query_row(
                "SELECT file_path FROM history WHERE file_path LIKE '%sibling.png'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(sibling, r"E:\old root2\images\sibling.png");

        // 幂等：再跑一次不应有任何变更
        assert_eq!(rewrite_media_root_in(&c, old, new).unwrap(), 0);
    }

    /// 缓存保留天数：缺省 30，合法值生效，脏值/越界回退默认
    #[test]
    fn cache_retention_days_defaults_and_validates() {
        let c = mem_conn();
        assert_eq!(cache_retention_days_in(&c), DEFAULT_CACHE_RETENTION_DAYS);
        for (raw, expected) in [
            ("7", 7),
            ("365", 365),
            (" 1 ", 1),
            ("0", DEFAULT_CACHE_RETENTION_DAYS),
            ("366", DEFAULT_CACHE_RETENTION_DAYS),
            ("abc", DEFAULT_CACHE_RETENTION_DAYS),
        ] {
            c.execute(
                "INSERT INTO settings (key, value) VALUES ('cacheRetentionDays', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![raw],
            )
            .unwrap();
            assert_eq!(cache_retention_days_in(&c), expected, "raw={raw}");
        }
    }

    /// 响应体超时：缺省 30/300，合法值生效，脏值/越界回退默认，总时长不低于空闲
    #[test]
    fn body_timeout_secs_defaults_and_validates() {
        let c = mem_conn();
        assert_eq!(
            body_timeout_secs_in(&c),
            (
                DEFAULT_BODY_IDLE_TIMEOUT_SECS,
                DEFAULT_BODY_TOTAL_TIMEOUT_SECS
            )
        );
        let set = |key: &str, value: &str| {
            c.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .unwrap();
        };
        set("bodyIdleTimeoutSecs", "45");
        set("bodyTotalTimeoutSecs", "900");
        assert_eq!(body_timeout_secs_in(&c), (45, 900));
        for bad in ["4", "301", "abc"] {
            set("bodyIdleTimeoutSecs", bad);
            assert_eq!(
                body_timeout_secs_in(&c),
                (DEFAULT_BODY_IDLE_TIMEOUT_SECS, 900),
                "idle={bad}"
            );
        }
        set("bodyIdleTimeoutSecs", "45");
        set("bodyTotalTimeoutSecs", "40");
        assert_eq!(
            body_timeout_secs_in(&c),
            (45, 45),
            "总超时低于空闲时应抬到空闲值"
        );
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

    /// M3：模型能力覆盖值按 (provider, model) 往返，重复写入走更新
    #[test]
    fn model_caps_roundtrip_upsert() {
        let c = mem_conn();
        save_model_caps_in(&c, 7, "flux-pro", r#"{"negative":false}"#).unwrap();
        save_model_caps_in(&c, 7, "flux-pro", r#"{"negative":true,"edit":false}"#).unwrap();
        save_model_caps_in(&c, 7, "dall-e-3", r#"{"negative":false}"#).unwrap();
        save_model_caps_in(&c, 8, "flux-pro", r#"{"transform":false}"#).unwrap();
        assert_eq!(
            list_model_caps_in(&c, 7).unwrap(),
            vec![
                ("dall-e-3".to_string(), r#"{"negative":false}"#.to_string()),
                (
                    "flux-pro".to_string(),
                    r#"{"negative":true,"edit":false}"#.to_string()
                ),
            ]
        );
        // 不同服务商互不影响
        assert_eq!(list_model_caps_in(&c, 8).unwrap().len(), 1);
    }

    /// E11：批量能力保存一次写入全部模型，替代逐条调用
    #[test]
    fn model_caps_batch_writes_all_entries() {
        let mut c = mem_conn();
        let entries = vec![
            ("flux-pro".to_string(), r#"{"negative":false}"#.to_string()),
            ("dall-e-3".to_string(), r#"{"edit":false}"#.to_string()),
        ];
        save_model_caps_batch_in(&mut c, 9, &entries).unwrap();
        let stored = list_model_caps_in(&c, 9).unwrap();
        assert_eq!(stored.len(), 2);
        assert!(stored.iter().any(|(m, _)| m == "flux-pro"));
        assert!(stored.iter().any(|(m, _)| m == "dall-e-3"));
        // 覆盖写仍走 upsert，不产生重复行
        let again = vec![("flux-pro".to_string(), r#"{"edit":true}"#.to_string())];
        save_model_caps_batch_in(&mut c, 9, &again).unwrap();
        assert_eq!(list_model_caps_in(&c, 9).unwrap().len(), 2);
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
            input_json: "",
        }
    }

    /// C4：启动时残留的 running 必须标为 interrupted，且不回到 queued
    #[test]
    fn startup_marks_running_interrupted() {
        let c = mem_conn();
        let running = insert_job_in(&c, &new_job("running")).unwrap();
        let queued = insert_job_in(&c, &new_job("queued")).unwrap();
        assert_eq!(
            claim_next_job_in(&c, 1, i64::MAX).unwrap().map(|j| j.id),
            Some(running)
        );
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
        assert_eq!(
            claim_next_job_in(&c, 1, i64::MAX).unwrap().map(|j| j.id),
            Some(id)
        );
        // 已被领取的任务不能二次领取（worker 竞争）
        assert!(claim_next_job_in(&c, 1, i64::MAX).unwrap().is_none());
        assert!(finish_job_in(&c, id, "done", "[]", None).unwrap());
        // 终态不可再次迁移
        assert!(!finish_job_in(&c, id, "canceled", "[]", None).unwrap());
        assert_eq!(get_job_in(&c, id).unwrap().unwrap().status, "done");
    }

    /// F-006：收尾写库失败的兜底，能把残留 running 写成终态；已落终态的不覆盖
    #[test]
    fn finish_job_force_recovers_stuck_running() {
        let c = mem_conn();
        let id = insert_job_in(&c, &new_job("job")).unwrap();
        // 还没 running 也能强制落终态（worker 卡在收尾路径上时的补救）
        assert!(finish_job_force_in(&c, id, "failed", "[]", Some("db busy")).unwrap());
        assert_eq!(get_job_in(&c, id).unwrap().unwrap().status, "failed");
        // 已终态的行不会被二次覆盖
        assert!(!finish_job_force_in(&c, id, "done", "[]", None).unwrap());
        assert_eq!(get_job_in(&c, id).unwrap().unwrap().status, "failed");
    }

    /// F-006：running 超过阈值未收尾 → interrupted；新鲜 running 不动
    #[test]
    fn reap_stale_running_only_marks_expired() {
        let c = mem_conn();
        let stale = insert_job_in(&c, &new_job("stale")).unwrap();
        let fresh = insert_job_in(&c, &new_job("fresh")).unwrap();
        receive_running(&c, stale);
        receive_running(&c, fresh);
        // 把 stale 的开始时间改成 1 小时前，并模拟心跳早已停止
        c.execute(
            "UPDATE jobs SET started_at = ?2, heartbeat_at = NULL WHERE id = ?1",
            params![
                stale,
                timestamp_millis_ago(std::time::Duration::from_secs(3600))
            ],
        )
        .unwrap();

        assert_eq!(
            reap_stale_running_in(&c, std::time::Duration::from_secs(1800)).unwrap(),
            1
        );
        assert_eq!(
            get_job_in(&c, stale).unwrap().unwrap().status,
            "interrupted"
        );
        assert_eq!(get_job_in(&c, fresh).unwrap().unwrap().status, "running");
    }

    /// B7：心跳仍在刷新的长任务不能被回收，即使 started_at 已经很旧
    #[test]
    fn reap_stale_running_keeps_heartbeat_alive() {
        let c = mem_conn();
        let long = insert_job_in(&c, &new_job("long")).unwrap();
        receive_running(&c, long);
        c.execute(
            "UPDATE jobs SET started_at = ?2, heartbeat_at = ?3 WHERE id = ?1",
            params![
                long,
                timestamp_millis_ago(std::time::Duration::from_secs(7200)),
                timestamp_millis()
            ],
        )
        .unwrap();
        assert_eq!(
            reap_stale_running_in(&c, std::time::Duration::from_secs(1800)).unwrap(),
            0
        );
        assert_eq!(get_job_in(&c, long).unwrap().unwrap().status, "running");
        // 心跳停了之后才会被回收
        assert!(touch_job_heartbeat_in(
            &c,
            long,
            timestamp_millis_ago(std::time::Duration::from_secs(3600))
        )
        .unwrap());
        assert_eq!(
            reap_stale_running_in(&c, std::time::Duration::from_secs(1800)).unwrap(),
            1
        );
    }

    /// 领取下一条并确认它确实进入 running
    fn receive_running(c: &Connection, id: i64) {
        assert_eq!(
            claim_next_job_in(c, 4, i64::MAX).unwrap().map(|j| j.id),
            Some(id)
        );
    }

    /// C4：失败任务重试回 queued，终态与运行中任务不能重试
    #[test]
    fn retry_requeues_failed() {
        let c = mem_conn();
        let id = insert_job_in(&c, &new_job("job")).unwrap();
        assert!(
            !requeue_job_in(&c, id, false).unwrap(),
            "queued 任务无需重试"
        );
        assert_eq!(
            claim_next_job_in(&c, 1, i64::MAX).unwrap().map(|j| j.id),
            Some(id)
        );
        assert!(
            !requeue_job_in(&c, id, false).unwrap(),
            "running 任务不能重试"
        );
        assert!(finish_job_in(&c, id, "failed", "[]", Some("boom")).unwrap());
        assert!(requeue_job_in(&c, id, false).unwrap());
        let row = get_job_in(&c, id).unwrap().unwrap();
        assert_eq!(row.status, "queued");
        assert!(row.error.is_none());
        assert_eq!(row.images_json, "[]");
        assert!(row.started_at.is_none());
        assert!(row.finished_at.is_none());
        assert_eq!(row.billing_state, "");
    }

    /// 结果未确认的任务默认拒绝重试，只有 force 才能重新计费
    #[test]
    fn retry_rejects_unconfirmed_billing_without_force() {
        let c = mem_conn();
        let id = insert_job_in(&c, &new_job("job")).unwrap();
        claim_next_job_in(&c, 1, i64::MAX).unwrap();
        finish_job_in(&c, id, "failed", "[]", Some("timeout")).unwrap();
        c.execute(
            "UPDATE jobs SET billing_state = 'unknown' WHERE id = ?1",
            params![id],
        )
        .unwrap();
        assert!(
            !requeue_job_in(&c, id, false).unwrap(),
            "待确认任务不得自动重试"
        );
        assert_eq!(get_job_in(&c, id).unwrap().unwrap().status, "failed");
        assert!(requeue_job_in(&c, id, true).unwrap());
        let row = get_job_in(&c, id).unwrap().unwrap();
        assert_eq!(row.status, "queued");
        assert_eq!(row.billing_state, "", "重试即开启新一轮，计费状态要清空");
    }

    /// C4：取消排队任务立即生效，worker 之后取不到它
    #[test]
    fn cancel_queued_is_immediate() {
        let c = mem_conn();
        let first = insert_job_in(&c, &new_job("first")).unwrap();
        let second = insert_job_in(&c, &new_job("second")).unwrap();
        assert!(cancel_queued_job_in(&c, first).unwrap());
        assert!(!cancel_queued_job_in(&c, first).unwrap(), "取消应幂等");
        let next = claim_next_job_in(&c, 1, i64::MAX)
            .unwrap()
            .expect("仍有排队任务");
        assert_eq!(next.id, second, "被取消的任务不能再被取到");
        let row = get_job_in(&c, first).unwrap().unwrap();
        assert_eq!(row.status, "canceled");
        assert!(row.finished_at.is_some());
    }

    /// M8：并发上限生效，同一任务不会被领取两次
    #[test]
    fn claim_respects_concurrency_and_never_double_claims() {
        let c = mem_conn();
        let first = insert_job_in(&c, &new_job("first")).unwrap();
        let second = insert_job_in(&c, &new_job("second")).unwrap();
        assert_eq!(
            claim_next_job_in(&c, 2, i64::MAX).unwrap().map(|j| j.id),
            Some(first)
        );
        assert_eq!(
            claim_next_job_in(&c, 2, i64::MAX).unwrap().map(|j| j.id),
            Some(second)
        );
        // 已达上限 2，再领应为空
        insert_job_in(&c, &new_job("third")).unwrap();
        assert!(claim_next_job_in(&c, 2, i64::MAX).unwrap().is_none());
        // 完成一个后空出名额，且不会重复返回已领取的任务
        assert!(finish_job_in(&c, first, "done", "[]", None).unwrap());
        let next = claim_next_job_in(&c, 2, i64::MAX)
            .unwrap()
            .expect("应有排空任务");
        assert_eq!(next.prompt, "third");
        assert_eq!(get_job_in(&c, first).unwrap().unwrap().status, "done");
    }

    /// M8：input_json 随任务往返（参考图路径与角色快照）
    #[test]
    fn job_input_json_roundtrip() {
        let c = mem_conn();
        let raw = r#"{"referencePaths":["/data/refs/a.png"],"references":[{"role":"style","strength":80}]}"#;
        let mut job = new_job("with refs");
        job.input_json = raw;
        let id = insert_job_in(&c, &job).unwrap();
        assert_eq!(get_job_in(&c, id).unwrap().unwrap().input_json, raw);
        // 未带扩展字段的任务默认空串（旧数据/旧前端兼容）
        let plain = insert_job_in(&c, &new_job("plain")).unwrap();
        assert_eq!(get_job_in(&c, plain).unwrap().unwrap().input_json, "");
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

    /// M9：收藏按文本去重，重复收藏只更新标签
    #[test]
    fn prompt_favorite_upsert_and_tags() {
        let c = mem_conn();
        let first = upsert_favorite_in(
            &c,
            "  cinematic portrait  ",
            &["人像".into(), " 人像 ".into(), "".into()],
        )
        .unwrap();
        assert_eq!(first.text, "cinematic portrait");
        assert_eq!(first.tags, vec!["人像".to_string()]);
        let again = upsert_favorite_in(&c, "cinematic portrait", &["人像".into(), "电影感".into()])
            .unwrap();
        assert_eq!(again.id, first.id, "同一文本不得产生第二条收藏");
        assert_eq!(again.tags, vec!["人像".to_string(), "电影感".to_string()]);
        assert_eq!(list_favorites_in(&c).unwrap().len(), 1);
        assert!(upsert_favorite_in(&c, "   ", &[]).is_err());
        assert!(delete_favorite_in(&c, first.id).unwrap());
        assert!(!delete_favorite_in(&c, first.id).unwrap());
    }

    /// M9：预设保存 / 更新 / 删除与参考图约束
    #[test]
    fn workflow_preset_roundtrip_and_validation() {
        let c = mem_conn();
        let refs = vec![
            PresetRef {
                path: r"C:\data\refs\a.png".into(),
                role: "composition".into(),
                strength: 60,
            },
            PresetRef {
                path: r"C:\data\refs\b.png".into(),
                role: "style".into(),
                strength: 80,
            },
        ];
        let saved = save_preset_in(
            &c,
            None,
            "  夜景人像  ",
            "neon portrait",
            "blurry",
            r#"{"ratio":"3:4","width":768,"height":1024}"#,
            &refs,
        )
        .unwrap();
        assert_eq!(saved.name, "夜景人像");
        assert_eq!(saved.refs, refs);
        assert_eq!(list_presets_in(&c).unwrap().len(), 1);

        let updated = save_preset_in(
            &c,
            Some(saved.id),
            "夜景人像 v2",
            saved.prompt.as_str(),
            "",
            saved.params_json.as_str(),
            &[],
        )
        .unwrap();
        assert_eq!(updated.name, "夜景人像 v2");
        assert!(updated.refs.is_empty());

        assert!(save_preset_in(&c, None, "", "p", "", "{}", &[]).is_err());
        assert!(save_preset_in(&c, None, "x", "p", "", "not-json", &[]).is_err());
        assert!(save_preset_in(&c, None, "x", "p", "", "[]", &[]).is_err());
        let too_many: Vec<PresetRef> = (0..=MAX_PRESET_REFS)
            .map(|i| PresetRef {
                path: format!("r{i}.png"),
                role: "composition".into(),
                strength: 60,
            })
            .collect();
        assert!(save_preset_in(&c, None, "x", "p", "", "{}", &too_many).is_err());
        let bad_role = vec![PresetRef {
            path: "r.png".into(),
            role: "unknown".into(),
            strength: 60,
        }];
        assert!(save_preset_in(&c, None, "x", "p", "", "{}", &bad_role).is_err());
        assert!(save_preset_in(&c, Some(9999), "x", "p", "", "{}", &[]).is_err());

        assert!(delete_preset_in(&c, saved.id).unwrap());
        assert!(list_presets_in(&c).unwrap().is_empty());
    }

    /// M9：迁移 009 的索引存在（版本号由通用迁移测试覆盖）
    #[test]
    fn prompt_assets_indexes_exist() {
        let c = mem_conn();
        assert!(index_exists(&c, "idx_prompt_favorites_created"));
        assert!(index_exists(&c, "idx_workflow_presets_updated"));
    }

    /// M9：008 老库升级到 009 成功且可重复执行
    #[test]
    fn migration_009_upgrades_from_v8() {
        let mut c = Connection::open_in_memory().unwrap();
        apply_migrations_with(&mut c, &MIGRATIONS[..8]).unwrap();
        assert_eq!(user_version_of(&c), 8);
        assert!(!index_exists(&c, "idx_prompt_favorites_created"));

        apply_migrations(&mut c).unwrap();
        assert_eq!(user_version_of(&c), MIGRATIONS.len() as i64);
        assert!(index_exists(&c, "idx_prompt_favorites_created"));
        assert!(index_exists(&c, "idx_workflow_presets_updated"));

        // 幂等：版本已是最新时再跑不报错、不丢数据
        upsert_favorite_in(&c, "a cat", &[]).unwrap();
        apply_migrations(&mut c).unwrap();
        assert_eq!(list_favorites_in(&c).unwrap().len(), 1);
    }

    /// M12：迁移 010 从 v9 升级成功且可重复执行；画布索引存在
    #[test]
    fn migration_010_upgrades_from_v9() {
        let mut c = Connection::open_in_memory().unwrap();
        apply_migrations_with(&mut c, &MIGRATIONS[..9]).unwrap();
        assert_eq!(user_version_of(&c), 9);
        assert!(!index_exists(&c, "idx_canvas_boards_updated"));

        apply_migrations(&mut c).unwrap();
        assert_eq!(user_version_of(&c), MIGRATIONS.len() as i64);
        assert!(index_exists(&c, "idx_canvas_boards_updated"));

        create_canvas_board_in(&c, "设计稿").unwrap();
        apply_migrations(&mut c).unwrap();
        assert_eq!(list_canvas_boards_in(&c).unwrap().len(), 1);
    }

    /// M12：画布 CRUD 往返，默认数据与更新时间正确
    #[test]
    fn canvas_board_crud_roundtrip() {
        let c = mem_conn();
        let created = create_canvas_board_in(&c, " 第一块画布 ").unwrap();
        assert_eq!(created.name, "第一块画布");
        assert_eq!(created.data_json, CANVAS_DEFAULT_DATA);
        assert!(!created.created_at.is_empty());

        let listed = list_canvas_boards_in(&c).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, created.id);

        let doc = r#"{"version":1,"nodes":[{"id":"n1","historyId":3,"x":10,"y":20,"width":240}],"edges":[],"viewport":{"x":12,"y":8,"zoom":1.5}}"#;
        let saved = save_canvas_board_in(&c, created.id, "改名", doc).unwrap();
        assert_eq!(saved.name, "改名");
        assert_eq!(saved.data_json, doc);
        assert_eq!(
            get_canvas_board_in(&c, created.id).unwrap().unwrap().name,
            "改名"
        );

        assert!(delete_canvas_board_in(&c, created.id).unwrap());
        assert!(get_canvas_board_in(&c, created.id).unwrap().is_none());
        assert!(!delete_canvas_board_in(&c, created.id).unwrap());
        assert!(save_canvas_board_in(&c, created.id, "x", doc).is_err());
    }

    /// M12：画布数据拒绝悬空边、重复 id、超量节点与超大 JSON
    #[test]
    fn canvas_save_rejects_invalid_documents() {
        let c = mem_conn();
        let board = create_canvas_board_in(&c, "校验").unwrap();

        let dangling = r#"{"version":1,"nodes":[],"edges":[{"id":"e1","from":"a","to":"b"}],"viewport":{"x":0,"y":0,"zoom":1}}"#;
        assert!(save_canvas_board_in(&c, board.id, "x", dangling).is_err());

        let duplicate = r#"{"version":1,"nodes":[{"id":"n1"},{"id":"n1"}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}"#;
        assert!(save_canvas_board_in(&c, board.id, "x", duplicate).is_err());

        let nodes: Vec<String> = (0..=MAX_CANVAS_NODES)
            .map(|i| format!(r#"{{"id":"n{i}"}}"#))
            .collect();
        let too_many = format!(
            r#"{{"version":1,"nodes":[{}],"edges":[],"viewport":{{"x":0,"y":0,"zoom":1}}}}"#,
            nodes.join(",")
        );
        assert!(save_canvas_board_in(&c, board.id, "x", &too_many).is_err());

        let huge = format!(
            r#"{{"version":1,"nodes":[],"edges":[],"viewport":{{"x":0,"y":0,"zoom":1}},"pad":"{}"}}"#,
            "x".repeat(MAX_CANVAS_JSON_BYTES)
        );
        assert!(save_canvas_board_in(&c, board.id, "x", &huge).is_err());

        let bad_viewport =
            r#"{"version":1,"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":"1"}}"#;
        assert!(save_canvas_board_in(&c, board.id, "x", bad_viewport).is_err());
        assert!(create_canvas_board_in(&c, "   ").is_err());
    }

    /// M9：v4 备份导入替换收藏与预设，参考图经注入闭包重新落盘
    #[test]
    fn import_v4_replaces_prompt_assets() {
        let mut c = mem_conn();
        upsert_favorite_in(&c, "旧收藏", &["old".into()]).unwrap();
        save_preset_in(&c, None, "旧预设", "", "", "{}", &[]).unwrap();

        let data = serde_json::json!({
            "version": 4,
            "providers": [{ "name": "P", "baseUrl": "" }],
            "settings": {},
            "favorites": [
                { "text": "a cat", "tags": ["动物", "橘猫"], "createdAt": "1700000000" },
                { "text": "a cat", "tags": ["去重"], "createdAt": "1700000001" },
            ],
            "presets": [{
                "name": "夜景",
                "prompt": "city at night",
                "negativePrompt": "blur",
                "params": { "ratio": "16:9" },
                "refs": [
                    { "role": "style", "strength": 80, "dataUrl": "data:image/png;base64,AAAA" },
                    { "role": "composition", "strength": 20, "dataUrl": "data:image/png;base64,BBBB" },
                ],
            }],
        });
        let written: Mutex<Vec<String>> = Mutex::new(Vec::new());
        let write = |data_url: &str| -> AppResult<String> {
            let mut w = written.lock().unwrap();
            w.push(data_url.to_string());
            Ok(format!("C:/refs/ref-{}.png", w.len()))
        };
        import_config_in_with_refs(&mut c, &data, Some(&write)).expect("import v4");

        let favs = list_favorites_in(&c).unwrap();
        assert_eq!(favs.len(), 1, "重复文本只保留一条收藏");
        assert_eq!(favs[0].text, "a cat");
        assert_eq!(favs[0].tags, vec!["去重".to_string()]);
        let presets = list_presets_in(&c).unwrap();
        assert_eq!(presets.len(), 1, "旧预设必须被替换");
        assert_eq!(presets[0].name, "夜景");
        assert_eq!(presets[0].params_json, r#"{"ratio":"16:9"}"#);
        assert_eq!(presets[0].refs.len(), 2);
        assert_eq!(presets[0].refs[0].path, "C:/refs/ref-1.png");
        assert_eq!(presets[0].refs[0].role, "style");
        assert_eq!(presets[0].refs[0].strength, 80);
        assert_eq!(written.lock().unwrap().len(), 2);
    }

    /// M9：v4 资产非法时在事务与 DELETE 之前失败，旧收藏/预设保持原样
    #[test]
    fn import_v4_rejects_bad_assets_before_delete() {
        let mut c = mem_conn();
        upsert_favorite_in(&c, "旧收藏", &[]).unwrap();
        save_preset_in(&c, None, "旧预设", "", "", "{}", &[]).unwrap();
        let provider = serde_json::json!({ "name": "P", "baseUrl": "" });
        let five_refs: Vec<serde_json::Value> = (0..=MAX_PRESET_REFS)
            .map(|_| {
                serde_json::json!({
                    "role": "style",
                    "strength": 60,
                    "dataUrl": "data:image/png;base64,AAAA",
                })
            })
            .collect();
        for bad in [
            serde_json::json!({
                "version": 4, "providers": [provider.clone()], "settings": {},
                "favorites": [], "presets": {},
            }),
            serde_json::json!({
                "version": 4, "providers": [provider.clone()], "settings": {},
                "favorites": [], "presets": [{ "name": "  " }],
            }),
            serde_json::json!({
                "version": 4, "providers": [provider.clone()], "settings": {},
                "favorites": [], "presets": [{
                    "name": "n",
                    "refs": [{ "role": "style", "strength": 60, "dataUrl": "not-an-image" }],
                }],
            }),
            serde_json::json!({
                "version": 4, "providers": [provider.clone()], "settings": {},
                "favorites": [], "presets": [{ "name": "n", "refs": five_refs }],
            }),
            serde_json::json!({
                "version": 4, "providers": [provider.clone()], "settings": {},
                "favorites": "oops", "presets": [],
            }),
        ] {
            import_config_in(&mut c, &bad).expect_err("非法 v4 资产必须拒绝导入");
            assert_eq!(list_favorites_in(&c).unwrap().len(), 1);
            assert_eq!(list_presets_in(&c).unwrap().len(), 1);
            assert_eq!(count_providers(&c), 0, "拒绝时不得删除旧服务商");
        }
    }

    /// M9：v1–v3 备份不触碰本机收藏与预设
    #[test]
    fn import_v3_leaves_prompt_assets_untouched() {
        let mut c = mem_conn();
        upsert_favorite_in(&c, "本机收藏", &["keep".into()]).unwrap();
        save_preset_in(&c, None, "本机预设", "", "", "{}", &[]).unwrap();
        let data = serde_json::json!({
            "version": 3,
            "providers": [{ "name": "P", "baseUrl": "" }],
            "settings": {},
            "favorites": [],
            "presets": [],
        });
        import_config_in(&mut c, &data).expect("import v3");
        assert_eq!(list_favorites_in(&c).unwrap().len(), 1);
        assert_eq!(list_presets_in(&c).unwrap().len(), 1);
    }

    /// M10：收藏过滤走 SQL，与模型/风格过滤组合后分页顺序不变
    #[test]
    fn list_history_filters_favorites_with_filters_and_order() {
        let c = mem_conn();
        for (i, (model, style, favorite)) in [
            ("m-a", "anime", false),
            ("m-a", "anime", true),
            ("m-b", "anime", true),
            ("m-a", "oil", true),
            ("m-b", "oil", false),
        ]
        .into_iter()
        .enumerate()
        {
            c.execute(
                "INSERT INTO history (prompt, model, provider_name, style, file_path, favorite, created_at, op)
                 VALUES (?1, ?2, 'P', ?3, ?4, ?5, ?6, 'generate')",
                params![
                    format!("p{i}"),
                    model,
                    style,
                    format!("/tmp/{i}.png"),
                    favorite as i64,
                    i.to_string()
                ],
            )
            .unwrap();
        }

        let ids = |rows: Vec<HistoryRow>| rows.iter().map(|r| r.id).collect::<Vec<_>>();
        // id 1..5 对应插入顺序；favorite_only 按 id DESC 返回收藏项
        assert_eq!(
            ids(list_history_in(&c, 10, 0, None, "", "", true).unwrap()),
            vec![4, 3, 2]
        );
        // 与模型过滤组合
        assert_eq!(
            ids(list_history_in(&c, 10, 0, None, "m-a", "", true).unwrap()),
            vec![4, 2]
        );
        // 与风格过滤组合
        assert_eq!(
            ids(list_history_in(&c, 10, 0, None, "", "anime", true).unwrap()),
            vec![3, 2]
        );
        // 分页顺序不变：收藏 4、3 之后是 2
        assert_eq!(
            ids(list_history_in(&c, 2, 0, None, "", "", true).unwrap()),
            vec![4, 3]
        );
        assert_eq!(
            ids(list_history_in(&c, 2, 2, None, "", "", true).unwrap()),
            vec![2]
        );
        // favorite_only=false 不改变全量列表
        assert_eq!(
            ids(list_history_in(&c, 10, 0, None, "", "", false).unwrap()),
            vec![5, 4, 3, 2, 1]
        );
    }

    /// F-015：分页参数在存储层钳制，负 limit 不再等于「一次拉全库」
    #[test]
    fn list_history_clamps_paging_params() {
        let c = mem_conn();
        for i in 0..3 {
            c.execute(
                "INSERT INTO history (prompt, model, provider_name, style, file_path, favorite, created_at, op)
                 VALUES (?1, 'm', 'P', 's', ?2, 0, ?3, 'generate')",
                params![format!("p{i}"), format!("/tmp/{i}.png"), i.to_string()],
            )
            .unwrap();
        }
        // SQLite 原生 LIMIT -1 表示不限；钳制后按 1 条返回
        assert_eq!(
            list_history_in(&c, -1, 0, None, "", "", false)
                .unwrap()
                .len(),
            1
        );
        // LIMIT 0 原本返回空页，钳制后至少 1 条，避免前端把空页当成「已到底」
        assert_eq!(
            list_history_in(&c, 0, 0, None, "", "", false)
                .unwrap()
                .len(),
            1
        );
        // 负数 offset 与 0 等价
        assert_eq!(
            list_history_in(&c, 10, -5, None, "", "", false)
                .unwrap()
                .len(),
            3
        );
    }

    /// E2：画廊用游标翻页，删除首页记录后继续加载不跳项
    #[test]
    fn list_history_cursor_pagination_survives_deletes() {
        let c = mem_conn();
        for i in 0..5 {
            c.execute(
                "INSERT INTO history (prompt, model, provider_name, style, file_path, favorite, created_at, op)
                 VALUES (?1, 'm', 'P', 's', ?2, 0, ?3, 'generate')",
                params![format!("p{i}"), format!("/tmp/{i}.png"), i.to_string()],
            )
            .unwrap();
        }
        let ids = |rows: Vec<HistoryRow>| rows.iter().map(|r| r.id).collect::<Vec<_>>();
        let first = ids(list_history_in(&c, 2, 0, None, "", "", false).unwrap());
        assert_eq!(first, vec![5, 4]);
        // 删掉已展示的记录，offset 会跳项；游标（id < 最后一条）不会
        c.execute("DELETE FROM history WHERE id = 4", []).unwrap();
        let next = ids(list_history_in(&c, 2, 0, Some(4), "", "", false).unwrap());
        assert_eq!(next, vec![3, 2]);
        let tail = ids(list_history_in(&c, 2, 0, Some(2), "", "", false).unwrap());
        assert_eq!(tail, vec![1]);
        // 新增记录不会插进已翻过的游标之后
        c.execute(
            "INSERT INTO history (prompt, model, provider_name, style, file_path, favorite, created_at, op)
             VALUES ('new', 'm', 'P', 's', '/tmp/new.png', 0, '9', 'generate')",
            [],
        )
        .unwrap();
        let after = ids(list_history_in(&c, 2, 0, Some(2), "", "", false).unwrap());
        assert_eq!(after, vec![1]);
    }
}
