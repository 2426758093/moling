use crate::error::{AppError, AppResult};
use std::path::PathBuf;
use tauri::Manager;

/// 解析并确保应用数据目录存在（图片、数据库、日志均落盘于此）
pub fn ensure_data_dir(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(format!("获取数据目录失败: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}
