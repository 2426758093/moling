//! 批量生成队列：固定 4 个 worker 槽位共享一条排队队列，状态机全部走带前置条件的 SQL 迁移。
//!
//! 设计要点：
//! - 启动时 `running → interrupted` 且默认暂停：重启后绝不自动重跑（避免重复扣费）。
//! - 领取任务用单条 UPDATE 原地完成「选最早 + 抢占 + 并发上限判断」，同一任务不会被领两次。
//! - 并发上限来自设置 `queueConcurrency`（1–4，默认 1），每次领取时读取，改设置立即生效。
//! - 取消 queued 立即置 canceled；取消 running 只置取消标记，由 worker 收尾。
//! - 结果只写 history（画廊可见），不生成聊天消息，避免两套状态互相打架。

use crate::billing_journal;
use crate::commands::image::{
    generate_core, is_cancelled, normalize_generation, normalize_quality, CancelRegistration,
    GenerateCommandInput, GenerationRegistry, MAX_REFERENCE_IMAGES,
};
use crate::image_store;
use crate::reference::ReferenceSpec;
use crate::storage::{self, JobRow, NewJob};
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager};

/// 并发上限设置项：必须与 settings.rs 白名单、备份清单、诊断导出保持同步
pub const QUEUE_CONCURRENCY_KEY: &str = "queueConcurrency";
pub const MIN_CONCURRENCY: i64 = 1;
pub const MAX_CONCURRENCY: i64 = 4;
pub const DEFAULT_CONCURRENCY: i64 = 1;

/// 每服务商并发：图像端点并发能力远低于文本，默认 1，最多 2
pub const QUEUE_PROVIDER_CONCURRENCY_KEY: &str = "queueProviderConcurrency";
pub const MIN_PROVIDER_CONCURRENCY: i64 = 1;
pub const MAX_PROVIDER_CONCURRENCY: i64 = 2;
pub const DEFAULT_PROVIDER_CONCURRENCY: i64 = 1;

/// 待执行任务上限：无界堆积只会让用户排队几小时，不如尽早提示
const MAX_QUEUED_JOBS: i64 = 200;

/// 429 退避重试：最多 2 次，等待时间取 Retry-After（无则 5s），单次不超过 60s
const MAX_QUOTA_RETRIES: u32 = 2;
const DEFAULT_QUOTA_BACKOFF_SECS: u64 = 5;
const MAX_QUOTA_BACKOFF_SECS: u64 = 60;

/// running 任务心跳间隔与回收阈值：心跳存在时按心跳判断，长任务不会被误回收
const HEARTBEAT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);
const STALE_RUNNING_AGE: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// 固定 worker 槽位数：等于并发上限的最大值，空闲槽位只等通知不耗 CPU
const WORKER_SLOTS: usize = 4;

/// 队列执行器状态：`notify` 唤醒 worker，`paused` 控制是否真的开跑。
pub struct QueueState {
    notify: tokio::sync::Notify,
    paused: AtomicBool,
}

impl Default for QueueState {
    fn default() -> Self {
        Self {
            notify: tokio::sync::Notify::new(),
            // 启动即暂停：用户点「开始队列」后才执行
            paused: AtomicBool::new(true),
        }
    }
}

impl QueueState {
    fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    /// 唤醒所有等待中的 worker（有空位/新任务/解除暂停时调用）
    fn wake(&self) {
        self.notify.notify_waiters();
    }

    /// 等一次唤醒。带 1s 兜底超时：`notify_waiters` 不存许可，
    /// worker 恰好在「领取失败」与「开始等待」之间时会错过那一次通知。
    async fn wait(&self) {
        let _ =
            tokio::time::timeout(std::time::Duration::from_secs(1), self.notify.notified()).await;
    }
}

pub type SharedQueue = Arc<QueueState>;

/// 数据库/网络异常时 worker 的休眠，避免出错时空转
const WORKER_RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(5);

const ALL_STATUSES: [&str; 6] = [
    "queued",
    "running",
    "done",
    "failed",
    "canceled",
    "interrupted",
];

/// 各状态计数（缺省补 0，前端不必自行兜底）
pub fn counts_json() -> serde_json::Value {
    let mut map = serde_json::Map::new();
    for status in ALL_STATUSES {
        map.insert(status.to_string(), serde_json::json!(0));
    }
    if let Ok(rows) = storage::job_counts() {
        for (status, count) in rows {
            map.insert(status, serde_json::json!(count));
        }
    }
    serde_json::Value::Object(map)
}

/// 解析并发上限：非法值回退默认 1，超出范围夹到 1–4
pub fn concurrency_limit_from(raw: Option<&str>) -> i64 {
    raw.and_then(|s| s.trim().parse::<i64>().ok())
        .map(|n| n.clamp(MIN_CONCURRENCY, MAX_CONCURRENCY))
        .unwrap_or(DEFAULT_CONCURRENCY)
}

fn concurrency_limit() -> i64 {
    concurrency_limit_from(
        storage::get_setting(QUEUE_CONCURRENCY_KEY)
            .ok()
            .flatten()
            .as_deref(),
    )
}

pub fn provider_concurrency_from(raw: Option<&str>) -> i64 {
    raw.and_then(|s| s.trim().parse::<i64>().ok())
        .map(|n| n.clamp(MIN_PROVIDER_CONCURRENCY, MAX_PROVIDER_CONCURRENCY))
        .unwrap_or(DEFAULT_PROVIDER_CONCURRENCY)
}

fn provider_concurrency_limit() -> i64 {
    provider_concurrency_from(
        storage::get_setting(QUEUE_PROVIDER_CONCURRENCY_KEY)
            .ok()
            .flatten()
            .as_deref(),
    )
}

fn emit_job(app: &tauri::AppHandle, id: i64) {
    if let Ok(Some(job)) = storage::get_job(id) {
        let _ = app.emit("queue:job", job);
    }
    let _ = app.emit("queue:counts", counts_json());
}

/// 启动队列 worker（setup 中调用一次）。
pub fn spawn_worker(app: tauri::AppHandle, state: SharedQueue) {
    for _ in 0..WORKER_SLOTS {
        let app = app.clone();
        let state = state.clone();
        tauri::async_runtime::spawn(async move { worker_loop(app, state).await });
    }
}

async fn worker_loop(app: tauri::AppHandle, state: SharedQueue) {
    // 卡死任务回收不需要每次空转都扫库，一分钟一次足够
    const REAP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);
    // running 超过阈值且没有新心跳 → 视为 worker 卡住；
    // 进程崩溃留下的 running 由启动时的 mark_running_interrupted 负责
    let mut last_reap = std::time::Instant::now();
    loop {
        if last_reap.elapsed() >= REAP_INTERVAL {
            last_reap = std::time::Instant::now();
            match storage::reap_stale_running(STALE_RUNNING_AGE) {
                Ok(0) => {}
                Ok(n) => {
                    tracing::warn!("回收 {n} 个长时间未收尾的队列任务");
                    let _ = app.emit("queue:counts", counts_json());
                }
                Err(e) => tracing::warn!("回收卡死任务失败: {e}"),
            }
        }
        if state.is_paused() {
            state.wait().await;
            continue;
        }
        let job = match storage::claim_next_job_limited(
            concurrency_limit(),
            provider_concurrency_limit(),
        ) {
            Ok(Some(job)) => job,
            Ok(None) => {
                state.wait().await;
                continue;
            }
            Err(e) => {
                tracing::warn!("读取队列失败: {e}");
                tokio::time::sleep(WORKER_RETRY_DELAY).await;
                continue;
            }
        };
        // 已领取即 running，先推一次让前端立刻看到
        emit_job(&app, job.id);
        if let Err(e) = run_job(&app, &job).await {
            tracing::warn!("队列任务 #{} 收尾失败: {e}", job.id);
            // 正常收尾已经失败：不能把这一行留在 running，否则会永久占用并发槽位
            force_fail_job(job.id, &e).await;
        }
        emit_job(&app, job.id);
        // 空出一个名额：唤醒其它槽位重新尝试领取
        state.wake();
    }
}

/// 兜底收尾（F-006）：正常 `finish_job` 写库失败后，用不要求当前是 running 的
/// `finish_job_force` 重试几次；仍失败就交给周期回收（`reap_stale_running`）。
async fn force_fail_job(job_id: i64, reason: &str) {
    let mut delay = std::time::Duration::from_millis(200);
    for attempt in 1..=3 {
        match storage::finish_job_force(job_id, "failed", "[]", Some(reason)) {
            Ok(_) => return,
            Err(e) if attempt < 3 => {
                tracing::warn!("队列任务 #{job_id} 兜底收尾第 {attempt} 次失败: {e}");
                tokio::time::sleep(delay).await;
                delay *= 2;
            }
            Err(e) => {
                tracing::error!("队列任务 #{job_id} 兜底收尾失败，等待超时回收: {e}")
            }
        }
    }
}

/// 入队时存进 `jobs.input_json` 的扩展参数（列里没有的字段）
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct JobExtras {
    pub reference_paths: Vec<String>,
    pub references: Vec<ReferenceSpec>,
    /// 质量档位快照；None = auto（老任务没有该字段，按默认处理）
    pub quality: Option<String>,
    /// 429 退避重试次数（持久化，避免重新入队后无限重试）
    #[serde(default)]
    pub quota_retries: u32,
}

impl JobExtras {
    fn parse(raw: &str) -> Self {
        if raw.trim().is_empty() {
            return Self::default();
        }
        serde_json::from_str(raw).unwrap_or_else(|e| {
            tracing::warn!("队列任务扩展参数解析失败（按空处理）: {e}");
            Self::default()
        })
    }
}

/// 过滤空路径并截断到参考图上限
pub fn normalize_reference_paths(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .take(MAX_REFERENCE_IMAGES)
        .collect()
}

/// 心跳守卫：任务结束（含提前返回）时自动停止心跳协程
struct HeartbeatGuard(tauri::async_runtime::JoinHandle<()>);

impl Drop for HeartbeatGuard {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn spawn_heartbeat(job_id: i64) -> HeartbeatGuard {
    HeartbeatGuard(tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(HEARTBEAT_INTERVAL);
        // interval 的第一拍立即完成，跳过后才是真正的 60s 周期
        ticker.tick().await;
        loop {
            ticker.tick().await;
            match storage::touch_job_heartbeat(job_id) {
                Ok(true) => {}
                // 已被回收 / 已离开 running，无需继续刷新
                Ok(false) => break,
                Err(e) => tracing::warn!("队列任务 #{job_id} 心跳写入失败: {e}"),
            }
        }
    }))
}

/// 正常收尾失败时（任务已被 reaper 标记）强制写入真实终态，避免结果丢失
fn finish_or_force(
    id: i64,
    status: &str,
    images_json: &str,
    error: Option<&str>,
) -> Result<(), String> {
    match storage::finish_job(id, status, images_json, error) {
        Ok(true) => Ok(()),
        Ok(false) => {
            tracing::warn!("队列任务 #{id} 已被回收，强制写入真实终态 {status}");
            storage::finish_job_force(id, status, images_json, error)
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}

/// 可能已计费的失败：落 jobs.billing_state，界面标「待确认」且默认禁止重跑。
fn unconfirmed_billing_state(err_json: &str) -> Option<&'static str> {
    let value: serde_json::Value = serde_json::from_str(err_json).ok()?;
    if value.get("type")?.as_str()? != "unconfirmed" {
        return None;
    }
    let message = value
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or_default();
    Some(if message.contains("本地保存失败") {
        billing_journal::STATE_BILLED_UNRECOVERED
    } else {
        billing_journal::STATE_UNKNOWN
    })
}

/// 从适配器错误 JSON 中识别 429；返回值外层 Some 表示是限流，内层是 Retry-After
fn quota_retry_after(err_json: &str) -> Option<Option<u64>> {
    let value: serde_json::Value = serde_json::from_str(err_json).ok()?;
    if value.get("type")?.as_str()? != "quota_exceeded" {
        return None;
    }
    Some(value.get("retry_after").and_then(|v| v.as_u64()))
}

/// 执行单个任务：领取时已是 running，这里只负责跑到终态。返回 Err 仅表示数据库收尾失败。
async fn run_job(app: &tauri::AppHandle, job: &JobRow) -> Result<(), String> {
    // B1：取消标记必须在读取参考图之前注册，否则解压/读盘阶段取消无效
    let (registration, token) = {
        let registry = app.state::<GenerationRegistry>();
        CancelRegistration::new(&registry, Some(&job.job_key))
    };
    let _heartbeat = spawn_heartbeat(job.id);
    if is_cancelled(&token) {
        finish_or_force(job.id, "canceled", "[]", None)?;
        return Ok(());
    }

    let extras = JobExtras::parse(&job.input_json);
    let mut images: Vec<String> = Vec::with_capacity(extras.reference_paths.len());
    for path in &extras.reference_paths {
        if is_cancelled(&token) {
            finish_or_force(job.id, "canceled", "[]", None)?;
            return Ok(());
        }
        match image_store::read_ref_image(app, path) {
            Ok(url) => images.push(url),
            Err(e) => {
                finish_or_force(
                    job.id,
                    "failed",
                    "[]",
                    Some(&format!("参考图读取失败: {e}")),
                )?;
                return Ok(());
            }
        }
    }

    let mut extras = extras;
    let input = GenerateCommandInput {
        provider_id: job.provider_id,
        prompt: job.prompt.clone(),
        negative_prompt: if job.negative_prompt.is_empty() {
            None
        } else {
            Some(job.negative_prompt.clone())
        },
        model: job.model.clone(),
        width: job.width as u32,
        height: job.height as u32,
        quality: extras.quality.clone(),
        guidance: job.guidance.map(|g| g as f32),
        steps: job.steps.map(|s| s as u32),
        seed: job.seed.map(|s| s as u64),
        style: job.style.clone(),
        count: job.count as u32,
        images: if images.is_empty() {
            None
        } else {
            Some(images)
        },
        references: if extras.references.is_empty() {
            None
        } else {
            Some(extras.references.clone())
        },
        job_id: None,
    };

    let progress_app = app.clone();
    let progress_id = job.id;
    let scope = super::image::GenerateScope::queue(job.id);
    let result = generate_core(app, &input, &scope, token.clone(), move |done, total| {
        let _ = progress_app.emit(
            "queue:progress",
            serde_json::json!({ "id": progress_id, "done": done, "total": total }),
        );
    })
    .await;

    match result {
        Ok(outcome) => {
            let images: Vec<serde_json::Value> = outcome
                .images
                .iter()
                .map(|img| {
                    serde_json::json!({
                        "historyId": img.history_id,
                        "path": img.file_path,
                    })
                })
                .collect();
            let images_json = serde_json::to_string(&images).unwrap_or_else(|_| "[]".to_string());
            let status = if outcome.cancelled {
                "canceled"
            } else {
                "done"
            };
            // 部分图片落盘失败不影响任务成功，但要把原因留在任务上
            let warning = (!outcome.failed.is_empty()).then(|| {
                format!(
                    "{} 张图片保存失败：{}",
                    outcome.failed.len(),
                    outcome
                        .failed
                        .iter()
                        .map(|f| format!("第 {} 张 {}", f.index, f.reason))
                        .collect::<Vec<_>>()
                        .join("；")
                )
            });
            finish_or_force(job.id, status, &images_json, warning.as_deref())?;
        }
        Err(e) => {
            // 已受理但结果未确认：记待确认状态，默认重试会被 storage 层拒绝
            if let Some(state) = unconfirmed_billing_state(&e) {
                if let Err(err) = storage::set_job_billing_state(job.id, state) {
                    tracing::warn!("写入任务 #{} 计费状态失败: {err}", job.id);
                }
            }
            if is_cancelled(&token) {
                finish_or_force(job.id, "canceled", "[]", None)?;
            } else if let Some(requested) = quota_retry_after(&e) {
                // B6：429 按 Retry-After 退避重试，次数持久化，避免无限重试
                if extras.quota_retries >= MAX_QUOTA_RETRIES {
                    finish_or_force(job.id, "failed", "[]", Some(&e))?;
                } else {
                    extras.quota_retries += 1;
                    let wait = requested
                        .unwrap_or(DEFAULT_QUOTA_BACKOFF_SECS)
                        .clamp(1, MAX_QUOTA_BACKOFF_SECS);
                    let jitter = rand::random::<u64>() % 1000;
                    tracing::warn!(
                        "队列任务 #{} 遇到限流，{}s 后重试（第 {}/{} 次）",
                        job.id,
                        wait,
                        extras.quota_retries,
                        MAX_QUOTA_RETRIES
                    );
                    // 退避期间任务仍是 running：单独广播结束时间，界面显示倒计时
                    let now_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0);
                    let expires_at = now_ms.saturating_add((wait as i64) * 1000);
                    let _ = app.emit(
                        "queue:backoff",
                        serde_json::json!({ "id": job.id, "expiresAt": expires_at }),
                    );
                    tokio::time::sleep(
                        std::time::Duration::from_secs(wait)
                            + std::time::Duration::from_millis(jitter),
                    )
                    .await;
                    let _ = app.emit(
                        "queue:backoff",
                        serde_json::json!({ "id": job.id, "expiresAt": 0 }),
                    );
                    if is_cancelled(&token) {
                        finish_or_force(job.id, "canceled", "[]", None)?;
                    } else {
                        let input_json =
                            serde_json::to_string(&extras).map_err(|e| e.to_string())?;
                        storage::requeue_running_job(job.id, &input_json)?;
                    }
                }
            } else {
                finish_or_force(job.id, "failed", "[]", Some(&e))?;
            }
        }
    }
    drop(registration);
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueInput {
    pub provider_id: i64,
    pub prompt: String,
    #[serde(default)]
    pub negative_prompt: Option<String>,
    pub model: String,
    #[serde(default)]
    pub style: String,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub guidance: Option<f32>,
    #[serde(default)]
    pub steps: Option<u32>,
    #[serde(default)]
    pub seed: Option<u64>,
    #[serde(default)]
    pub count: u32,
    #[serde(default)]
    pub quality: Option<String>,
    /// 已落盘（refs/）的参考图路径，按位置与 references 对齐
    #[serde(default)]
    pub reference_paths: Vec<String>,
    #[serde(default)]
    pub references: Vec<ReferenceSpec>,
}

#[tauri::command]
pub async fn enqueue_job(
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedQueue>,
    input: EnqueueInput,
) -> Result<JobRow, String> {
    let prompt = input.prompt.trim();
    if prompt.is_empty() {
        return Err("提示词不能为空".to_string());
    }
    if input.model.trim().is_empty() {
        return Err("请先选择模型".to_string());
    }
    let provider =
        storage::get_provider(input.provider_id)?.ok_or_else(|| "服务商不存在".to_string())?;
    // B6：队列有界，避免断网/限流时无界堆积把数据库和界面拖垮
    if storage::queued_job_count()? >= MAX_QUEUED_JOBS {
        return Err(format!(
            "队列已满（最多 {MAX_QUEUED_JOBS} 个待执行任务），请等待执行或清理后再试"
        ));
    }
    // 入队即固化参数快照，之后改默认参数不影响已排队任务
    let reference_paths = normalize_reference_paths(input.reference_paths);
    let extras = JobExtras {
        references: input
            .references
            .into_iter()
            .take(reference_paths.len())
            .collect(),
        reference_paths,
        quality: normalize_quality(input.quality.as_deref()),
        quota_retries: 0,
    };
    let input_json = serde_json::to_string(&extras).map_err(|e| e.to_string())?;
    // 尺寸/张数在入队时就归一化（F-016）：任务参数快照与真正执行时一致
    let (width, height, count) = normalize_generation(input.width, input.height, input.count);
    let job = NewJob {
        provider_id: provider.id,
        provider_name: &provider.name,
        model: input.model.trim(),
        prompt,
        negative_prompt: input.negative_prompt.as_deref().unwrap_or(""),
        style: &input.style,
        width: width as i64,
        height: height as i64,
        guidance: input.guidance.map(|g| g as f64),
        steps: input.steps.map(|s| s as i64),
        seed: input.seed.map(|s| s as i64),
        count: count as i64,
        input_json: &input_json,
    };
    let id = storage::insert_job(&job)?;
    storage::set_job_key(id, &format!("queue:{id}"))?;
    let row = storage::get_job(id)?.ok_or_else(|| "任务写入后读取失败".to_string())?;
    let _ = app.emit("queue:job", &row);
    let _ = app.emit("queue:counts", counts_json());
    state.wake();
    Ok(row)
}

#[tauri::command]
pub async fn list_jobs(state: tauri::State<'_, SharedQueue>) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "jobs": storage::list_jobs()?,
        "counts": counts_json(),
        "paused": state.is_paused(),
        "concurrency": concurrency_limit(),
        "providerConcurrency": provider_concurrency_limit(),
    }))
}

/// 取消任务：queued 立即置 canceled；running 只置取消标记，由 worker 收尾。
#[tauri::command]
pub async fn cancel_queue_job(app: tauri::AppHandle, id: i64) -> Result<(), String> {
    let Some(job) = storage::get_job(id)? else {
        return Ok(());
    };
    match job.status.as_str() {
        "queued" => {
            if !storage::cancel_queued_job(id)? {
                tracing::warn!("取消队列任务 #{id} 失败：状态已变化");
            }
        }
        "running" => {
            let registry = app.state::<GenerationRegistry>();
            if !registry.cancel(&job.job_key) {
                tracing::warn!("取消运行中任务 #{id} 失败：取消标记已过期");
            }
        }
        _ => {}
    }
    emit_job(&app, id);
    Ok(())
}

/// 失败/取消/中断的任务重新入队。
/// 结果未确认（可能已计费）的任务必须 `force=true` 才允许重发。
#[tauri::command]
pub async fn retry_queue_job(
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedQueue>,
    id: i64,
    force: Option<bool>,
) -> Result<(), String> {
    let force = force.unwrap_or(false);
    if !force {
        if let Some(job) = storage::get_job(id)? {
            if matches!(job.billing_state.as_str(), "unknown" | "billed_unrecovered") {
                return Err(
                    "该任务上次结果未确认（可能已计费）。请先在「请求记录」核对服务商后台，\
                     确认没有出图后再强制重试"
                        .to_string(),
                );
            }
        }
    }
    if storage::requeue_job(id, force)? {
        emit_job(&app, id);
        state.wake();
    }
    Ok(())
}

/// 用户显式恢复全部中断任务，并顺手启动队列（点击即视为同意继续计费）
#[tauri::command]
pub async fn requeue_interrupted_jobs(
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedQueue>,
) -> Result<usize, String> {
    let count = storage::requeue_interrupted_jobs().map_err(|e| e.to_string())?;
    let _ = app.emit("queue:counts", counts_json());
    state.paused.store(false, Ordering::SeqCst);
    state.wake();
    Ok(count)
}

/// 开始队列（启动后默认暂停，必须显式调用一次）
#[tauri::command]
pub async fn resume_queue(
    state: tauri::State<'_, SharedQueue>,
) -> Result<serde_json::Value, String> {
    state.paused.store(false, Ordering::SeqCst);
    state.wake();
    Ok(serde_json::json!({ "paused": false }))
}

#[tauri::command]
pub async fn clear_finished_jobs(app: tauri::AppHandle) -> Result<usize, String> {
    let removed = storage::clear_finished_jobs()?;
    let _ = app.emit("queue:counts", counts_json());
    Ok(removed)
}

/// 参考图落盘到 appData/refs/，返回路径；入队时只传路径，避免把 base64 写进数据库。
#[tauri::command]
pub async fn save_reference_image(
    app: tauri::AppHandle,
    data_url: String,
) -> Result<String, String> {
    let name = image_store::unique_name("ref_", &storage::timestamp_millis(), 0);
    image_store::save_ref_image(&app, &data_url, &name).map_err(|e| e.to_string())
}

/// 读取 refs/ 下的参考图为 data URL（队列缩略图）；只允许 refs 目录内的路径。
#[tauri::command]
pub async fn read_reference_image(app: tauri::AppHandle, path: String) -> Result<String, String> {
    image_store::read_ref_image(&app, &path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reference::ReferenceRole;

    /// 计数快照必须始终包含全部状态（即使数量为 0）
    #[test]
    fn counts_payload_covers_all_statuses() {
        let counts = counts_json();
        for status in ALL_STATUSES {
            assert!(counts.get(status).is_some(), "计数快照缺少状态 {status}");
        }
    }

    /// 并发上限：非法/缺省回退 1，越界夹到 1–4
    #[test]
    fn concurrency_limit_parses_and_clamps() {
        assert_eq!(concurrency_limit_from(None), 1);
        assert_eq!(concurrency_limit_from(Some("")), 1);
        assert_eq!(concurrency_limit_from(Some("abc")), 1);
        assert_eq!(concurrency_limit_from(Some("0")), 1);
        assert_eq!(concurrency_limit_from(Some("-3")), 1);
        assert_eq!(concurrency_limit_from(Some("2")), 2);
        assert_eq!(concurrency_limit_from(Some(" 4 ")), 4);
        assert_eq!(concurrency_limit_from(Some("99")), 4);
    }

    /// 参考图路径：去空、保序、截断到 4 张
    #[test]
    fn reference_paths_are_trimmed_and_capped() {
        let paths = vec![
            " a.png ".to_string(),
            "".to_string(),
            "b.png".to_string(),
            "c.png".to_string(),
            "d.png".to_string(),
            "e.png".to_string(),
        ];
        assert_eq!(
            normalize_reference_paths(paths),
            vec!["a.png", "b.png", "c.png", "d.png"]
        );
    }

    /// 每服务商并发：非法/缺省回退 1，越界夹到 1–2
    #[test]
    fn provider_concurrency_parses_and_clamps() {
        assert_eq!(provider_concurrency_from(None), 1);
        assert_eq!(provider_concurrency_from(Some("")), 1);
        assert_eq!(provider_concurrency_from(Some("x")), 1);
        assert_eq!(provider_concurrency_from(Some("0")), 1);
        assert_eq!(provider_concurrency_from(Some("2")), 2);
        assert_eq!(provider_concurrency_from(Some(" 3 ")), 2);
    }

    /// 429 识别：只有 quota_exceeded 才算限流，并透出 Retry-After
    #[test]
    fn quota_retry_after_parses_adapter_error_json() {
        let with_hint = r#"{"type":"quota_exceeded","message":"x","retry_after":12}"#;
        assert_eq!(quota_retry_after(with_hint), Some(Some(12)));
        let without_hint = r#"{"type":"quota_exceeded","message":"x"}"#;
        assert_eq!(quota_retry_after(without_hint), Some(None));
        let other = r#"{"type":"network","message":"x"}"#;
        assert_eq!(quota_retry_after(other), None);
        assert_eq!(quota_retry_after("{not json"), None);
    }

    /// 扩展参数：空串按默认值，合法 JSON 往返，非法 JSON 不 panic
    #[test]
    fn job_extras_parse() {
        assert_eq!(JobExtras::parse(""), JobExtras::default());
        let extras = JobExtras {
            reference_paths: vec!["r.png".into()],
            references: vec![ReferenceSpec {
                role: ReferenceRole::Style,
                strength: Some(80),
            }],
            quality: Some("high".into()),
            quota_retries: 1,
        };
        let json = serde_json::to_string(&extras).unwrap();
        assert_eq!(JobExtras::parse(&json), extras);
        assert_eq!(JobExtras::parse("{not json"), JobExtras::default());
    }
}
