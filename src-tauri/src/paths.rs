use crate::error::{AppError, AppResult};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};
use tauri::Manager;

/// 媒体根引导文件名（位于 app_config_dir，不随媒体搬走）
const STORAGE_CONFIG_FILE: &str = "moling-storage.json";

/// 媒体根（images / refs）。数据库与日志始终留在 appData：数据库位置一旦可配，
/// 「读配置需要数据库、数据库位置写在配置里」会形成启动死锁。
static MEDIA_ROOT: OnceLock<RwLock<PathBuf>> = OnceLock::new();

fn media_root_cell() -> &'static RwLock<PathBuf> {
    MEDIA_ROOT.get_or_init(|| RwLock::new(PathBuf::new()))
}

fn read_cell() -> PathBuf {
    media_root_cell()
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

fn write_cell(path: PathBuf) {
    *media_root_cell().write().unwrap_or_else(|e| e.into_inner()) = path;
}

/// 解析并确保应用数据目录存在（数据库、日志、诊断包均落盘于此）
pub fn ensure_data_dir(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(format!("获取数据目录失败: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn storage_config_path(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Other(format!("获取配置目录失败: {e}")))?;
    Ok(dir.join(STORAGE_CONFIG_FILE))
}

/// 读取引导文件解析媒体根；缺失、损坏或内容非法一律回退到默认数据目录。
///
/// 这是启动路径，**绝不能**因为一个手改坏的 JSON 让应用起不来；最坏情况是
/// 图片回到旧目录（用户可在设置里重新指定）。
pub(crate) fn resolve_media_root(config_path: &Path, fallback: &Path) -> PathBuf {
    let Ok(raw) = std::fs::read_to_string(config_path) else {
        return fallback.to_path_buf();
    };
    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("媒体目录配置损坏，回退到默认目录: {e}");
            return fallback.to_path_buf();
        }
    };
    let root = parsed
        .get("root")
        .and_then(|r| r.as_str())
        .map(str::trim)
        .filter(|r| !r.is_empty());
    match root {
        Some(r) => PathBuf::from(r),
        None => {
            tracing::warn!("媒体目录配置缺少 root，回退到默认目录");
            fallback.to_path_buf()
        }
    }
}

/// 原子写入：同目录临时文件 → fsync → rename。进程中断或 rename 失败都不会
/// 破坏原文件，也不会留下写了一半的内容。
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut tmp_name = path.as_os_str().to_os_string();
    tmp_name.push(".tmp");
    let tmp = PathBuf::from(tmp_name);
    let result = (|| -> AppResult<()> {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// 原子写入引导文件：先写临时文件再改名，进程中断不会留下半截 JSON。
pub(crate) fn write_storage_config(path: &Path, root: &Path) -> AppResult<()> {
    let body = serde_json::json!({ "version": 1, "root": root.to_string_lossy() });
    let bytes = serde_json::to_vec_pretty(&body)
        .map_err(|e| AppError::Other(format!("序列化媒体目录配置失败: {e}")))?;
    atomic_write(path, &bytes)
}

/// 启动时初始化媒体根，返回解析结果供图片回收使用。
pub fn init_media_root(app: &tauri::AppHandle) -> PathBuf {
    let fallback = match ensure_data_dir(app) {
        Ok(dir) => dir,
        Err(e) => {
            tracing::error!("解析应用数据目录失败，媒体目录使用当前目录: {e}");
            PathBuf::from(".")
        }
    };
    let root = match storage_config_path(app) {
        Ok(config) => resolve_media_root(&config, &fallback),
        Err(e) => {
            tracing::warn!("解析媒体目录配置路径失败，使用默认目录: {e}");
            fallback.clone()
        }
    };
    if let Err(e) = std::fs::create_dir_all(&root) {
        tracing::error!(
            "创建媒体目录失败（{}），回退到默认目录: {e}",
            root.display()
        );
        let _ = std::fs::create_dir_all(&fallback);
        write_cell(fallback.clone());
        return fallback;
    }
    if root != fallback {
        tracing::info!("媒体目录: {}", root.display());
    }
    write_cell(root.clone());
    root
}

/// 当前媒体根（不存在时创建）。未初始化返回错误，避免图片误落到相对路径。
pub fn media_root(_app: &tauri::AppHandle) -> AppResult<PathBuf> {
    let root = read_cell();
    if root.as_os_str().is_empty() {
        return Err(AppError::Other("媒体目录尚未初始化".into()));
    }
    std::fs::create_dir_all(&root)?;
    Ok(root)
}

/// 当前媒体根（诊断包用；未初始化返回 None）
pub fn current_media_root() -> Option<PathBuf> {
    let root = read_cell();
    (!root.as_os_str().is_empty()).then_some(root)
}

/// 切换媒体根：先写引导文件（失败则完全不动），再更新内存。
pub fn set_media_root(app: &tauri::AppHandle, root: &Path) -> AppResult<()> {
    let config = storage_config_path(app)?;
    std::fs::create_dir_all(root)?;
    write_storage_config(&config, root)?;
    write_cell(root.to_path_buf());
    tracing::warn!("媒体目录已切换为: {}", root.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "moling_paths_{tag}_{}_{:04x}",
            std::process::id(),
            rand::random::<u16>()
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    /// 缺失 / 损坏 / 缺 root 都回退默认，合法配置才生效
    #[test]
    fn resolve_falls_back_on_missing_or_broken_config() {
        let dir = temp_dir("resolve");
        let cfg = dir.join(STORAGE_CONFIG_FILE);
        let fallback = dir.join("default");
        assert_eq!(resolve_media_root(&cfg, &fallback), fallback);

        std::fs::write(&cfg, b"{not json").unwrap();
        assert_eq!(resolve_media_root(&cfg, &fallback), fallback);

        std::fs::write(&cfg, br#"{"version":1,"root":"  "}"#).unwrap();
        assert_eq!(resolve_media_root(&cfg, &fallback), fallback);

        let target = dir.join("media");
        std::fs::write(
            &cfg,
            serde_json::json!({ "version": 1, "root": target.to_string_lossy() }).to_string(),
        )
        .unwrap();
        assert_eq!(resolve_media_root(&cfg, &fallback), target);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 写入后可被解析回同一路径，且不残留临时文件
    #[test]
    fn write_config_roundtrips_atomically() {
        let dir = temp_dir("write");
        let cfg = dir.join("nested").join(STORAGE_CONFIG_FILE);
        let root = dir.join("media");
        write_storage_config(&cfg, &root).expect("写入配置");
        assert_eq!(resolve_media_root(&cfg, &dir), root);
        assert!(!cfg.with_extension("json.tmp").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// rename 失败时原文件保持完整，临时文件被清理
    #[test]
    fn atomic_write_keeps_target_when_rename_fails() {
        let dir = temp_dir("atomic_fail");
        let target = dir.join("cfg.json");
        std::fs::write(&target, b"original").unwrap();
        // 目标变成目录后 rename 必然失败
        std::fs::remove_file(&target).unwrap();
        std::fs::create_dir(&target).unwrap();

        let err = atomic_write(&target, b"new");
        assert!(err.is_err(), "复制到目录应失败");
        assert!(target.is_dir());
        let mut tmp = target.as_os_str().to_os_string();
        tmp.push(".tmp");
        assert!(!PathBuf::from(tmp).exists(), "失败后不应残留临时文件");
        std::fs::remove_dir_all(&dir).ok();
    }
}
