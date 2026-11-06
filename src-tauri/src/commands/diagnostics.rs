//! 诊断包导出：把「排查需要的最小信息」打成 zip。
//!
//! 白名单式打包：只写下面显式列出的条目，绝不打包图片目录、数据库文件、
//! API Key（明文或密文）、提示词与 promptTemplates / thinkingConfig。

use crate::error::{AppError, AppResult};
use crate::logging;
use crate::paths::ensure_data_dir;
use crate::storage;
use std::io::Write;
use std::path::Path;
use std::time::SystemTime;

/// 单个日志文件与整个日志部分的体积上限，避免诊断包变成几百 MB
const MAX_LOG_FILE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_LOGS_TOTAL_BYTES: u64 = 50 * 1024 * 1024;

#[tauri::command]
pub async fn get_logs_dir(app: tauri::AppHandle) -> Result<String, String> {
    let data_dir = ensure_data_dir(&app)?;
    Ok(logging::logs_dir(&data_dir).to_string_lossy().to_string())
}

#[tauri::command]
pub async fn export_diagnostics(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let data_dir = ensure_data_dir(&app).map_err(|e| e.to_string())?;
        let dir = data_dir.join("diagnostics");
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建诊断目录失败: {e}"))?;
        let out = dir.join(format!(
            "diag-{}.zip",
            storage::timestamp_millis().replace('.', "-")
        ));
        write_bundle(&out, &data_dir, &app.package_info().version.to_string())
            .map_err(|e| e.to_string())?;
        tracing::warn!("诊断包已导出: {}", out.display());
        Ok(out.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("导出诊断包失败: {e}"))?
}

/// 打包内容与顺序固定，便于支持人员按文件名核对。
fn write_bundle(out: &Path, data_dir: &Path, app_version: &str) -> AppResult<()> {
    let now = SystemTime::now();
    let mut entries: Vec<(String, Vec<u8>)> = vec![
        ("meta.json".into(), pretty(&meta_json(app_version))?),
        ("providers.json".into(), pretty(&providers_json())?),
        ("settings.json".into(), pretty(&settings_json())?),
    ];
    let mut total = 0u64;
    for path in logging::recent_logs(&logging::logs_dir(data_dir), now) {
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        let Ok(meta) = path.metadata() else { continue };
        if meta.len() > MAX_LOG_FILE_BYTES || total + meta.len() > MAX_LOGS_TOTAL_BYTES {
            continue;
        }
        match std::fs::read(&path) {
            Ok(bytes) => {
                total += bytes.len() as u64;
                entries.push((format!("logs/{name}"), bytes));
            }
            // 日志被占用/正在滚动是常态，跳过不影响诊断包主体
            Err(e) => tracing::warn!("读取日志 {name} 失败，已跳过: {e}"),
        }
    }
    write_zip(out, &entries)
}

fn pretty(value: &serde_json::Value) -> AppResult<Vec<u8>> {
    serde_json::to_vec_pretty(value).map_err(|e| AppError::Other(e.to_string()))
}

fn meta_json(app_version: &str) -> serde_json::Value {
    serde_json::json!({
        "appVersion": app_version,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "schemaVersion": storage::schema_version(),
        "tables": storage::table_row_counts()
            .unwrap_or_default()
            .into_iter()
            .map(|(name, rows)| serde_json::json!({ "name": name, "rows": rows }))
            .collect::<Vec<_>>(),
        "logRetentionDays": logging::LOG_RETENTION_DAYS,
        "exportedAt": storage::timestamp_millis(),
    })
}

/// 只给服务商元信息与 Key 数量，绝不输出 Key 内容。
fn providers_json() -> serde_json::Value {
    let rows = storage::list_providers().unwrap_or_default();
    let list: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            let keys = storage::load_provider_keys(r.id).unwrap_or_default();
            serde_json::json!({
                "name": r.name,
                "baseUrl": r.base_url,
                "kind": r.kind,
                "defaultModel": r.default_model,
                "keyCount": keys.len(),
                "invalidKeyCount": keys.iter().filter(|k| k.invalid).count(),
            })
        })
        .collect();
    serde_json::json!({ "providers": list })
}

/// 明确排除 promptTemplates（含用户提示词）与 thinkingConfig（含密钥密文）；
/// 代理只保留非密钥字段。`mediaRoot` 是机器相关设置，不进备份，只在诊断包输出。
fn settings_json() -> serde_json::Value {
    let mut out = serde_json::Map::new();
    for key in [
        "theme",
        "glassAppearance",
        "uiMode",
        "queueConcurrency",
        "queueProviderConcurrency",
        "cacheRetentionDays",
        "defaultProviderId",
        "defaultParams",
    ] {
        if let Ok(Some(value)) = storage::get_setting(key) {
            out.insert(key.to_string(), serde_json::Value::String(value));
        }
    }
    if let Some(root) = crate::paths::current_media_root() {
        out.insert(
            "storage".into(),
            serde_json::json!({ "mediaRoot": root.to_string_lossy() }),
        );
    }
    let proxy = crate::adapters::http::stored_config();
    out.insert(
        "networkProxy".into(),
        serde_json::json!({
            "mode": proxy.mode,
            // 代理 URL 可能带 user:pass@ 或 ?key=，诊断包同样要脱敏
            "url": crate::redact::redact_secrets(&proxy.url),
            "noProxy": proxy.no_proxy,
        }),
    );
    serde_json::Value::Object(out)
}

/// D5：先写临时文件 → fsync → rename，避免半截 zip 覆盖掉上一次可用的诊断包
fn write_zip(out: &Path, entries: &[(String, Vec<u8>)]) -> AppResult<()> {
    let tmp = out.with_extension("zip.tmp");
    let result = (|| -> AppResult<()> {
        let file = std::fs::File::create(&tmp)?;
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, bytes) in entries {
            zip.start_file(name.as_str(), options)
                .map_err(|e| AppError::Other(format!("写入诊断包失败: {e}")))?;
            zip.write_all(bytes)?;
        }
        let file = zip
            .finish()
            .map_err(|e| AppError::Other(format!("完成诊断包失败: {e}")))?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, out)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("moling-diag-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("logs")).unwrap();
        dir
    }

    /// 诊断包只含白名单条目：不含图片/base64、不含 Key、不含数据库与过期日志
    #[test]
    fn diagnostics_zip_contains_only_whitelisted_entries() {
        let dir = temp_dir("zip");
        // 伪造日志与干扰文件：图片目录、数据库、过期日志都不该进包
        std::fs::write(dir.join("logs").join("moling.log"), b"warn something").unwrap();
        std::fs::write(dir.join("logs").join("moling.log.2000-01-01"), b"old").unwrap();
        std::fs::create_dir_all(dir.join("images")).unwrap();
        std::fs::write(dir.join("images").join("a.png"), b"PNGDATA").unwrap();
        std::fs::write(dir.join("moling.db"), b"SQLITE").unwrap();

        let out = dir.join("out.zip");
        write_bundle(&out, &dir, "0.5.0").expect("write bundle");

        let file = std::fs::File::open(&out).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut names: Vec<String> = Vec::new();
        for i in 0..archive.len() {
            let entry = archive.by_index(i).unwrap();
            names.push(entry.name().unwrap().to_string());
        }
        assert_eq!(names, vec!["meta.json", "providers.json", "settings.json"]);
        for forbidden in ["images/", "a.png", "moling.db", "moling.log"] {
            assert!(
                names.iter().all(|n| !n.contains(forbidden)),
                "诊断包不应包含 {forbidden}: {names:?}"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 设置快照必须排除提示词模板与思考模型配置（两者都可能含敏感信息）
    #[test]
    fn settings_snapshot_excludes_sensitive_keys() {
        let json = settings_json().to_string();
        assert!(!json.contains("promptTemplates"));
        assert!(!json.contains("thinkingConfig"));
        assert!(!json.contains("passwordEnc"));
        assert!(json.contains("networkProxy"));
    }

    /// 服务商快照只带数量，不带 Key 本身
    #[test]
    fn provider_snapshot_never_carries_keys() {
        let json = providers_json().to_string();
        for field in ["apiKey", "apiKeys", "apiKeyMasked", "api_key_enc"] {
            assert!(!json.contains(field), "服务商快照不应包含 {field}");
        }
    }
}
