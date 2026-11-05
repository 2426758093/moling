//! 用户可见的「另存为」落盘：原图、打包 zip 与文本。
//!
//! WebView2 没有下载处理器，前端 anchor.download 点击后不会产生文件；
//! 因此所有导出统一走系统保存对话框拿到目标路径，再由 Rust 写盘。

use crate::storage;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZipEntryInput {
    pub history_id: i64,
    /// 前端算好的参数清单，原样写进 params.json
    #[serde(default)]
    pub params: serde_json::Value,
}

/// 目标路径的最后一道校验：空路径 / 纯空白直接拒绝，父目录不存在则创建。
fn prepare_dest(dest: &str) -> Result<PathBuf, String> {
    let trimmed = dest.trim();
    if trimmed.is_empty() {
        return Err("保存路径为空".into());
    }
    let path = PathBuf::from(trimmed);
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建保存目录失败: {e}"))?;
        }
    }
    Ok(path)
}

/// 只保留字母数字扩展名，避免把路径分隔符或怪字符写进 zip 条目
fn safe_ext(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let cleaned: String = e
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .take(8)
                .collect();
            cleaned.to_ascii_lowercase()
        })
        .filter(|e| !e.is_empty())
        .unwrap_or_else(|| "png".into())
}

fn history_source(id: i64) -> Result<String, String> {
    storage::history_file_path(id)?
        .filter(|p| !p.is_empty())
        .ok_or_else(|| format!("画廊记录 #{id} 不存在或没有图片"))
}

/// 保存一张原图；`params_text` 非空时在同目录写一份同名 .txt 参数清单。
#[tauri::command]
pub async fn save_history_image(
    id: i64,
    dest: String,
    params_text: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let src = history_source(id)?;
        let dest = prepare_dest(&dest)?;
        std::fs::copy(&src, &dest).map_err(|e| format!("保存图片失败: {e}"))?;
        if let Some(text) = params_text.filter(|t| !t.trim().is_empty()) {
            let sidecar = dest.with_extension("txt");
            std::fs::write(&sidecar, text).map_err(|e| format!("保存参数文件失败: {e}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("保存图片失败: {e}"))?
}

/// 打包导出：按传入顺序占位（001、002…），缺图条目跳过并计数。
#[tauri::command]
pub async fn export_history_zip(
    entries: Vec<ZipEntryInput>,
    dest: String,
) -> Result<serde_json::Value, String> {
    if entries.is_empty() {
        return Err("没有可导出的作品".into());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let dest = prepare_dest(&dest)?;
        let file = std::fs::File::create(&dest).map_err(|e| format!("创建压缩包失败: {e}"))?;
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let mut manifest = Vec::with_capacity(entries.len());
        let mut saved = 0usize;
        let mut skipped = 0usize;
        for (index, entry) in entries.iter().enumerate() {
            let path = match history_source(entry.history_id) {
                Ok(p) => p,
                Err(_) => {
                    skipped += 1;
                    continue;
                }
            };
            let bytes = match std::fs::read(&path) {
                Ok(b) => b,
                Err(e) => {
                    tracing::warn!("导出跳过 {}：{}", path, e);
                    skipped += 1;
                    continue;
                }
            };
            let name = format!(
                "{:03}_{}.{}",
                index + 1,
                entry.history_id,
                safe_ext(Path::new(&path))
            );
            zip.start_file(name.as_str(), options)
                .map_err(|e| format!("写入压缩包失败: {e}"))?;
            zip.write_all(&bytes)
                .map_err(|e| format!("写入压缩包失败: {e}"))?;
            manifest.push(serde_json::json!({
                "file": name,
                "params": entry.params,
            }));
            saved += 1;
        }
        let manifest_bytes =
            serde_json::to_vec_pretty(&manifest).map_err(|e| format!("生成参数清单失败: {e}"))?;
        zip.start_file("params.json", options)
            .map_err(|e| format!("写入参数清单失败: {e}"))?;
        zip.write_all(&manifest_bytes)
            .map_err(|e| format!("写入参数清单失败: {e}"))?;
        zip.finish().map_err(|e| format!("完成压缩包失败: {e}"))?;
        Ok(serde_json::json!({ "saved": saved, "skipped": skipped }))
    })
    .await
    .map_err(|e| format!("打包导出失败: {e}"))?
}

/// 文本导出（备份 JSON、提示词收藏 / 预设）。
#[tauri::command]
pub async fn write_text_file(dest: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let dest = prepare_dest(&dest)?;
        std::fs::write(&dest, content).map_err(|e| format!("写入文件失败: {e}"))
    })
    .await
    .map_err(|e| format!("写入文件失败: {e}"))?
}

/// 二进制导出：前端把 Blob 读成 base64 后交给 Rust 写盘。
#[tauri::command]
pub async fn write_file_base64(dest: String, data: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|e| format!("文件内容解码失败: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let dest = prepare_dest(&dest)?;
        std::fs::write(&dest, bytes).map_err(|e| format!("写入文件失败: {e}"))
    })
    .await
    .map_err(|e| format!("写入文件失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_ext_keeps_known_suffixes() {
        assert_eq!(safe_ext(Path::new("a/b/c.PNG")), "png");
        assert_eq!(safe_ext(Path::new("noext")), "png");
        assert_eq!(safe_ext(Path::new("weird.t!x?t")), "txt");
    }

    #[test]
    fn empty_dest_is_rejected() {
        assert!(prepare_dest("   ").is_err());
        assert!(prepare_dest("").is_err());
    }
}
