//! 计费请求流水：「已扣费却没图」防护。
//!
//! 同步生图接口没有幂等键、没有按 id 查询、断开客户端也不阻止上游计费。
//! 这里只做三件事：请求发出前落意图、收到 200 立刻落「已受理」、结束时落
//! 终态与产物引用。任何一步失败都不得阻断主流程——流水是证据，不是闸门。

use crate::adapters::AdapterError;
use crate::error::AppResult;
use crate::storage;
use rusqlite::params;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

pub const STATE_CREATED: &str = "created";
pub const STATE_SENT: &str = "sent";
pub const STATE_BILLED: &str = "billed";
pub const STATE_SUCCEEDED: &str = "succeeded";
pub const STATE_PARTIAL: &str = "partial";
pub const STATE_BILLED_UNRECOVERED: &str = "billed_unrecovered";
pub const STATE_FAILED: &str = "failed";
pub const STATE_UNKNOWN: &str = "unknown";
pub const STATE_RECOVERED: &str = "recovered";
pub const STATE_ABANDONED: &str = "abandoned";

/// 尚未收敛的请求：重启后一律转 unknown，绝不自动重发。
const ACTIVE_STATES: &[&str] = &[STATE_CREATED, STATE_SENT, STATE_BILLED];

/// 同参去重窗口：生成有随机性，但几分钟内完全相同的参数几乎只可能是连点/重试。
const DEDUPE_WINDOW_MS: u64 = 10 * 60 * 1000;
/// raw 响应体保留时长
const RAW_RETENTION_SECS: u64 = 7 * 24 * 3600;

static REQUESTS_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn init_requests_dir(dir: PathBuf) {
    let _ = REQUESTS_DIR.set(dir);
}

pub fn requests_dir() -> Option<&'static Path> {
    REQUESTS_DIR.get().map(|p| p.as_path())
}

/// 一次 HTTP 尝试的描述。
pub struct AttemptSpec<'a> {
    pub group_id: &'a str,
    pub entry: &'a str,
    pub op: &'a str,
    pub job_id: Option<i64>,
    pub provider_id: i64,
    pub provider_name: &'a str,
    pub model: &'a str,
    pub prompt: &'a str,
    pub endpoint: &'a str,
    pub attempt: u32,
    pub param_hash: &'a str,
    pub image_count: u32,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRequestRow {
    pub id: i64,
    pub group_id: String,
    pub client_request_id: String,
    pub entry: String,
    pub op: String,
    pub job_id: Option<i64>,
    pub provider_id: i64,
    pub provider_name: String,
    pub model: String,
    /// 仅供恢复与对账内部使用，不通过 IPC 暴露给前端
    #[serde(skip_serializing)]
    pub prompt: String,
    pub endpoint: String,
    pub attempt: u32,
    pub state: String,
    pub http_status: Option<u16>,
    pub provider_request_id: String,
    /// 请求指纹（只在前端展示前 12 位时另取）
    #[serde(skip_serializing)]
    pub param_hash: String,
    pub image_count: u32,
    pub artifacts_json: String,
    pub raw_path: String,
    pub error_json: Option<String>,
    pub created_at: String,
    pub sent_at: Option<String>,
    pub billed_at: Option<String>,
    pub finished_at: Option<String>,
}

const ROW_COLUMNS: &str = "id, group_id, client_request_id, entry, op, job_id, provider_id, \
     provider_name, model, prompt, endpoint, attempt, state, http_status, provider_request_id, \
     param_hash, image_count, artifacts_json, raw_path, error_json, created_at, sent_at, billed_at, \
     finished_at";

fn row_from(r: &rusqlite::Row) -> rusqlite::Result<ImageRequestRow> {
    Ok(ImageRequestRow {
        id: r.get(0)?,
        group_id: r.get(1)?,
        client_request_id: r.get(2)?,
        entry: r.get(3)?,
        op: r.get(4)?,
        job_id: r.get(5)?,
        provider_id: r.get(6)?,
        provider_name: r.get(7)?,
        model: r.get(8)?,
        prompt: r.get(9)?,
        endpoint: r.get(10)?,
        attempt: r.get(11)?,
        state: r.get(12)?,
        http_status: r.get::<_, Option<i64>>(13)?.map(|n| n as u16),
        provider_request_id: r.get(14)?,
        param_hash: r.get(15)?,
        image_count: r.get(16)?,
        artifacts_json: r.get(17)?,
        raw_path: r.get(18)?,
        error_json: r.get(19)?,
        created_at: r.get(20)?,
        sent_at: r.get(21)?,
        billed_at: r.get(22)?,
        finished_at: r.get(23)?,
    })
}

fn next_client_request_id() -> String {
    format!(
        "ml-{}-{:016x}",
        storage::timestamp_millis().replace('.', ""),
        rand::random::<u64>()
    )
}

fn timestamp_millis_minus(ms: u64) -> String {
    let now = storage::timestamp_millis();
    let (secs, millis) = now.split_once('.').unwrap_or((now.as_str(), "0"));
    let secs: u64 = secs.parse().unwrap_or(0);
    let millis: u64 = millis.parse().unwrap_or(0);
    let total = secs
        .saturating_mul(1000)
        .saturating_add(millis)
        .saturating_sub(ms);
    format!("{}.{:03}", total / 1000, total % 1000)
}

/// 一次 HTTP 尝试的运行时上下文。DB 写失败只告警，不影响生成。
pub struct AttemptCtx {
    row_id: i64,
    client_request_id: String,
    requested_count: u32,
    billed: AtomicBool,
    raw_path: Mutex<String>,
    artifacts: Mutex<Vec<String>>,
}

impl AttemptCtx {
    /// 落「请求意图」并返回上下文。插入失败视为致命：宁可这次不出图，
    /// 也不要在没有账的情况下发一个可能扣费的请求。
    pub fn begin(spec: &AttemptSpec<'_>) -> AppResult<Self> {
        let client_request_id = next_client_request_id();
        let mut raw_path = String::new();
        let row_id = {
            let c = storage::conn()?;
            c.execute(
                "INSERT INTO image_requests (group_id, client_request_id, entry, op, job_id,
                 provider_id, provider_name, model, prompt, endpoint, attempt, state,
                 param_hash, image_count, created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
                params![
                    spec.group_id,
                    client_request_id,
                    spec.entry,
                    spec.op,
                    spec.job_id,
                    spec.provider_id,
                    spec.provider_name,
                    spec.model,
                    spec.prompt,
                    spec.endpoint,
                    spec.attempt,
                    STATE_CREATED,
                    spec.param_hash,
                    spec.image_count,
                    storage::timestamp_millis(),
                ],
            )?;
            c.last_insert_rowid()
        };
        if let Some(dir) = requests_dir() {
            raw_path = dir
                .join(format!("{client_request_id}.body"))
                .display()
                .to_string();
        }
        let ctx = Self {
            row_id,
            client_request_id,
            requested_count: spec.image_count,
            billed: AtomicBool::new(false),
            raw_path: Mutex::new(raw_path),
            artifacts: Mutex::new(Vec::new()),
        };
        // 连点防护：同一指纹已有更早的在途请求时，本次不发送（尚未产生任何计费）。
        if has_conflict(&ctx, spec.param_hash) {
            ctx.finish(STATE_FAILED, None, &[]);
            return Err(crate::error::AppError::Other(
                "相同参数的请求正在进行中，请等待结果出来后再试（重复提交会重复计费）".into(),
            ));
        }
        Ok(ctx)
    }

    pub fn client_request_id(&self) -> &str {
        &self.client_request_id
    }

    pub fn is_billed(&self) -> bool {
        self.billed.load(Ordering::SeqCst)
    }

    fn update(&self, sql: &str, values: &[&dyn rusqlite::ToSql]) {
        match storage::conn() {
            Ok(c) => {
                if let Err(e) = c.execute(sql, values) {
                    tracing::warn!("计费流水写入失败（不阻断生成）: {e}");
                }
            }
            Err(e) => tracing::warn!("计费流水打开数据库失败（不阻断生成）: {e}"),
        }
    }

    /// 请求体已经发出：此后任何失败都可能是「上游已计费」。
    pub fn mark_sent(&self) {
        self.update(
            "UPDATE image_requests SET state = 'sent', sent_at = ?1 WHERE id = ?2",
            &[&storage::timestamp_millis(), &self.row_id],
        );
    }

    /// 收到 2xx：先记「已受理 N 张」，再去读 body / 下载图片。
    pub fn mark_billed(&self, http_status: u16, count: Option<u32>) {
        self.billed.store(true, Ordering::SeqCst);
        let count = count.unwrap_or(self.requested_count) as i64;
        self.update(
            "UPDATE image_requests SET state = 'billed', http_status = ?1, image_count = ?2, \
             billed_at = ?3 WHERE id = ?4",
            &[
                &(http_status as i64),
                &count,
                &storage::timestamp_millis(),
                &self.row_id,
            ],
        );
    }

    /// 记录服务商请求 id（x-request-id / request-id），供客服与后台对账。
    pub fn capture_request_id(&self, value: &str) {
        if value.is_empty() {
            return;
        }
        self.update(
            "UPDATE image_requests SET provider_request_id = ?1 WHERE id = ?2",
            &[&value, &self.row_id],
        );
    }

    /// 原始响应体先落盘再解析：解析/保存失败时仍留可复查的证据。
    pub fn stash_raw(&self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let path = self.raw_path.lock().map(|p| p.clone()).unwrap_or_default();
        if path.is_empty() {
            return;
        }
        let path = PathBuf::from(path);
        let Some(dir) = path.parent() else {
            return;
        };
        if let Err(e) = std::fs::create_dir_all(dir) {
            tracing::warn!("创建请求缓存目录失败: {e}");
            return;
        }
        let tmp = path.with_extension("body.tmp");
        if let Err(e) = std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, &path)) {
            tracing::warn!("写入原始响应失败: {e}");
            let _ = std::fs::remove_file(&tmp);
            return;
        }
        self.update(
            "UPDATE image_requests SET raw_path = ?1 WHERE id = ?2",
            &[&path.display().to_string(), &self.row_id],
        );
    }

    /// 产物已入库，raw 不再需要。
    pub fn discard_raw(&self) {
        let path = self.raw_path.lock().map(|p| p.clone()).unwrap_or_default();
        if !path.is_empty() {
            let _ = std::fs::remove_file(path);
        }
    }

    /// 记录待恢复产物（例如下载失败的图片 URL），由 `finish` 一并落库。
    pub fn note_artifact(&self, value: &str) {
        if value.is_empty() {
            return;
        }
        if let Ok(mut list) = self.artifacts.lock() {
            if !list.iter().any(|v| v == value) {
                list.push(value.to_string());
            }
        }
    }

    /// 写终态。`artifacts` 为已落库图片路径；此前 `note_artifact` 记录的
    /// 待恢复 URL 会合并进来。
    pub fn finish(&self, state: &str, err: Option<&AdapterError>, artifacts: &[String]) {
        let error_json = err.and_then(|e| serde_json::to_string(e).ok());
        let mut merged = self
            .artifacts
            .lock()
            .map(|list| list.clone())
            .unwrap_or_default();
        for item in artifacts {
            if !merged.iter().any(|v| v == item) {
                merged.push(item.clone());
            }
        }
        let artifacts_json = serde_json::to_string(&merged).unwrap_or_else(|_| "[]".into());
        self.update(
            "UPDATE image_requests SET state = ?1, error_json = ?2, artifacts_json = ?3, \
             finished_at = ?4 WHERE id = ?5",
            &[
                &state,
                &error_json,
                &artifacts_json,
                &storage::timestamp_millis(),
                &self.row_id,
            ],
        );
    }
}

/// 计费风险分类：只有 NotBilled 允许自动重试。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BillingClass {
    /// 确定没有产生计费（建连失败、鉴权/配额/参数错误）
    NotBilled,
    /// 可能已经计费，但没有产物证据
    PossiblyBilled,
    /// 确定已受理（200），产物缺失
    BilledUnrecovered,
}

pub fn classify_billing(err: &AdapterError, billed: bool) -> BillingClass {
    if billed {
        return BillingClass::BilledUnrecovered;
    }
    match err {
        AdapterError::Network { .. }
        | AdapterError::AuthInvalid { .. }
        | AdapterError::QuotaExceeded { .. }
        | AdapterError::ContentBlocked { .. }
        | AdapterError::Unsupported { .. }
        | AdapterError::Other { .. } => BillingClass::NotBilled,
        AdapterError::Timeout { .. }
        | AdapterError::Upstream { .. }
        | AdapterError::BodyInterrupted { .. }
        | AdapterError::Unconfirmed { .. } => BillingClass::PossiblyBilled,
    }
}

/// 同参请求是否正在进行中（排除本次刚插入的行）：命中则拒绝发送。
fn has_conflict(ctx: &AttemptCtx, param_hash: &str) -> bool {
    if param_hash.is_empty() {
        return false;
    }
    let Ok(c) = storage::conn() else {
        return false;
    };
    let cutoff = timestamp_millis_minus(DEDUPE_WINDOW_MS);
    let active = ACTIVE_STATES
        .iter()
        .map(|s| format!("'{s}'"))
        .collect::<Vec<_>>()
        .join(",");
    c.query_row(
        &format!(
            "SELECT COUNT(*) FROM image_requests WHERE param_hash = ?1 AND id < ?2 \
             AND state IN ({active}) AND created_at >= ?3"
        ),
        params![param_hash, ctx.row_id, cutoff],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .unwrap_or(false)
}

/// 本地保存失败时把图片本体留在请求目录：恢复入口无需重新生成即可入库。
pub fn stash_b64_artifact(client_request_id: &str, index: usize, b64: &str) -> Option<String> {
    let dir = requests_dir()?;
    std::fs::create_dir_all(dir).ok()?;
    let path = dir.join(format!("{client_request_id}-{}.b64", index + 1));
    std::fs::write(&path, b64.as_bytes()).ok()?;
    Some(path.display().to_string())
}

pub fn list_pending() -> AppResult<Vec<ImageRequestRow>> {
    let c = storage::conn()?;
    let mut stmt = c.prepare(&format!(
        "SELECT {ROW_COLUMNS} FROM image_requests \
         WHERE state IN ('unknown','billed_unrecovered','partial') ORDER BY id DESC LIMIT 200"
    ))?;
    let rows = stmt.query_map([], row_from)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

pub fn list_recent(limit: usize) -> AppResult<Vec<ImageRequestRow>> {
    let c = storage::conn()?;
    let mut stmt = c.prepare(&format!(
        "SELECT {ROW_COLUMNS} FROM image_requests ORDER BY id DESC LIMIT ?1"
    ))?;
    let rows = stmt.query_map(params![limit.clamp(1, 500) as i64], row_from)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

pub fn get(id: i64) -> AppResult<Option<ImageRequestRow>> {
    let c = storage::conn()?;
    let mut stmt = c.prepare(&format!(
        "SELECT {ROW_COLUMNS} FROM image_requests WHERE id = ?1"
    ))?;
    let mut rows = stmt.query_map(params![id], row_from)?;
    Ok(rows.next().transpose()?)
}

/// 按请求 id 查（聊天消息里只带 client_request_id，用于「尝试恢复」入口）
pub fn get_by_client_request(client_request_id: &str) -> AppResult<Option<ImageRequestRow>> {
    let c = storage::conn()?;
    let mut stmt = c.prepare(&format!(
        "SELECT {ROW_COLUMNS} FROM image_requests WHERE client_request_id = ?1 \
         ORDER BY id DESC LIMIT 1"
    ))?;
    let mut rows = stmt.query_map(params![client_request_id], row_from)?;
    Ok(rows.next().transpose()?)
}

/// 人工/恢复路径允许的状态迁移：终态不可回退，只能从非终态收敛到恢复/放弃/部分。
pub fn can_transition(from: &str, to: &str) -> bool {
    if from == to {
        return true;
    }
    let from_terminal = matches!(
        from,
        STATE_SUCCEEDED | STATE_FAILED | STATE_RECOVERED | STATE_ABANDONED
    );
    !from_terminal && matches!(to, STATE_RECOVERED | STATE_ABANDONED | STATE_PARTIAL)
}

pub fn mark_state(id: i64, state: &str) -> AppResult<()> {
    let c = storage::conn()?;
    let current: String = c.query_row(
        "SELECT state FROM image_requests WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )?;
    if !can_transition(&current, state) {
        return Err(crate::error::AppError::Other(format!(
            "非法的状态迁移：{current} → {state}"
        )));
    }
    c.execute(
        "UPDATE image_requests SET state = ?1, finished_at = ?2 WHERE id = ?3",
        params![state, storage::timestamp_millis(), id],
    )?;
    Ok(())
}

/// 启动恢复：未收敛的在途请求一律转 unknown（对齐 Cherry Studio 的 abandon），
/// 绝不重放；同时把对应队列任务标成待确认，并清理过期 raw。
pub fn recover_on_startup() {
    match storage::conn() {
        Ok(c) => {
            let now = storage::timestamp_millis();
            match c.execute(
                &format!(
                    "UPDATE image_requests SET state = '{}', finished_at = ?1 \
                     WHERE state IN ('{}','{}','{}')",
                    STATE_UNKNOWN, STATE_CREATED, STATE_SENT, STATE_BILLED
                ),
                params![now],
            ) {
                Ok(n) if n > 0 => {
                    tracing::warn!("已将 {n} 条在途计费请求标记为「结果未确认」，不会自动重发")
                }
                Ok(_) => {}
                Err(e) => tracing::warn!("启动恢复计费流水失败: {e}"),
            }
            if let Err(e) = c.execute(
                "UPDATE jobs SET billing_state = 'unknown' \
                 WHERE status = 'interrupted' AND billing_state = '' \
                 AND id IN (SELECT job_id FROM image_requests WHERE state = 'unknown' \
                            AND job_id IS NOT NULL)",
                [],
            ) {
                tracing::warn!("同步队列待确认状态失败: {e}");
            }
        }
        Err(e) => tracing::warn!("启动恢复打开数据库失败: {e}"),
    }
    cleanup_stale_raw();
}

fn cleanup_stale_raw() {
    let Some(dir) = requests_dir() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let old = meta
            .modified()
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|d| d.as_secs() > RAW_RETENTION_SECS);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err(kind: &str) -> AdapterError {
        match kind {
            "network" => AdapterError::Network {
                message: "connect refused".into(),
            },
            "auth" => AdapterError::AuthInvalid {
                message: "bad key".into(),
                status: 401,
            },
            "quota" => AdapterError::QuotaExceeded {
                message: "quota".into(),
                retry_after: Some(3),
            },
            "content" => AdapterError::ContentBlocked {
                message: "blocked".into(),
            },
            "unsupported" => AdapterError::Unsupported {
                message: "nope".into(),
            },
            "other" => AdapterError::Other {
                message: "bad request".into(),
            },
            "timeout" => AdapterError::Timeout {
                message: "header wait".into(),
            },
            "upstream" => AdapterError::Upstream {
                message: "502".into(),
                status: 502,
            },
            "interrupted" => AdapterError::BodyInterrupted {
                message: "reset".into(),
            },
            _ => AdapterError::Unconfirmed {
                message: "unknown".into(),
                request_id: "req-1".into(),
                artifact: None,
            },
        }
    }

    /// 计费分类矩阵：只有确定未送达的失败可以自动重试，模糊失败一律待确认
    #[test]
    fn classify_billing_matrix() {
        for kind in [
            "network",
            "auth",
            "quota",
            "content",
            "unsupported",
            "other",
        ] {
            assert_eq!(
                classify_billing(&err(kind), false),
                BillingClass::NotBilled,
                "{kind}"
            );
        }
        for kind in ["timeout", "upstream", "interrupted", "unconfirmed"] {
            assert_eq!(
                classify_billing(&err(kind), false),
                BillingClass::PossiblyBilled,
                "{kind}"
            );
        }
        // 已收到 200：无论错误是什么，都按「已计费未取回」处理
        assert_eq!(
            classify_billing(&err("other"), true),
            BillingClass::BilledUnrecovered
        );
    }

    /// 终态不可回退：恢复/放弃只能收敛，不能把已完成的记录重新标成未知
    #[test]
    fn state_transition_guard() {
        for terminal in [
            STATE_SUCCEEDED,
            STATE_FAILED,
            STATE_RECOVERED,
            STATE_ABANDONED,
        ] {
            assert!(!can_transition(terminal, STATE_UNKNOWN), "{terminal}");
            assert!(!can_transition(terminal, STATE_PARTIAL), "{terminal}");
        }
        for pending in [STATE_UNKNOWN, STATE_BILLED_UNRECOVERED, STATE_PARTIAL] {
            assert!(can_transition(pending, STATE_RECOVERED), "{pending}");
            assert!(can_transition(pending, STATE_ABANDONED), "{pending}");
            assert!(can_transition(pending, STATE_PARTIAL), "{pending}");
            // 不允许回退到「进行中」，否则会诱发重复发送
            assert!(!can_transition(pending, STATE_CREATED), "{pending}");
            assert!(!can_transition(pending, STATE_SENT), "{pending}");
            assert!(!can_transition(pending, STATE_BILLED), "{pending}");
        }
    }

    /// 初始化全局测试库并持有串行锁：返回的 guard 必须活到测试结束，
    /// 否则 storage 模块的全局 DB 测试可能与这里交错。
    fn init_test_db() -> std::sync::MutexGuard<'static, ()> {
        let guard = storage::TEST_DB_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("moling-journal-{}", std::process::id()));
        init_requests_dir(dir.join("requests"));
        if storage::conn().is_err() {
            let _ = std::fs::remove_dir_all(&dir);
            storage::init(dir.clone()).expect("init storage");
        }
        guard
    }

    fn spec<'a>(group: &'a str, hash: &'a str, image_count: u32) -> AttemptSpec<'a> {
        AttemptSpec {
            group_id: group,
            entry: "chat",
            op: "generate",
            job_id: None,
            provider_id: 1,
            provider_name: "test-provider",
            model: "test-model",
            prompt: "a cat",
            endpoint: "/images/generations",
            attempt: 1,
            param_hash: hash,
            image_count,
        }
    }

    /// 端到端：同参去重、sent→billed→succeeded、raw 先落盘、启动转 unknown、终态拒绝回退
    #[test]
    fn journal_lifecycle_dedupe_raw_and_startup_recovery() {
        let _db_guard = init_test_db();
        let tag = std::process::id();

        let dup_hash = format!("dedupe-{tag}");

        // 相同指纹的第二次请求在发送前被拒绝；第一次的意图记录保持原状
        let dup_spec = spec("group-dedupe", &dup_hash, 1);
        let first = AttemptCtx::begin(&dup_spec).expect("first begin");
        assert!(AttemptCtx::begin(&dup_spec).is_err());
        let first_row = get_by_client_request(first.client_request_id())
            .unwrap()
            .expect("first row");
        assert_eq!(first_row.state, STATE_CREATED);
        first.finish(STATE_FAILED, None, &[]);

        // 正常生命周期：200 先记 billed，再逐张保存
        let flow_hash = format!("flow-{tag}");
        let flow_spec = spec("group-flow", &flow_hash, 1);
        let ctx = AttemptCtx::begin(&flow_spec).expect("flow begin");
        ctx.mark_sent();
        let row = get_by_client_request(ctx.client_request_id())
            .unwrap()
            .unwrap();
        assert_eq!(row.state, STATE_SENT);
        ctx.mark_billed(200, Some(2));
        let row = get_by_client_request(ctx.client_request_id())
            .unwrap()
            .unwrap();
        assert_eq!(row.state, STATE_BILLED);
        assert_eq!(row.http_status, Some(200));
        assert_eq!(row.image_count, 2);
        ctx.finish(STATE_SUCCEEDED, None, &[]);
        let row = get_by_client_request(ctx.client_request_id())
            .unwrap()
            .unwrap();
        assert_eq!(row.state, STATE_SUCCEEDED);
        assert!(mark_state(row.id, STATE_UNKNOWN).is_err());

        // 原始响应先落盘；成功后可删除
        let raw_hash = format!("raw-{tag}");
        let raw_spec = spec("group-raw", &raw_hash, 1);
        let ctx = AttemptCtx::begin(&raw_spec).expect("raw begin");
        ctx.mark_sent();
        ctx.mark_billed(200, Some(1));
        ctx.stash_raw(br#"{"data":[{"url":"https://example.test/a.png"}]}"#);
        let row = get_by_client_request(ctx.client_request_id())
            .unwrap()
            .unwrap();
        assert!(row.raw_path.ends_with(".body"));
        assert!(std::path::Path::new(&row.raw_path).exists());
        ctx.discard_raw();
        assert!(!std::path::Path::new(&row.raw_path).exists());

        // 进程重启：billed 一律转 unknown，绝不重放；随后可人工恢复
        recover_on_startup();
        let row = get_by_client_request(ctx.client_request_id())
            .unwrap()
            .unwrap();
        assert_eq!(row.state, STATE_UNKNOWN);
        assert!(list_pending().unwrap().iter().any(|r| r.id == row.id));
        mark_state(row.id, STATE_RECOVERED).unwrap();
        assert!(!list_pending().unwrap().iter().any(|r| r.id == row.id));
        assert!(mark_state(row.id, STATE_UNKNOWN).is_err());
    }
}
