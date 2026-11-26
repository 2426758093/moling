use super::*;

use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::*;

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
}
