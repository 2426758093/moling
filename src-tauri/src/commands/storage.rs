use crate::error::{AppError, AppResult};
use crate::image_gc;
use crate::paths;
use crate::storage;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub from: String,
    pub to: String,
    pub files_copied: u64,
    pub bytes_copied: u64,
    pub paths_rewritten: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirStat {
    pub files: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStats {
    pub media_root: String,
    pub data_dir: String,
    pub images: DirStat,
    pub thumbs: DirStat,
    pub refs: DirStat,
    pub trash: DirStat,
    pub database: DirStat,
}

#[tauri::command]
pub async fn get_media_root(app: tauri::AppHandle) -> Result<String, String> {
    paths::media_root(&app)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

/// 迁移媒体根：复制 → 单事务改写数据库 → 写引导文件 → 归档旧目录。
/// 任一步失败保持原状；迁移期间由 `media_gate` 拦住新的图片落盘，
/// 队列运行中拒绝执行（正在写入的图片会漏拷）。
#[tauri::command]
pub async fn set_media_root(
    app: tauri::AppHandle,
    path: String,
) -> Result<MigrationReport, String> {
    tauri::async_runtime::spawn_blocking(move || migrate_media_root(&app, Path::new(&path)))
        .await
        .map_err(|e| format!("迁移媒体目录失败: {e}"))?
        .map_err(|e| e.to_string())
}

/// 旧目录归档名：`images` → `images.migrating-<毫秒时间戳>`。
///
/// 迁移后不再 `remove_dir_all`：改名是原子操作，万一数据库/引导文件回滚，
/// 旧图还在；延迟清理交给 `image_gc`（F-004）。
fn archive_dir_for(old_root: &Path, sub: &str, stamp: &str) -> PathBuf {
    old_root.join(format!("{sub}.migrating-{stamp}"))
}

fn migrate_media_root(app: &tauri::AppHandle, target: &Path) -> AppResult<MigrationReport> {
    let old_root = paths::media_root(app)?;
    validate_target(&old_root, target).map_err(AppError::Other)?;
    if storage::has_running_jobs()? {
        return Err(AppError::Other(
            "队列有任务正在运行，请等待完成后再更改媒体目录".into(),
        ));
    }
    // 先置迁移标志并等待在途写盘结束：之后所有新落盘都会拿到可读错误，
    // 复制期间不会再有新图写进旧目录（F-004）。
    let _gate = crate::media_gate::MigrationGate::acquire(std::time::Duration::from_secs(60))?;
    std::fs::create_dir_all(target)?;
    let target_abs = friendly_path(&normalize_absolute(target)?);
    // 用真实路径再校验一次：符号链接 / `..` 不能绕过「目录互相包含」的限制
    let old_abs = std::fs::canonicalize(&old_root)
        .map(|p| friendly_path(&p))
        .unwrap_or_else(|_| old_root.clone());
    validate_target(&old_abs, &target_abs).map_err(AppError::Other)?;
    // 目标里已有 images/refs 时拒绝，避免覆盖别的墨灵数据或用户文件
    for sub in ["images", "refs"] {
        let dir = target_abs.join(sub);
        if dir.exists() {
            return Err(AppError::Other(format!(
                "目标目录中已存在 {}，请选择一个空目录",
                dir.display()
            )));
        }
    }

    let mut files_copied = 0u64;
    let mut bytes_copied = 0u64;
    let copy_result = (|| -> AppResult<()> {
        for sub in ["images", "refs"] {
            let (files, bytes) = copy_tree(&old_root.join(sub), &target_abs.join(sub))?;
            files_copied += files;
            bytes_copied += bytes;
        }
        Ok(())
    })();
    if let Err(e) = copy_result {
        cleanup_copied(&target_abs);
        return Err(e);
    }

    // 复制期间可能有新任务开跑：改写前再确认一次，失败则丢弃副本
    if storage::has_running_jobs()? {
        cleanup_copied(&target_abs);
        return Err(AppError::Other(
            "复制期间队列开始执行，已取消更改（原目录未动）".into(),
        ));
    }

    let paths_rewritten = match storage::rewrite_media_root(&old_root, &target_abs) {
        Ok(n) => n,
        Err(e) => {
            cleanup_copied(&target_abs);
            return Err(e);
        }
    };

    if let Err(e) = paths::set_media_root(app, &target_abs) {
        // 引导文件写失败：把数据库改回去，保持库与运行时指向一致
        match storage::rewrite_media_root(&target_abs, &old_root) {
            Ok(_) => {}
            Err(re) => tracing::error!("回滚数据库媒体路径失败（需人工检查）: {re}"),
        }
        cleanup_copied(&target_abs);
        return Err(e);
    }

    // 旧目录只改名归档，不立即删除：数据库/引导文件若被回滚还能找回；
    // 真正的清理由 image_gc 在保留期后做（F-004）。
    let stamp = storage::timestamp_millis();
    for sub in ["images", "refs"] {
        let dir = old_root.join(sub);
        if !dir.exists() {
            continue;
        }
        let archived = archive_dir_for(&old_root, sub, &stamp);
        if let Err(e) = std::fs::rename(&dir, &archived) {
            tracing::warn!(
                "归档旧媒体目录失败（不影响迁移，稍后由清理任务处理）{}: {e}",
                dir.display()
            );
        }
    }

    let report = MigrationReport {
        from: old_root.to_string_lossy().to_string(),
        to: target_abs.to_string_lossy().to_string(),
        files_copied,
        bytes_copied,
        paths_rewritten,
    };
    tracing::warn!("媒体目录迁移完成: {report:?}");
    Ok(report)
}

/// 目标合法性：绝对路径、非盘符根、不与旧根互相包含（复制会递归或互相覆盖）。
pub(crate) fn validate_target(old: &Path, target: &Path) -> Result<(), String> {
    if !target.is_absolute() {
        return Err("请选择绝对路径".into());
    }
    if is_filesystem_root(target) {
        return Err("不能直接使用磁盘根目录作为媒体目录".into());
    }
    let old_key = storage::normalize_path_key(&old.to_string_lossy())
        .trim_end_matches('\\')
        .to_string();
    let new_key = storage::normalize_path_key(&target.to_string_lossy())
        .trim_end_matches('\\')
        .to_string();
    if old_key.is_empty() || new_key.is_empty() {
        return Err("媒体目录路径为空".into());
    }
    if old_key == new_key {
        return Err("新目录与当前媒体目录相同".into());
    }
    if new_key.starts_with(&format!("{old_key}\\")) {
        return Err("新目录不能位于当前媒体目录内部".into());
    }
    if old_key.starts_with(&format!("{new_key}\\")) {
        return Err("新目录不能包含当前媒体目录".into());
    }
    Ok(())
}

fn is_filesystem_root(p: &Path) -> bool {
    p.components().count() <= 1
}

/// 绝对化并清理 `.`/`..`（目标已创建，canonicalize 可用）
fn normalize_absolute(p: &Path) -> AppResult<PathBuf> {
    std::fs::canonicalize(p).map_err(|e| AppError::Other(format!("解析目标目录失败: {e}")))
}

/// 去掉 Windows canonicalize 的 `\\?\` 前缀：写进引导文件与数据库的应为普通路径
fn friendly_path(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    p.to_path_buf()
}

/// 递归复制目录，返回（文件数, 字节数）
fn copy_tree(from: &Path, to: &Path) -> AppResult<(u64, u64)> {
    if !from.is_dir() {
        return Ok((0, 0));
    }
    std::fs::create_dir_all(to)?;
    let mut files = 0u64;
    let mut bytes = 0u64;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = to.join(entry.file_name());
        if file_type.is_dir() {
            let (f, b) = copy_tree(&entry.path(), &target)?;
            files += f;
            bytes += b;
        } else if file_type.is_file() {
            bytes += std::fs::copy(entry.path(), &target)?;
            files += 1;
        }
    }
    Ok((files, bytes))
}

fn cleanup_copied(target: &Path) {
    for sub in ["images", "refs"] {
        let dir = target.join(sub);
        if let Err(e) = std::fs::remove_dir_all(&dir) {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!("清理迁移副本失败 {}: {e}", dir.display());
            }
        }
    }
}

#[tauri::command]
pub async fn storage_stats(app: tauri::AppHandle) -> Result<StorageStats, String> {
    tauri::async_runtime::spawn_blocking(move || collect_stats(&app))
        .await
        .map_err(|e| format!("统计存储占用失败: {e}"))?
        .map_err(|e| e.to_string())
}

/// 步骤链：从当前记录上溯到根，返回 root→current 有序列表（最多 32 跳）。
/// 与 `list_derived` 一样声明为 `async`：同步命令会占住 IPC 线程做 SQLite 查询。
#[tauri::command]
pub async fn history_lineage(history_id: i64) -> Result<Vec<storage::HistoryRow>, String> {
    storage::history_lineage(history_id).map_err(|e| e.to_string())
}

fn collect_stats(app: &tauri::AppHandle) -> AppResult<StorageStats> {
    let media_root = paths::media_root(app)?;
    let data_dir = paths::ensure_data_dir(app)?;
    let images = media_root.join("images");
    let refs = media_root.join("refs");

    let mut trash = dir_stat_flat(&images.join(".trash"));
    let ref_trash = dir_stat_flat(&refs.join(".trash"));
    trash.files += ref_trash.files;
    trash.bytes += ref_trash.bytes;

    Ok(StorageStats {
        media_root: media_root.to_string_lossy().to_string(),
        data_dir: data_dir.to_string_lossy().to_string(),
        images: dir_stat_flat(&images),
        thumbs: dir_stat_flat(&images.join(".thumb")),
        refs: dir_stat_flat(&refs),
        trash,
        database: file_stat(&data_dir.join("moling.db")),
    })
}

fn dir_stat_flat(dir: &Path) -> DirStat {
    let mut out = DirStat::default();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_file() {
            out.files += 1;
            out.bytes += meta.len();
        }
    }
    out
}

fn file_stat(path: &Path) -> DirStat {
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => DirStat {
            files: 1,
            bytes: meta.len(),
        },
        _ => DirStat::default(),
    }
}

/// 立即清理缓存：与启动清理同一实现，保留天数默认取设置值。
#[tauri::command]
pub async fn clean_cache(
    app: tauri::AppHandle,
    days: Option<i64>,
) -> Result<image_gc::Stats, String> {
    let media_root = paths::media_root(&app).map_err(|e| e.to_string())?;
    let retention = days.unwrap_or_else(storage::cache_retention_days);
    tauri::async_runtime::spawn_blocking(move || image_gc::clean_cache(&media_root, retention))
        .await
        .map_err(|e| format!("清理缓存失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_target_rejects_roots_overlaps_and_same_path() {
        let old = Path::new(r"E:\data\media");
        assert!(validate_target(old, Path::new(r"E:\media2")).is_ok());
        assert!(
            validate_target(old, Path::new(r"E:\")).is_err(),
            "盘符根拒绝"
        );
        assert!(validate_target(old, old).is_err(), "相同路径拒绝");
        assert!(
            validate_target(old, Path::new(r"E:\data\media\sub")).is_err(),
            "新目录位于旧目录内部"
        );
        assert!(
            validate_target(old, Path::new(r"E:\data")).is_err(),
            "新目录包含旧目录"
        );
        assert!(
            validate_target(old, Path::new(r"relative\media")).is_err(),
            "相对路径拒绝"
        );
        // images2 不能被 images 前缀误判为子目录
        assert!(validate_target(old, Path::new(r"E:\data\media2")).is_ok());
    }

    /// 归档名固定为 `<子目录>.migrating-<时间戳>`，落在旧根下
    #[test]
    fn archive_dir_for_keeps_under_old_root() {
        let old = Path::new(r"E:\data\media");
        assert_eq!(
            archive_dir_for(old, "images", "1720000000000"),
            PathBuf::from(r"E:\data\media\images.migrating-1720000000000")
        );
        assert_eq!(
            archive_dir_for(old, "refs", "1"),
            PathBuf::from(r"E:\data\media\refs.migrating-1")
        );
        // 迁移后旧根可能只剩归档目录，GC 按前缀识别
        let name = archive_dir_for(old, "images", "9")
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert!(name.starts_with("images.migrating-"));
    }

    /// 递归复制保留子目录（.thumb/.trash），并返回真实文件数与字节数
    #[test]
    fn copy_tree_is_recursive_and_counted() {
        let base = std::env::temp_dir().join(format!(
            "moling_storage_copy_{}_{:04x}",
            std::process::id(),
            rand::random::<u16>()
        ));
        let from = base.join("from");
        std::fs::create_dir_all(from.join(".thumb")).unwrap();
        std::fs::create_dir_all(from.join(".trash")).unwrap();
        std::fs::write(from.join("a.png"), b"abc").unwrap();
        std::fs::write(from.join(".thumb").join("a.jpg"), b"de").unwrap();
        std::fs::write(from.join(".trash").join("old.png"), b"fghi").unwrap();

        let to = base.join("to");
        let (files, bytes) = copy_tree(&from, &to).expect("复制目录");
        assert_eq!(files, 3);
        assert_eq!(bytes, 9);
        assert!(to.join(".thumb").join("a.jpg").exists());
        assert!(to.join(".trash").join("old.png").exists());
        std::fs::remove_dir_all(&base).ok();
    }

    /// 源目录不存在时视为 0 个文件（首次使用还没有 images/refs）
    #[test]
    fn copy_tree_missing_source_is_empty() {
        let base = std::env::temp_dir().join(format!(
            "moling_storage_missing_{}_{:04x}",
            std::process::id(),
            rand::random::<u16>()
        ));
        let (files, bytes) = copy_tree(&base.join("nope"), &base.join("to")).expect("空复制");
        assert_eq!((files, bytes), (0, 0));
    }
}
