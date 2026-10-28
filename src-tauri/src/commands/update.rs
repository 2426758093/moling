use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// 同一时刻只允许一次下载安装：重复点击会重复下载整包
static INSTALLING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    pub version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current_version: String,
    /// 更新源是否已配置；未配置时不发请求也不报错
    pub configured: bool,
    pub available: Option<AvailableUpdate>,
    pub error: Option<String>,
}

/// 端点写死在编译期配置里：空数组 = 尚未接入更新源
fn endpoints_configured(app: &AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("endpoints"))
        .and_then(|v| v.as_array())
        .is_some_and(|list| !list.is_empty())
}

/// 清单里的原始发布日期字符串；解析后的 OffsetDateTime 要额外引入 time 依赖，这里不取
fn date_of(raw: &serde_json::Value) -> Option<String> {
    raw.get("pub_date")
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

#[tauri::command]
pub async fn get_update_status(app: AppHandle) -> Result<UpdateStatus, String> {
    let current_version = app.package_info().version.to_string();
    if !endpoints_configured(&app) {
        return Ok(UpdateStatus {
            current_version,
            configured: false,
            available: None,
            error: None,
        });
    }
    let updater = app
        .updater()
        .map_err(|e| format!("初始化更新器失败: {e}"))?;
    match updater.check().await {
        Ok(Some(update)) => Ok(UpdateStatus {
            current_version,
            configured: true,
            available: Some(AvailableUpdate {
                version: update.version.clone(),
                notes: update.body.clone(),
                date: date_of(&update.raw_json),
            }),
            error: None,
        }),
        Ok(None) => Ok(UpdateStatus {
            current_version,
            configured: true,
            available: None,
            error: None,
        }),
        // 检查失败（离线、更新源不可达）不是致命错误：前端要显示原因但保留重试入口
        Err(e) => Ok(UpdateStatus {
            current_version,
            configured: true,
            available: None,
            error: Some(e.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    if !endpoints_configured(&app) {
        return Err("尚未配置更新源".to_string());
    }
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("正在安装更新，请稍候".to_string());
    }
    // 失败必须复位，否则本次进程内再也无法重试
    let result = download_and_install(&app).await;
    INSTALLING.store(false, Ordering::SeqCst);
    result?;
    // Windows 上安装器启动后进程会被终止，通常到不了这里；
    // 其它平台需要主动重启才能运行新版本
    app.restart();
}

async fn download_and_install(app: &AppHandle) -> Result<(), String> {
    let updater = app
        .updater()
        .map_err(|e| format!("初始化更新器失败: {e}"))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("检查更新失败: {e}"))?
        .ok_or_else(|| "当前已是最新版本".to_string())?;

    let handle = app.clone();
    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            move |chunk_len, total| {
                downloaded += chunk_len as u64;
                let _ = handle.emit(
                    "update:progress",
                    serde_json::json!({ "downloaded": downloaded, "total": total }),
                );
            },
            || {},
        )
        .await
        .map_err(|e| {
            // 签名校验失败也会走这里：错误信息原样透出，便于用户判断是网络还是包被篡改
            tracing::warn!("安装更新失败: {e}");
            format!("安装更新失败: {e}")
        })
}
