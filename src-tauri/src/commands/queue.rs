//! 批量生成队列：单 worker 串行执行，状态机全部走带前置条件的 SQL 迁移。
//!
//! 设计要点：
//! - 启动时 `running → interrupted` 且默认暂停：重启后绝不自动重跑（避免重复扣费）。
//! - 取消 queued 立即置 canceled；取消 running 只置取消标记，由 worker 收尾。
//! - 结果只写 history（画廊可见），不生成聊天消息，避免两套状态互相打架。

use crate::commands::image::{
    generate_core, CancelRegistration, GenerateCommandInput, GenerationRegistry,
};
use crate::storage::{self, JobRow, NewJob};
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager};

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

    fn wake(&self) {
        self.notify.notify_one();
    }

    /// 等一次唤醒（paused 时阻塞在此，不消耗 CPU）
    async fn wait(&self) {
        self.notify.notified().await;
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

fn emit_job(app: &tauri::AppHandle, id: i64) {
    if let Ok(Some(job)) = storage::get_job(id) {
        let _ = app.emit("queue:job", job);
    }
    let _ = app.emit("queue:counts", counts_json());
}

/// 启动队列 worker（setup 中调用一次）。
pub fn spawn_worker(app: tauri::AppHandle, state: SharedQueue) {
    tauri::async_runtime::spawn(async move {
        loop {
            if state.is_paused() {
                state.wait().await;
                continue;
            }
            let job = match storage::next_queued_job() {
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
            if let Err(e) = run_job(&app, &job).await {
                tracing::warn!("队列任务 #{} 收尾失败: {e}", job.id);
            }
        }
    });
}

/// 执行单个任务：queued → running → 终态。返回 Err 仅表示数据库收尾失败。
async fn run_job(app: &tauri::AppHandle, job: &JobRow) -> Result<(), String> {
    if !storage::start_job(job.id)? {
        // 取到之后已被取消（或已被另一路取走），直接跳过
        emit_job(app, job.id);
        return Ok(());
    }
    emit_job(app, job.id);

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
        images: None,
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
    emit_job(app, job.id);
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 计数快照必须始终包含全部状态（即使数量为 0）
    #[test]
    fn counts_payload_covers_all_statuses() {
        let counts = counts_json();
        for status in ALL_STATUSES {
            assert!(counts.get(status).is_some(), "计数快照缺少状态 {status}");
        }
    }
}
