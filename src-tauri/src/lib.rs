mod adapters;
mod background;
mod basic_edit;
mod commands;
mod error;
mod image_gc;
mod image_store;
mod key_pool;
mod logging;
mod media_gate;
mod paths;
mod redact;
mod reference;
mod storage;

use tauri::Manager;

/// 初始化 tracing：日志按天滚落到 data_dir/logs/moling.log.YYYY-MM-DD。
/// 级别由 `MOLING_LOG` 覆盖，缺省 `warn`（全局）+ `info`（本应用），
/// 默认不把请求体这类大字段写盘。
fn init_tracing(data_dir: &std::path::Path) {
    let logs = logging::logs_dir(data_dir);
    if let Err(e) = std::fs::create_dir_all(&logs) {
        eprintln!("创建日志目录失败: {e}");
    }
    let filter = std::env::var("MOLING_LOG").unwrap_or_else(|_| "warn,moling_lib=info".to_string());
    let file_appender = tracing_appender::rolling::daily(logs, "moling.log");
    let (writer, guard) = tracing_appender::non_blocking(file_appender);
    let subscriber = tracing_subscriber::fmt()
        .with_writer(writer)
        .with_env_filter(tracing_subscriber::EnvFilter::new(filter))
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
        // 媒体目录选择（设置页「更改位置」）
        .plugin(tauri_plugin_dialog::init())
        // 应用内自动更新：端点为空时不联网，不影响启动
        .plugin(tauri_plugin_updater::Builder::new().build())
        // RA-06：生成任务取消注册表（jobId → 取消标记），供 generate_images / cancel_generation 共享
        .manage(commands::GenerationRegistry::default())
        // 更新包缓存：下载 → 校验 → 安装分两步，安装阶段不再联网
        .manage(commands::UpdateCache::default())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("无法确定应用数据目录: {e}"))?;
            std::fs::create_dir_all(&data_dir).map_err(|e| format!("无法创建应用数据目录: {e}"))?;
            init_tracing(&data_dir);
            // 媒体根先于数据库初始化：图片落盘路径由它决定，数据库仍在 appData。
            // 引导文件损坏只回退默认目录，不影响启动。
            let media_root = paths::init_media_root(app.handle());
            init_storage_with_recovery(&data_dir)
                .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
            // 主密钥预热（F-013）：keyring IO 留在启动期，不落进持 DB 锁的保存路径
            storage::warm_master_key();
            // 代理需在首个生成请求前生效；配置损坏只落日志，不阻断启动
            adapters::http::init_from_storage();
            // 队列：上次残留的 running 一律标 interrupted（不自动重跑），
            // 且默认暂停，等用户点「开始队列」后才执行。
            match storage::mark_running_interrupted() {
                Ok(0) => {}
                Ok(n) => tracing::warn!("已将 {n} 个中断的队列任务标记为 interrupted"),
                Err(e) => tracing::warn!("标记中断队列任务失败: {e}"),
            }
            let queue_state = std::sync::Arc::new(commands::QueueState::default());
            app.manage(queue_state.clone());
            commands::spawn_worker(app.handle().clone(), queue_state);
            // 孤儿图片回收：后台执行，不阻塞首屏；内部自带失败兜底与两道安全哨兵，
            // 任何异常都只落日志，不影响启动。显式 drop 句柄 = 刻意 detach。
            let gc_root = media_root.clone();
            std::mem::drop(tauri::async_runtime::spawn_blocking(move || {
                image_gc::run(&gc_root)
            }));
            // 更新下载残留：超过 24h 的 .tmp/.pkg 清理掉，避免中断后占满缓存目录
            commands::cleanup_stale_downloads(app.handle());
            // 日志保留：只清理超过 7 天的滚动文件，跳过当天；失败仅落日志
            let logs = logging::logs_dir(&data_dir);
            std::mem::drop(tauri::async_runtime::spawn_blocking(move || {
                logging::prune(&logs, std::time::SystemTime::now());
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
            commands::get_model_caps,
            commands::set_model_caps,
            commands::save_model_caps_batch,
            commands::test_connection,
            commands::generate_images,
            commands::cancel_generation,
            commands::edit_image,
            commands::transform_image,
            commands::apply_edit,
            commands::import_image,
            commands::replace_background,
            commands::list_derived,
            commands::list_history,
            commands::get_history_image,
            commands::save_history_image,
            commands::export_history_zip,
            commands::write_text_file,
            commands::write_file_base64,
            commands::get_history_item,
            commands::set_favorite,
            commands::delete_history,
            commands::set_setting,
            commands::get_setting,
            commands::get_app_data_dir,
            commands::export_config,
            commands::import_config,
            commands::get_logs_dir,
            commands::export_diagnostics,
            commands::get_update_status,
            commands::download_update,
            commands::install_update,
            commands::enqueue_job,
            commands::list_jobs,
            commands::cancel_queue_job,
            commands::retry_queue_job,
            commands::resume_queue,
            commands::clear_finished_jobs,
            commands::save_reference_image,
            commands::read_reference_image,
            commands::get_thinking_config,
            commands::save_thinking_config,
            commands::test_thinking_connection,
            commands::refine_prompt,
            commands::cancel_refine,
            commands::translate_prompt,
            commands::generate_conversation_title,
            commands::optimize_prompt,
            commands::create_conversation,
            commands::list_conversations,
            commands::delete_conversation,
            commands::delete_message,
            commands::remove_message_image,
            commands::add_message,
            commands::list_messages,
            commands::save_chat_image,
            commands::get_prompt_templates,
            commands::save_prompt_templates,
            commands::reverse_prompt,
            commands::list_favorites,
            commands::upsert_favorite,
            commands::delete_favorite,
            commands::list_presets,
            commands::save_preset,
            commands::delete_preset,
            commands::get_media_root,
            commands::set_media_root,
            commands::storage_stats,
            commands::clean_cache,
            commands::list_canvas_boards,
            commands::create_canvas_board,
            commands::get_canvas_board,
            commands::save_canvas_board,
            commands::delete_canvas_board,
            commands::batch_history_thumbs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
