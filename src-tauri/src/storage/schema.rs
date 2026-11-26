use super::*;

use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection};

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

/// 迁移 014：画布 v1→v2 快照。旧版打开 v2 文档只会保留节点而丢掉图层，
/// 首次以 v2 覆盖保存前把上一版文档留在这里，必要时可手工回退。
const CANVAS_PREV_SQL: &str = "
        ALTER TABLE canvas_boards ADD COLUMN data_json_prev TEXT NOT NULL DEFAULT '';
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
    ("014_canvas_prev", CANVAS_PREV_SQL),
];

/// 当前 schema 版本 = 迁移条数
pub(crate) const SCHEMA_VERSION: i64 = MIGRATIONS.len() as i64;
pub(crate) fn current_version(conn: &Connection) -> AppResult<i64> {
    Ok(conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}

pub(crate) fn table_missing(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![name],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n == 0)
    .unwrap_or(true)
}
pub(crate) fn backup_before_migration(db_path: &std::path::Path) {
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
/// 当前代码期望的 schema 版本（诊断包用）
pub fn schema_version() -> i64 {
    SCHEMA_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::*;

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

    /// 迁移 014：从 v13 升级后画布表多出 data_json_prev，且默认空串
    #[test]
    fn migration_014_adds_canvas_prev_column() {
        let mut c = Connection::open_in_memory().unwrap();
        apply_migrations_with(&mut c, &MIGRATIONS[..13]).unwrap();
        assert_eq!(user_version_of(&c), 13);
        let before: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('canvas_boards') WHERE name = 'data_json_prev'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(before, 0);

        apply_migrations(&mut c).unwrap();
        assert_eq!(user_version_of(&c), MIGRATIONS.len() as i64);
        let after: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('canvas_boards') WHERE name = 'data_json_prev'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(after, 1);

        let board = create_canvas_board_in(&c, "升级后").unwrap();
        let prev: String = c
            .query_row(
                "SELECT data_json_prev FROM canvas_boards WHERE id = ?1",
                params![board.id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(prev.is_empty(), "新画布不应有旧版快照");
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
}
