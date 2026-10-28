mod adapters;
mod commands;
mod error;
mod image_gc;
mod image_store;
mod key_pool;
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

/// 初始化存储。
///
/// 只有**数据库文件确实损坏**（SQLite 报 NOTADB / CORRUPT）才备份重建空库：
/// 改名重建会丢掉用户的会话与服务商配置，像磁盘满、文件被占用、迁移失败这类
/// 错误必须原样上抛，让用户看到启动失败，而不是悄悄换成空库。
fn init_storage_with_recovery(data_dir: &std::path::Path) -> Result<(), String> {
    match storage::init(data_dir.to_path_buf()) {
        Ok(()) => Ok(()),
        Err(e) if storage::is_corruption(&e) => {
            tracing::error!("数据库文件已损坏（{e}），备份原文件后重建空库");
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
        Err(e) => {
            // 非损坏类错误：不触碰数据，直接把原因带回启动流程
            tracing::error!("数据库初始化失败（{e}），未做任何数据改动");
            Err(format!("数据库初始化失败: {e}"))
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // RA-06：生成任务取消注册表（jobId → 取消标记），供 generate_images / cancel_generation 共享
        .manage(commands::GenerationRegistry::default())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&data_dir).expect("failed to create app data dir");
            init_tracing(&data_dir);
            init_storage_with_recovery(&data_dir)
                .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
            // 代理需在首个生成请求前生效；配置损坏只落日志，不阻断启动
            adapters::http::init_from_storage();
            // 孤儿图片回收：后台执行，不阻塞首屏；内部自带失败兜底与两道安全哨兵，
            // 任何异常都只落日志，不影响启动。显式 drop 句柄 = 刻意 detach。
            std::mem::drop(tauri::async_runtime::spawn_blocking(move || {
                image_gc::run(&data_dir)
            }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_proxy_config,
            commands::save_proxy_config,
            commands::test_proxy,
            commands::save_provider,
            commands::list_providers,
            commands::list_provider_keys,
            commands::add_provider_key,
            commands::delete_provider_key,
            commands::reset_provider_key,
            commands::delete_provider,
            commands::pull_models,
            commands::test_models,
            commands::test_connection,
            commands::generate_images,
            commands::cancel_generation,
            commands::edit_image,
            commands::list_history,
            commands::get_history_image,
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
            commands::delete_message,
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
