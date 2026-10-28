use crate::adapters::{self, AdapterError, EditRequest, GenerateRequest};
use crate::image_store::{self, SAFE_NAME_MAX_CHARS};
use crate::key_pool;
use crate::storage;
use std::sync::atomic::Ordering;

/// 取消标记类型：jobId → 是否已取消
pub type CancelToken = std::sync::Arc<std::sync::atomic::AtomicBool>;
type CancelMap = std::sync::Mutex<std::collections::HashMap<String, CancelToken>>;

/// 生成任务取消注册表（RA-06）。lib.rs 里以 `app.manage(GenerationRegistry::default())`
/// 注册为全局 state；generate_images 注册 token，cancel_generation 置位。
#[derive(Default)]
pub struct GenerationRegistry(
    pub  std::sync::Arc<
        std::sync::Mutex<
            std::collections::HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>,
        >,
    >,
);

/// Mutex 中毒时继续使用内部数据（取消标记不值得让 panic 级联）
fn lock_cancel_map(
    map: &CancelMap,
) -> std::sync::MutexGuard<'_, std::collections::HashMap<String, CancelToken>> {
    map.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl GenerationRegistry {
    /// 注册任务并返回取消标记（jobId 重复时覆盖为新标记）
    fn register(&self, job_id: &str) -> CancelToken {
        let token = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        lock_cancel_map(&self.0).insert(job_id.to_string(), token.clone());
        token
    }

    /// 置位取消标记；jobId 不存在时返回 false（幂等，静默忽略）
    pub(crate) fn cancel(&self, job_id: &str) -> bool {
        match lock_cancel_map(&self.0).get(job_id) {
            Some(token) => {
                token.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }
}

/// 取消登记守卫（RA-06）：generate_images 无论正常返回、提前 return 还是 `?` 出错，
/// 都会在 drop 时把自身 jobId 从注册表移除，避免 token 泄漏。
pub(crate) struct CancelRegistration {
    map: Option<std::sync::Arc<CancelMap>>,
    job_id: Option<String>,
}

impl CancelRegistration {
    /// 有 jobId 时注册 token；无 jobId 时不注册，返回 None（行为与旧版完全一致）
    pub(crate) fn new(
        registry: &GenerationRegistry,
        job_id: Option<&String>,
    ) -> (Self, Option<CancelToken>) {
        match job_id {
            Some(id) => {
                let token = registry.register(id);
                (
                    Self {
                        map: Some(registry.0.clone()),
                        job_id: Some(id.clone()),
                    },
                    Some(token),
                )
            }
            None => (
                Self {
                    map: None,
                    job_id: None,
                },
                None,
            ),
        }
    }
}

impl Drop for CancelRegistration {
    fn drop(&mut self) {
        if let (Some(map), Some(id)) = (&self.map, &self.job_id) {
            lock_cancel_map(map).remove(id);
        }
    }
}

/// 检查取消标记（无 jobId 时恒为 false）
fn is_cancelled(token: &Option<CancelToken>) -> bool {
    token
        .as_ref()
        .map(|t| t.load(Ordering::SeqCst))
        .unwrap_or(false)
}

/// RA-04：仅 Network/Timeout 这类瞬时错误重试一次。生成接口按次计费且非幂等，
/// QuotaExceeded/AuthInvalid/ContentBlocked/Other 重试既无意义又可能重复扣费。
fn is_retryable(err: &AdapterError) -> bool {
    matches!(
        err,
        AdapterError::Network { .. } | AdapterError::Timeout { .. }
    )
}

/// 参考图上限：前端三个入口（上传 / 拖拽 / 引用图）已统一限制，
/// 后端再截断一次，防止绕过 UI 的超大请求。
const MAX_REFERENCE_IMAGES: usize = 4;

/// 生成失败自动重试的最大尝试次数（仅 Network/Timeout 重试，其余错误不重试）
const GENERATE_MAX_ATTEMPTS: u32 = 2;
/// 重试退避时长（仅瞬时错误使用，避免抖动期间立刻重击服务商）
const GENERATE_RETRY_BACKOFF: std::time::Duration = std::time::Duration::from_millis(500);

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateCommandInput {
    pub provider_id: i64,
    pub prompt: String,
    pub negative_prompt: Option<String>,
    pub model: String,
    pub width: u32,
    pub height: u32,
    pub guidance: Option<f32>,
    pub steps: Option<u32>,
    pub seed: Option<u64>,
    pub style: String,
    pub count: u32,
    pub images: Option<Vec<String>>,
    /// RA-06：前端传入的生成任务 id（camelCase 为 jobId），用于取消；不传时行为不变
    #[serde(default)]
    pub job_id: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedImage {
    pub history_id: i64,
    pub data_url: String,
    pub file_path: String,
    pub prompt: String,
    pub model: String,
    pub seed: Option<i64>,
}

fn build_prompt(input: &GenerateCommandInput) -> String {
    if input.style.is_empty() {
        input.prompt.clone()
    } else {
        format!("{}, {}", input.prompt, input.style)
    }
}

#[tauri::command]
pub async fn generate_images(
    app: tauri::AppHandle,
    state: tauri::State<'_, GenerationRegistry>,
    input: GenerateCommandInput,
) -> Result<serde_json::Value, String> {
    // RA-06：注册取消 token（不传 jobId 时不注册，行为与旧版完全一致）；
    // _registration 守卫在函数退出（含出错提前返回）时自动移除 token。
    let (_registration, cancel_token) = CancelRegistration::new(&state, input.job_id.as_ref());
    let outcome = generate_core(&app, &input, cancel_token, |_, _| {}).await?;
    Ok(serde_json::json!({ "images": outcome.images, "cancelled": outcome.cancelled }))
}

/// 生成结果（聊天命令与队列 worker 共用）
pub(crate) struct GenerateOutcome {
    pub images: Vec<GeneratedImage>,
    pub cancelled: bool,
}

/// 生成 + 逐张落盘/入库的核心流程；取消 token 由调用方注册与回收。
/// `on_progress(done, total)` 在每张图落盘入库后调用一次（队列据此发进度事件）。
pub(crate) async fn generate_core<F>(
    app: &tauri::AppHandle,
    input: &GenerateCommandInput,
    cancel_token: Option<CancelToken>,
    mut on_progress: F,
) -> Result<GenerateOutcome, String>
where
    F: FnMut(usize, usize),
{
    let row =
        storage::get_provider(input.provider_id)?.ok_or_else(|| "服务商不存在".to_string())?;
    let candidates = key_pool::candidates(input.provider_id)?;
    if candidates.is_empty() {
        return Err("该服务商还没有配置 API Key".to_string());
    }

    let full_prompt = build_prompt(input);
    let req = GenerateRequest {
        prompt: full_prompt.clone(),
        negative_prompt: input.negative_prompt.clone(),
        model: input.model.clone(),
        width: input.width,
        height: input.height,
        guidance: input.guidance,
        steps: input.steps,
        seed: input.seed,
        count: input.count,
        images: {
            let mut refs: Vec<String> = input
                .images
                .clone()
                .unwrap_or_default()
                .iter()
                .map(|s| image_store::strip_data_url(s))
                .collect();
            if refs.len() > MAX_REFERENCE_IMAGES {
                tracing::warn!(
                    "参考图数量 {} 超过上限 {}，已截断",
                    refs.len(),
                    MAX_REFERENCE_IMAGES
                );
                refs.truncate(MAX_REFERENCE_IMAGES);
            }
            refs
        },
    };

    // 失败自动重试：仅 Network/Timeout 重试一次（RA-04）；
    // 401/403 视为该 Key 不可用，切到下一个 Key（生成请求被拒不会计费）
    let mut cancelled = false;
    let mut last_err: Option<AdapterError> = None;
    let mut images: Option<Vec<String>> = None;
    'keys: for candidate in &candidates {
        let config = &candidate.config;
        let adapter = match adapters::get_adapter(&config.kind) {
            Ok(a) => a,
            Err(e) => return Err(adapters::adapter_error_json(e)),
        };
        for attempt in 0..GENERATE_MAX_ATTEMPTS {
            // 每次生成请求发出前检查取消
            if is_cancelled(&cancel_token) {
                cancelled = true;
                break 'keys;
            }
            match adapter.generate(config, &req).await {
                Ok(imgs) => {
                    key_pool::note_success(input.provider_id, candidate.index);
                    images = Some(imgs);
                    break 'keys;
                }
                Err(e) if key_pool::is_auth(&e) => {
                    key_pool::note_auth_failure(input.provider_id, candidate.index, &e);
                    tracing::warn!(
                        "服务商「{}」第 {} 个 Key 鉴权失败，尝试下一个 Key",
                        row.name,
                        candidate.index + 1
                    );
                    last_err = Some(e);
                    break;
                }
                Err(e) => {
                    // RA-04：只有瞬时错误才重试；生成非幂等且计费，
                    // 配额/内容拦截/其他错误重试可能造成重复扣费，一律直接返回。
                    if attempt + 1 < GENERATE_MAX_ATTEMPTS && is_retryable(&e) {
                        tracing::warn!(
                            "generate_images 第 {} 次尝试失败，准备重试: {}",
                            attempt + 1,
                            e.message()
                        );
                        last_err = Some(e);
                        tokio::time::sleep(GENERATE_RETRY_BACKOFF).await;
                        // 退避期间可能已被取消，重试前再检查一次
                        if is_cancelled(&cancel_token) {
                            cancelled = true;
                            break 'keys;
                        }
                        continue;
                    }
                    return Err(adapters::adapter_error_json(e));
                }
            }
        }
    }

    let now = storage::timestamp_millis();
    let mut out = Vec::new();
    if let Some(images) = images {
        let total = images.len();
        for (i, b64) in images.iter().enumerate() {
            // 每张图落盘/入库前检查取消：已取消则立即跳出，返回已生成结果
            if is_cancelled(&cancel_token) {
                cancelled = true;
                break;
            }
            let name = image_store::unique_name("", &now, i);
            let (path, data_url) = image_store::save_b64_image(app, b64, &name)?;
            // 生成即建缩略图：画廊首屏只传缩略图，避免每页几十 MB 的原图 base64
            image_store::ensure_thumb(std::path::Path::new(&path));
            let seed_val = Some(input.seed.map(|s| s as i64).unwrap_or_else(rand::random));
            let id = storage::add_history(&storage::HistoryRow {
                id: 0,
                prompt: full_prompt.clone(),
                negative_prompt: input.negative_prompt.clone().unwrap_or_default(),
                model: input.model.clone(),
                provider_name: row.name.clone(),
                seed: seed_val,
                width: input.width as i64,
                height: input.height as i64,
                guidance: input.guidance.unwrap_or(0.0) as f64,
                steps: input.steps.unwrap_or(0) as i64,
                style: input.style.clone(),
                file_path: path.clone(),
                favorite: false,
                created_at: now.clone(),
            })?;
            out.push(GeneratedImage {
                history_id: id,
                data_url,
                file_path: path,
                prompt: full_prompt.clone(),
                model: input.model.clone(),
                seed: seed_val,
            });
            on_progress(out.len(), total);
        }
    } else if !cancelled {
        // 未取消却没有图片：只可能是所有 Key 均鉴权失败或重试耗尽
        return Err(adapters::adapter_error_json(
            last_err.expect("无图片且未取消必有错误"),
        ));
    }
    Ok(GenerateOutcome {
        images: out,
        cancelled,
    })
}

/// 取消进行中的生成任务（RA-06）：jobId 不存在时静默忽略（幂等）。
#[tauri::command]
pub fn cancel_generation(job_id: String, state: tauri::State<'_, GenerationRegistry>) {
    state.cancel(&job_id);
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditCommandInput {
    pub provider_id: i64,
    pub prompt: String,
    pub model: String,
    pub image_b64: String,
    pub mask_b64: Option<String>,
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
pub async fn edit_image(
    app: tauri::AppHandle,
    mut input: EditCommandInput,
) -> Result<serde_json::Value, String> {
    // 消除模式：空提示词替换为默认补全提示词
    let erase = input.prompt.trim().is_empty();
    if erase {
        input.prompt = "Remove the masked object completely and fill the area so it matches \
             the surrounding background naturally."
            .to_string();
    }
    let row =
        storage::get_provider(input.provider_id)?.ok_or_else(|| "服务商不存在".to_string())?;
    let candidates = key_pool::candidates(input.provider_id)?;
    if candidates.is_empty() {
        return Err("该服务商还没有配置 API Key".to_string());
    }
    let adapter_prompt = if erase && candidates[0].config.kind == adapters::KIND_MOCK {
        format!("[消除] {}", input.prompt)
    } else {
        input.prompt.clone()
    };
    let req = EditRequest {
        prompt: adapter_prompt,
        model: input.model.clone(),
        image_b64: image_store::strip_data_url(&input.image_b64),
        mask_b64: input.mask_b64.as_deref().map(image_store::strip_data_url),
        width: input.width,
        height: input.height,
    };
    // 编辑同样计费，鉴权失败不重发，只换下一个 Key
    let mut b64 = None;
    let mut last_err: Option<AdapterError> = None;
    for candidate in &candidates {
        let adapter =
            adapters::get_adapter(&candidate.config.kind).map_err(adapters::adapter_error_json)?;
        match adapter.edit(&candidate.config, &req).await {
            Ok(result) => {
                key_pool::note_success(input.provider_id, candidate.index);
                b64 = Some(result);
                break;
            }
            Err(e) if key_pool::is_auth(&e) => {
                key_pool::note_auth_failure(input.provider_id, candidate.index, &e);
                last_err = Some(e);
            }
            Err(e) => return Err(adapters::adapter_error_json(e)),
        }
    }
    let b64 = b64.ok_or_else(|| {
        adapters::adapter_error_json(last_err.expect("候选列表非空时必有结果或错误"))
    })?;
    let now = storage::timestamp_millis();
    // 统一命名：edit_ 前缀 + 纳秒 + 随机尾（旧版只到毫秒，同毫秒多张编辑会互相覆盖）
    let name = image_store::unique_name("edit_", &now, 0);
    let (path, data_url) = image_store::save_b64_image(&app, &b64, &name)?;
    image_store::ensure_thumb(std::path::Path::new(&path));
    let id = storage::add_history(&storage::HistoryRow {
        id: 0,
        prompt: input.prompt.clone(),
        negative_prompt: String::new(),
        model: input.model.clone(),
        provider_name: row.name.clone(),
        seed: None,
        width: input.width as i64,
        height: input.height as i64,
        guidance: 0.0,
        steps: 0,
        style: String::new(),
        file_path: path.clone(),
        favorite: false,
        created_at: now,
    })?;
    Ok(serde_json::json!({
        "historyId": id,
        "dataUrl": data_url,
        "filePath": path,
    }))
}

#[tauri::command]
pub async fn save_chat_image(
    app: tauri::AppHandle,
    data_url: String,
    name: Option<String>,
) -> Result<serde_json::Value, String> {
    let now = storage::timestamp_millis();
    let base: String = name
        .unwrap_or_else(|| "att".to_string())
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(SAFE_NAME_MAX_CHARS)
        .collect();
    let safe_name = image_store::unique_name(&format!("{base}_"), &now, 0);
    // RC-19：保留原始 data URL（不预先 strip），让 save_b64_image 能按
    // `data:image/svg+xml` 头识别 SVG，否则 SVG 会被魔数嗅探默认存成 png。
    let (path, _) = image_store::save_b64_image(&app, &data_url, &safe_name)?;
    Ok(serde_json::json!({ "path": path }))
}

/// 画廊列表：只返回缩略图 data URL（缺失时回退原图，覆盖 SVG / 回填未完成）。
/// 读路径不生成缩略图（避免列表请求触发批量写盘），缩略图由生成/编辑时创建，
/// 存量数据由启动时的后台回填补齐。
#[tauri::command]
pub async fn list_history(
    limit: Option<i64>,
    offset: Option<i64>,
    model: Option<String>,
    style: Option<String>,
) -> Result<serde_json::Value, String> {
    let rows = storage::list_history(
        limit.unwrap_or(200),
        offset.unwrap_or(0),
        &model.unwrap_or_default(),
        &style.unwrap_or_default(),
    )?;
    let mut items = Vec::new();
    for r in rows {
        let thumb = image_store::thumb_path_for(std::path::Path::new(&r.file_path));
        let thumb_url = image_store::path_to_data_url(&thumb.to_string_lossy())
            .or_else(|| image_store::path_to_data_url(&r.file_path))
            .unwrap_or_default();
        items.push(serde_json::json!({
            "history": r,
            "thumbUrl": thumb_url,
        }));
    }
    Ok(serde_json::json!({ "items": items }))
}

/// 按 id 取原图完整 data URL：下载 / 打包导出 / 大图查看用
#[tauri::command]
pub async fn get_history_image(id: i64) -> Result<serde_json::Value, String> {
    let path = storage::history_file_path(id)?
        .filter(|p| !p.is_empty())
        .ok_or_else(|| format!("画廊记录 #{id} 不存在或没有图片"))?;
    let data_url = image_store::path_to_data_url(&path)
        .ok_or_else(|| format!("原图文件不存在或无法读取: {path}"))?;
    Ok(serde_json::json!({
        "historyId": id,
        "dataUrl": data_url,
        "filePath": path,
    }))
}

#[tauri::command]
pub async fn set_favorite(id: i64, favorite: bool) -> Result<(), String> {
    storage::set_favorite(id, favorite)?;
    Ok(())
}

/// 删除画廊记录。仅当没有任何会话消息（或其它画廊记录）再引用该文件时
/// 才回收磁盘文件——生成的图会被 history 与 messages 同时引用，无条件删文件
/// 会让聊天记录里的图永久裂开。
#[tauri::command]
pub async fn delete_history(id: i64) -> Result<(), String> {
    let plan = storage::delete_history(id)?;
    let Some(path) = plan.file_path.filter(|p| !p.is_empty()) else {
        return Ok(());
    };
    if plan.still_referenced {
        tracing::warn!("删除画廊 #{id}：{path} 仍被会话引用，已保留文件");
        return Ok(());
    }
    // 数据库行已提交删除：文件回收失败只记日志，不回滚也不报错，
    // 否则界面会提示"删除失败"但记录其实已经没了；残留文件由启动扫描兜底。
    match std::fs::remove_file(&path) {
        Ok(()) => tracing::warn!("删除画廊 #{id}：已回收文件 {path}"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => tracing::warn!("删除画廊 #{id}：文件回收失败 {path}: {e}"),
    }
    image_store::remove_thumb(&path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RA-04：仅 Network/Timeout 可重试，配额/鉴权/内容拦截/其他一律不重试
    #[test]
    fn retry_whitelist_only_network_or_timeout() {
        let cases = [
            (
                AdapterError::Network {
                    message: "x".into(),
                },
                true,
            ),
            (
                AdapterError::Timeout {
                    message: "x".into(),
                },
                true,
            ),
            (
                AdapterError::QuotaExceeded {
                    message: "x".into(),
                },
                false,
            ),
            (
                AdapterError::AuthInvalid {
                    message: "x".into(),
                    status: 401,
                },
                false,
            ),
            (
                AdapterError::ContentBlocked {
                    message: "x".into(),
                },
                false,
            ),
            (
                AdapterError::Other {
                    message: "x".into(),
                },
                false,
            ),
        ];
        for (err, expected) in cases {
            assert_eq!(
                is_retryable(&err),
                expected,
                "错误分类判断不符: {}",
                err.message()
            );
        }
    }

    /// RA-06：注册 → 取消置位 → 未知 jobId 取消幂等 → 守卫结束时清理 token
    #[test]
    fn generation_registry_cancel_and_remove() {
        let registry = GenerationRegistry::default();
        let (guard, token) = CancelRegistration::new(&registry, Some(&"job-1".to_string()));
        let token = token.expect("有 jobId 时必须注册取消标记");
        assert!(!is_cancelled(&Some(token.clone())));
        assert!(registry.cancel("job-1"));
        assert!(is_cancelled(&Some(token)));
        assert!(!registry.cancel("missing"));
        drop(guard);
        assert!(!lock_cancel_map(&registry.0).contains_key("job-1"));
    }

    /// RA-06：无 jobId 时取消检查恒为 false（不传 jobId 的旧行为不变）
    #[test]
    fn cancel_check_without_job_id_is_always_false() {
        assert!(!is_cancelled(&None));
    }

    /// RA-06：守卫 drop（含出错提前返回路径）必须清理 token，避免泄漏
    #[test]
    fn cancel_registration_guard_removes_on_drop() {
        let registry = GenerationRegistry::default();
        let (guard, token) = CancelRegistration::new(&registry, Some(&"job-2".to_string()));
        assert!(token.is_some());
        assert!(lock_cancel_map(&registry.0).contains_key("job-2"));
        drop(guard);
        assert!(!lock_cancel_map(&registry.0).contains_key("job-2"));
    }
}
