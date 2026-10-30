//! 批量生成队列：固定 4 个 worker 槽位共享一条排队队列，状态机全部走带前置条件的 SQL 迁移。
//!
//! 设计要点：
//! - 启动时 `running → interrupted` 且默认暂停：重启后绝不自动重跑（避免重复扣费）。
//! - 领取任务用单条 UPDATE 原地完成「选最早 + 抢占 + 并发上限判断」，同一任务不会被领两次。
//! - 并发上限来自设置 `queueConcurrency`（1–4，默认 1），每次领取时读取，改设置立即生效。
//! - 取消 queued 立即置 canceled；取消 running 只置取消标记，由 worker 收尾。
//! - 结果只写 history（画廊可见），不生成聊天消息，避免两套状态互相打架。

use crate::commands::image::{
    generate_core, CancelRegistration, GenerateCommandInput, GenerationRegistry,
    MAX_REFERENCE_IMAGES,
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
    loop {
        if state.is_paused() {
            state.wait().await;
            continue;
        }
        let job = match storage::claim_next_job(concurrency_limit()) {
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
        }
        emit_job(&app, job.id);
        // 空出一个名额：唤醒其它槽位重新尝试领取
        state.wake();
    }
}

/// 入队时存进 `jobs.input_json` 的扩展参数（列里没有的字段）
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct JobExtras {
    pub reference_paths: Vec<String>,
    pub references: Vec<ReferenceSpec>,
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

/// 执行单个任务：领取时已是 running，这里只负责跑到终态。返回 Err 仅表示数据库收尾失败。
async fn run_job(app: &tauri::AppHandle, job: &JobRow) -> Result<(), String> {
    let extras = JobExtras::parse(&job.input_json);
    let mut images: Vec<String> = Vec::with_capacity(extras.reference_paths.len());
    for path in &extras.reference_paths {
        match image_store::read_ref_image(app, path) {
            Ok(url) => images.push(url),
            Err(e) => {
                storage::finish_job(
                    job.id,
                    "failed",
                    "[]",
                    Some(&format!("参考图读取失败: {e}")),
                )?;
                return Ok(());
            }
        }
    }

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
            Some(extras.references)
        },
        job_id: None,
    };

    let (registration, token) = {
        let registry = app.state::<GenerationRegistry>();
        CancelRegistration::new(&registry, Some(&job.job_key))
    };

    let progress_app = app.clone();
    let progress_id = job.id;
    let result = generate_core(app, &input, token, move |done, total| {
        let _ = progress_app.emit(
            "queue:progress",
            serde_json::json!({ "id": progress_id, "done": done, "total": total }),
        );
    })
    .await;
    drop(registration);

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
            storage::finish_job(job.id, status, &images_json, None)?;
        }
        Err(e) => {
            storage::finish_job(job.id, "failed", "[]", Some(&e))?;
        }
    }
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
    // 入队即固化参数快照，之后改默认参数不影响已排队任务
    let reference_paths = normalize_reference_paths(input.reference_paths);
    let extras = JobExtras {
        references: input
            .references
            .into_iter()
            .take(reference_paths.len())
            .collect(),
        reference_paths,
    };
    let input_json = serde_json::to_string(&extras).map_err(|e| e.to_string())?;
    let job = NewJob {
        provider_id: provider.id,
        provider_name: &provider.name,
        model: input.model.trim(),
        prompt,
        negative_prompt: input.negative_prompt.as_deref().unwrap_or(""),
        style: &input.style,
        width: input.width as i64,
        height: input.height as i64,
        guidance: input.guidance.map(|g| g as f64),
        steps: input.steps.map(|s| s as i64),
        seed: input.seed.map(|s| s as i64),
        count: input.count.clamp(1, 4) as i64,
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

/// 失败/取消/中断的任务重新入队
#[tauri::command]
pub async fn retry_queue_job(
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedQueue>,
    id: i64,
) -> Result<(), String> {
    if storage::requeue_job(id)? {
        emit_job(&app, id);
        state.wake();
    }
    Ok(())
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
        };
        let json = serde_json::to_string(&extras).unwrap();
        assert_eq!(JobExtras::parse(&json), extras);
        assert_eq!(JobExtras::parse("{not json"), JobExtras::default());
    }
}
