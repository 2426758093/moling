mod adapters;
mod commands;
mod error;
mod image_store;
mod paths;
mod storage;

use tauri::Manager;

/// 初始化 tracing：落盘 data_dir/moling.log，默认仅记录 WARN/ERROR（失败/密钥/重试等关键节点）
fn init_tracing(data_dir: &std::path::Path) {
    let file_appender = tracing_appender::rolling::never(data_dir, "moling.log");
    let (writer, guard) = tracing_appender::non_blocking(file_appender);
    let subscriber = tracing_subscriber::fmt()
        .with_writer(writer)
        .with_env_filter(tracing_subscriber::EnvFilter::new("warn"))
        .finish();
    let _ = tracing::subscriber::set_global_default(subscriber);
    // 非阻塞 writer 的 guard 需在进程生命周期内存活；此处有意泄漏
    std::mem::forget(guard);
}

/// 初始化存储；数据库损坏时备份为 moling.db.bak-<ts> 后重建空库继续启动（R3）
fn init_storage_with_recovery(data_dir: &std::path::Path) -> Result<(), String> {
    match storage::init(data_dir.to_path_buf()) {
        Ok(()) => Ok(()),
        Err(e) => {
            tracing::error!("数据库初始化失败（{e}），尝试备份损坏的数据库后重建空库");
            let db = data_dir.join("moling.db");
            let bak = data_dir.join(format!(
                "moling.db.bak-{}",
                storage::timestamp_millis().replace('.', "-")
            ));
            std::fs::rename(&db, &bak).map_err(|re| {
                tracing::error!("备份损坏数据库失败: {re}");
                format!("数据库初始化失败且无法备份损坏文件: {re}")
            })?;
            tracing::error!("已将损坏数据库备份为 {}", bak.display());
            Ok(storage::init(data_dir.to_path_buf())?)
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&data_dir).expect("failed to create app data dir");
            init_tracing(&data_dir);
            init_storage_with_recovery(&data_dir)
                .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::save_provider,
            commands::list_providers,
            commands::delete_provider,
            commands::pull_models,
            commands::test_models,
            commands::test_connection,
            commands::generate_images,
            commands::edit_image,
            commands::list_history,
            commands::set_favorite,
            commands::delete_history,
            commands::set_setting,
            commands::get_setting,
            commands::get_app_data_dir,
            commands::export_config,
            commands::import_config,
            commands::get_thinking_config,
            commands::save_thinking_config,
            commands::test_thinking_connection,
            commands::refine_prompt,
            commands::create_conversation,
            commands::list_conversations,
            commands::delete_conversation,
            commands::add_message,
            commands::list_messages,
            commands::save_chat_image,
            commands::get_prompt_templates,
            commands::save_prompt_templates,
            commands::reverse_prompt,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
