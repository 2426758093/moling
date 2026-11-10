//! 请求记录与「不重新生成」的恢复入口。
//!
//! 恢复只做三件事：读本地缓存的图片本体、重解析已落盘的原始响应、重新下载产物 URL。
//! 任何路径都不会再次调用生成接口，因此不会产生新的计费。

use crate::billing_journal::{self, ImageRequestRow};
use crate::image_store;
use crate::storage;
use base64::Engine;

/// 只有这三种状态需要人工处理：可能已计费但没有（完整）产物。
const RECOVERABLE: [&str; 3] = [
    billing_journal::STATE_UNKNOWN,
    billing_journal::STATE_BILLED_UNRECOVERED,
    billing_journal::STATE_PARTIAL,
];

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverOutcome {
    pub recovered: usize,
    pub failed: usize,
}

#[tauri::command]
pub async fn list_image_requests(
    pending_only: Option<bool>,
) -> Result<Vec<ImageRequestRow>, String> {
    let rows = if pending_only.unwrap_or(false) {
        billing_journal::list_pending()
    } else {
        billing_journal::list_recent(200)
    };
    rows.map_err(|e| e.to_string())
}

/// 待恢复产物的来源：已缓存的 base64 / 响应体里的 base64 / 图片 URL。
enum Candidate {
    B64(String),
    Url(String),
}

fn push_artifact_candidates(artifacts_json: &str, out: &mut Vec<Candidate>) {
    let Ok(items) = serde_json::from_str::<Vec<String>>(artifacts_json) else {
        return;
    };
    for item in items {
        if item.starts_with("http://") || item.starts_with("https://") {
            out.push(Candidate::Url(item));
        } else if item.ends_with(".b64") {
            if let Ok(text) = std::fs::read_to_string(&item) {
                if !text.trim().is_empty() {
                    out.push(Candidate::B64(text));
                }
            }
        }
    }
}

fn push_raw_candidates(raw_path: &str, out: &mut Vec<Candidate>) {
    let Ok(bytes) = std::fs::read(raw_path) else {
        return;
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return;
    };
    let Some(data) = value.get("data").and_then(|d| d.as_array()) else {
        return;
    };
    for entry in data {
        if let Some(b64) = entry.get("b64_json").and_then(|v| v.as_str()) {
            out.push(Candidate::B64(b64.to_string()));
        } else if let Some(url) = entry.get("url").and_then(|v| v.as_str()) {
            out.push(Candidate::Url(url.to_string()));
        }
    }
}

/// 同一次尝试写入的 `{client_request_id}-N.b64` 缓存
fn push_stashed_candidates(client_request_id: &str, out: &mut Vec<Candidate>) {
    let Some(dir) = billing_journal::requests_dir() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with(client_request_id) || !name.ends_with(".b64") {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(entry.path()) {
            if !text.trim().is_empty() {
                out.push(Candidate::B64(text));
            }
        }
    }
}

async fn resolve(candidate: Candidate) -> Option<String> {
    match candidate {
        Candidate::B64(text) => {
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| image_store::strip_data_url(trimmed))
        }
        Candidate::Url(url) => {
            let timeout = std::time::Duration::from_secs(60);
            // 产物可能是 GIF 动图，恢复下载按动图上限放行
            match crate::adapters::download_image_bytes(
                &url,
                timeout,
                crate::adapters::MAX_REMOTE_GIF_BYTES,
            )
            .await
            {
                Ok(bytes) => Some(base64::engine::general_purpose::STANDARD.encode(&bytes)),
                Err(e) => {
                    tracing::warn!("恢复下载失败（不重新生成）: {} -> {}", url, e.message());
                    None
                }
            }
        }
    }
}

/// 尝试恢复一条请求产物：只读本地缓存 / 重解析 raw / 重新下载，绝不重新生成。
#[tauri::command]
pub async fn recover_image_request(
    app: tauri::AppHandle,
    id: i64,
) -> Result<RecoverOutcome, String> {
    let row = billing_journal::get(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "请求记录不存在".to_string())?;
    recover_row(&app, &row).await
}

/// 聊天消息里只带 `client_request_id`：按它定位请求记录再恢复。
#[tauri::command]
pub async fn recover_image_request_by_client(
    app: tauri::AppHandle,
    client_request_id: String,
) -> Result<RecoverOutcome, String> {
    let row = billing_journal::get_by_client_request(&client_request_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "未找到对应的请求记录".to_string())?;
    recover_row(&app, &row).await
}

async fn recover_row(
    app: &tauri::AppHandle,
    row: &ImageRequestRow,
) -> Result<RecoverOutcome, String> {
    if !RECOVERABLE.contains(&row.state.as_str()) {
        return Err("该请求已是终态，无需恢复".to_string());
    }
    let mut candidates: Vec<Candidate> = Vec::new();
    push_artifact_candidates(&row.artifacts_json, &mut candidates);
    if !row.raw_path.is_empty() {
        push_raw_candidates(&row.raw_path, &mut candidates);
    }
    push_stashed_candidates(&row.client_request_id, &mut candidates);
    if candidates.is_empty() {
        return Err("没有可恢复的产物：服务商未返回图片地址，也没有本地缓存".to_string());
    }

    let now = storage::timestamp_millis();
    let mut recovered = 0usize;
    let mut failed = 0usize;
    for (index, candidate) in candidates.into_iter().enumerate() {
        let Some(b64) = resolve(candidate).await else {
            failed += 1;
            continue;
        };
        let name = image_store::unique_name("recover_", &now, index);
        let (path, _) = match image_store::save_b64_image_with_retry(app, &b64, &name) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("恢复图片落盘失败: {e}");
                failed += 1;
                continue;
            }
        };
        let (w, h) = decoded_size(&b64);
        if let Err(e) = storage::add_history(&storage::HistoryRow {
            id: 0,
            prompt: row.prompt.clone(),
            negative_prompt: String::new(),
            model: row.model.clone(),
            provider_name: row.provider_name.clone(),
            seed: None,
            width: if w == 0 { 0 } else { w as i64 },
            height: if h == 0 { 0 } else { h as i64 },
            guidance: 0.0,
            steps: 0,
            style: String::new(),
            file_path: path,
            favorite: false,
            created_at: now.clone(),
            parent_id: None,
            op: if row.op.is_empty() {
                "generate".into()
            } else {
                row.op.clone()
            },
        }) {
            tracing::warn!("恢复图片入库失败: {e}");
            failed += 1;
            continue;
        }
        recovered += 1;
    }

    if recovered == 0 {
        return Err(format!("恢复失败：{failed} 个产物都无法取回"));
    }
    let state = if failed == 0 {
        billing_journal::STATE_RECOVERED
    } else {
        billing_journal::STATE_PARTIAL
    };
    billing_journal::mark_state(row.id, state).map_err(|e| e.to_string())?;
    if failed == 0 && !row.raw_path.is_empty() {
        let _ = std::fs::remove_file(&row.raw_path);
    }
    Ok(RecoverOutcome { recovered, failed })
}

/// 用户确认「后台没有出图」：标记为已放弃，之后不再提示。
#[tauri::command]
pub async fn abandon_image_request(id: i64) -> Result<(), String> {
    billing_journal::mark_state(id, billing_journal::STATE_ABANDONED).map_err(|e| e.to_string())
}

/// raw 响应体所在目录（恢复失败时可让用户手动查看/留存）
#[tauri::command]
pub async fn get_requests_dir() -> Result<String, String> {
    billing_journal::requests_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "请求缓存目录尚未初始化".to_string())
}

/// 只读图片尺寸；解码失败返回 0（与 image.rs 同语义）
fn decoded_size(b64: &str) -> (u32, u32) {
    let raw = image_store::strip_data_url(b64);
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(raw) else {
        return (0, 0);
    };
    match image_store::decode_limited(&bytes) {
        Ok(img) => (img.width(), img.height()),
        Err(_) => (0, 0),
    }
}
