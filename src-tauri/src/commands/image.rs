use crate::adapters::{self, AdapterError, EditRequest, GenerateRequest, TransformRequest};
use crate::image_store::{self, SAFE_NAME_MAX_CHARS};
use crate::key_pool;
use crate::storage;
use std::sync::atomic::Ordering;
use tauri::Emitter;

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
pub(crate) const MAX_REFERENCE_IMAGES: usize = 4;

/// 换背景合成时的蒙版羽化半径（像素）：1–2px 让边缘不出现硬锯齿
const BACKGROUND_FEATHER: u32 = 2;

/// 生成失败自动重试的最大尝试次数（仅 Network/Timeout 重试，其余错误不重试）
const GENERATE_MAX_ATTEMPTS: u32 = 2;
/// 重试退避时长（仅瞬时错误使用，避免抖动期间立刻重击服务商）
const GENERATE_RETRY_BACKOFF: std::time::Duration = std::time::Duration::from_millis(500);

/// 尺寸区间与吸附步长（F-016）：上限对齐前端 appStore 的 SIZE_MAX（4096，也是画布
/// 输出上限），下限放宽到 64 以兼容 outpaint 的窄边与被编辑的小图；8 的倍数与服务商
/// 常见的对齐要求一致。原值来自 IPC，必须在这里钳制而不是只信前端。
const SIZE_MIN: u32 = 64;
const SIZE_MAX: u32 = 4096;
const SIZE_STEP: u32 = 8;
/// 单次生成张数上限：与前端张数滑杆、队列 enqueue 的旧 clamp(1,4) 同口径
const COUNT_MAX: u32 = 4;

/// 先夹到区间再吸附到 8 的倍数：顺序不能反，否则 4090 吸附成 4096 后仍合法，
/// 但 4097 若先吸附会变成 4104 再被夹回 4096，结果不一致。
pub(crate) fn normalize_size(n: u32) -> u32 {
    let clamped = n.clamp(SIZE_MIN, SIZE_MAX);
    let snapped = (clamped + SIZE_STEP / 2) / SIZE_STEP * SIZE_STEP;
    snapped.clamp(SIZE_MIN, SIZE_MAX)
}

pub(crate) fn normalize_count(n: u32) -> u32 {
    n.clamp(1, COUNT_MAX)
}

/// 质量档位白名单：auto/未知值一律视为「不发送」，防止任意字符串透传给服务商。
pub(crate) fn normalize_quality(q: Option<&str>) -> Option<String> {
    match q.map(str::trim) {
        Some("low") => Some("low".into()),
        Some("medium") => Some("medium".into()),
        Some("high") => Some("high".into()),
        _ => None,
    }
}

/// 生成参数统一归一化：命令层、队列入队与核心流程都走这里，保证「入库的值」
/// 与「真正发给服务商的值」永远一致（F-016）。
/// 宽高同时为 0 是「自动尺寸」哨兵：保留 0，由适配器决定是否发送 size。
pub(crate) fn normalize_generation(width: u32, height: u32, count: u32) -> (u32, u32, u32) {
    if width == 0 && height == 0 {
        return (0, 0, normalize_count(count));
    }
    (
        normalize_size(width),
        normalize_size(height),
        normalize_count(count),
    )
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateCommandInput {
    pub provider_id: i64,
    pub prompt: String,
    pub negative_prompt: Option<String>,
    pub model: String,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub quality: Option<String>,
    pub guidance: Option<f32>,
    pub steps: Option<u32>,
    pub seed: Option<u64>,
    pub style: String,
    pub count: u32,
    pub images: Option<Vec<String>>,
    /// 与 `images` 按位置对应的角色 / 强度（专家模式才有值）
    #[serde(default)]
    pub references: Option<Vec<crate::reference::ReferenceSpec>>,
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

fn build_prompt(
    input: &GenerateCommandInput,
    references: &[crate::reference::ReferenceSpec],
) -> String {
    let base = if input.style.is_empty() {
        input.prompt.clone()
    } else {
        format!("{}, {}", input.prompt, input.style)
    };
    crate::reference::append_reference_guidance(&base, references)
}

/// 聊天内逐张进度的载荷；队列路径不带 jobId，返回 None（避免与 queue:progress 重复）
fn progress_payload(
    job_id: Option<&str>,
    done: usize,
    total: usize,
    requested: u32,
) -> Option<serde_json::Value> {
    let job_id = job_id?;
    Some(serde_json::json!({
        "jobId": job_id,
        "done": done,
        // total 与 done 同源（服务商实际返回张数），保证 i/n 自洽
        "total": total,
        "requested": requested,
    }))
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
    let progress_app = app.clone();
    let job_id = input.job_id.clone();
    let requested = normalize_count(input.count);
    let outcome = generate_core(&app, &input, cancel_token, move |done, total| {
        // 事件发不出去（窗口已关）不影响生成
        if let Some(payload) = progress_payload(job_id.as_deref(), done, total, requested) {
            let _ = progress_app.emit("image:progress", payload);
        }
    })
    .await?;
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

    // 尺寸/张数归一化（F-016）：请求、历史记录、进度事件都只用归一化后的值。
    let (width, height, count) = normalize_generation(input.width, input.height, input.count);
    if (width, height, count) != (input.width, input.height, input.count) {
        tracing::debug!(
            "生成参数已归一化：{}x{}x{} -> {width}x{height}x{count}",
            input.width,
            input.height,
            input.count
        );
    }

    let mut ref_images: Vec<String> = input
        .images
        .clone()
        .unwrap_or_default()
        .iter()
        .map(|s| image_store::strip_data_url(s))
        .collect();
    if ref_images.len() > MAX_REFERENCE_IMAGES {
        tracing::warn!(
            "参考图数量 {} 超过上限 {}，已截断",
            ref_images.len(),
            MAX_REFERENCE_IMAGES
        );
        ref_images.truncate(MAX_REFERENCE_IMAGES);
    }
    // 角色 / 强度与图片按位置对齐：多出的说明（图片被截断或前端多传）丢弃
    let specs = input.references.clone().unwrap_or_default();
    let references = &specs[..specs.len().min(ref_images.len())];

    let full_prompt = build_prompt(input, references);
    let req = GenerateRequest {
        prompt: full_prompt.clone(),
        negative_prompt: input.negative_prompt.clone(),
        model: input.model.clone(),
        width,
        height,
        quality: normalize_quality(input.quality.as_deref()),
        guidance: input.guidance,
        steps: input.steps,
        seed: input.seed,
        count,
        images: ref_images,
        references: references.to_vec(),
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
                width: width as i64,
                height: height as i64,
                guidance: input.guidance.unwrap_or(0.0) as f64,
                steps: input.steps.unwrap_or(0) as i64,
                style: input.style.clone(),
                file_path: path.clone(),
                favorite: false,
                created_at: now.clone(),
                parent_id: None,
                op: "generate".into(),
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
    pub negative_prompt: Option<String>,
    pub model: String,
    pub image_b64: String,
    pub mask_b64: Option<String>,
    pub width: u32,
    pub height: u32,
    /// edit | erase | outpaint（其它值一律按 edit 处理）
    #[serde(default)]
    pub op: Option<String>,
    /// 原图记录 id（血统）
    #[serde(default)]
    pub parent_id: Option<i64>,
}

/// 编辑来源只接受这三种；前端传了别的值也不让脏字符串进库。
fn normalize_edit_op(op: Option<&str>, erase: bool) -> &'static str {
    match op {
        Some("erase") => "erase",
        Some("outpaint") => "outpaint",
        Some("edit") => "edit",
        _ if erase => "erase",
        _ => "edit",
    }
}

/// 编辑类请求的公共执行段：Key 轮换 + 单次调用（编辑计费，鉴权失败不重发）。
async fn run_edit(provider_id: i64, req: &EditRequest) -> Result<String, String> {
    let candidates = key_pool::candidates(provider_id)?;
    if candidates.is_empty() {
        return Err("该服务商还没有配置 API Key".to_string());
    }
    let mut b64 = None;
    let mut last_err: Option<AdapterError> = None;
    for candidate in &candidates {
        let adapter =
            adapters::get_adapter(&candidate.config.kind).map_err(adapters::adapter_error_json)?;
        match adapter.edit(&candidate.config, req).await {
            Ok(result) => {
                key_pool::note_success(provider_id, candidate.index);
                b64 = Some(result);
                break;
            }
            Err(e) if key_pool::is_auth(&e) => {
                key_pool::note_auth_failure(provider_id, candidate.index, &e);
                last_err = Some(e);
            }
            Err(e) => return Err(adapters::adapter_error_json(e)),
        }
    }
    b64.ok_or_else(|| adapters::adapter_error_json(last_err.expect("候选列表非空时必有结果或错误")))
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
    // 尺寸归一化（F-016）：编辑同样走 IPC，不能只信前端
    input.width = normalize_size(input.width);
    input.height = normalize_size(input.height);
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
        negative_prompt: input.negative_prompt.clone(),
        model: input.model.clone(),
        image_b64: image_store::strip_data_url(&input.image_b64),
        mask_b64: input.mask_b64.as_deref().map(image_store::strip_data_url),
        width: input.width,
        height: input.height,
    };
    let b64 = run_edit(input.provider_id, &req).await?;
    let now = storage::timestamp_millis();
    let op = normalize_edit_op(input.op.as_deref(), erase);
    // 统一命名：edit_ 前缀 + 纳秒 + 随机尾（旧版只到毫秒，同毫秒多张编辑会互相覆盖）
    let name = image_store::unique_name("edit_", &now, 0);
    let (path, data_url) = image_store::save_b64_image(&app, &b64, &name)?;
    image_store::ensure_thumb(std::path::Path::new(&path));
    let id = storage::add_history(&storage::HistoryRow {
        id: 0,
        prompt: input.prompt.clone(),
        negative_prompt: input.negative_prompt.clone().unwrap_or_default(),
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
        parent_id: input.parent_id,
        op: op.to_string(),
    })?;
    Ok(serde_json::json!({
        "historyId": id,
        "dataUrl": data_url,
        "filePath": path,
        "op": op,
    }))
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformCommandInput {
    pub provider_id: i64,
    pub model: String,
    pub image_b64: String,
    /// 放大倍数 2 / 4；风格转换固定 1（不放大，只换风格）
    pub scale: u32,
    /// detail（细节增强）| faithful（忠实还原）
    pub mode: String,
    /// 风格描述；放大时为空
    #[serde(default)]
    pub prompt: String,
    /// 父图（画廊 / 聊天里的原图），用于血统与同族查询
    #[serde(default)]
    pub parent_id: Option<i64>,
}

/// 用 image crate 读结果图尺寸；解码失败退回 0（不阻断保存，列表按 0 显示）。
fn decoded_size(b64: &str) -> (u32, u32) {
    use base64::Engine;
    let raw = image_store::strip_data_url(b64);
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(raw) else {
        return (0, 0);
    };
    match image::load_from_memory(&bytes) {
        Ok(img) => (img.width(), img.height()),
        Err(_) => (0, 0),
    }
}

/// 高清放大 / 风格转换：走服务商 API（无原生超分端点时按指令化编辑），
/// 结果作为派生图入库并指向父记录；Key 轮换语义与生成 / 编辑一致。
#[tauri::command]
pub async fn transform_image(
    app: tauri::AppHandle,
    input: TransformCommandInput,
) -> Result<serde_json::Value, String> {
    let row =
        storage::get_provider(input.provider_id)?.ok_or_else(|| "服务商不存在".to_string())?;
    let candidates = key_pool::candidates(input.provider_id)?;
    if candidates.is_empty() {
        return Err("该服务商还没有配置 API Key".to_string());
    }
    let style = input.prompt.trim().to_string();
    let op = if style.is_empty() { "upscale" } else { "style" };
    let scale = input.scale.clamp(1, 4);
    let mode = if input.mode == "faithful" {
        "faithful"
    } else {
        "detail"
    };
    let req = TransformRequest {
        prompt: style.clone(),
        model: input.model.clone(),
        image_b64: image_store::strip_data_url(&input.image_b64),
        scale,
        mode: mode.to_string(),
    };
    let mut b64 = None;
    let mut last_err: Option<AdapterError> = None;
    for candidate in &candidates {
        let adapter =
            adapters::get_adapter(&candidate.config.kind).map_err(adapters::adapter_error_json)?;
        match adapter.transform(&candidate.config, &req).await {
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

    let parent = match input.parent_id {
        Some(pid) => storage::history_row(pid)?,
        None => None,
    };
    let now = storage::timestamp_millis();
    let prefix = if op == "style" { "style_" } else { "up_" };
    let name = image_store::unique_name(prefix, &now, 0);
    let (path, data_url) = image_store::save_b64_image(&app, &b64, &name)?;
    image_store::ensure_thumb(std::path::Path::new(&path));
    let (width, height) = decoded_size(&b64);
    let prompt = if op == "style" {
        style.clone()
    } else {
        parent
            .as_ref()
            .map(|p| p.prompt.clone())
            .filter(|p| !p.trim().is_empty())
            .unwrap_or_else(|| format!("高清放大 {scale}x"))
    };
    let id = storage::add_history(&storage::HistoryRow {
        id: 0,
        prompt,
        negative_prompt: parent
            .as_ref()
            .map(|p| p.negative_prompt.clone())
            .unwrap_or_default(),
        model: input.model.clone(),
        provider_name: row.name.clone(),
        seed: None,
        width: width as i64,
        height: height as i64,
        guidance: 0.0,
        steps: 0,
        style: parent.as_ref().map(|p| p.style.clone()).unwrap_or_default(),
        file_path: path.clone(),
        favorite: false,
        created_at: now,
        parent_id: input.parent_id,
        op: op.to_string(),
    })?;
    Ok(serde_json::json!({
        "historyId": id,
        "dataUrl": data_url,
        "filePath": path,
        "width": width,
        "height": height,
        "op": op,
        "parentId": input.parent_id,
    }))
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BasicEditCommandInput {
    pub image_b64: String,
    /// 父图（聊天 / 画廊里的原图），用于血统与「派生自」标注
    #[serde(default)]
    pub parent_id: Option<i64>,
    pub ops: Vec<crate::basic_edit::EditOp>,
}

/// 基础编辑：裁剪 / 旋转 / 翻转 / 调色全在本地完成，输出 PNG 并作为派生图入库。
/// 原图保留（父记录不动），前端确认后把结果追加到会话。
#[tauri::command]
pub async fn apply_edit(
    app: tauri::AppHandle,
    input: BasicEditCommandInput,
) -> Result<serde_json::Value, String> {
    use base64::Engine;
    if input.ops.is_empty() {
        return Err("没有需要应用的编辑".to_string());
    }
    let raw = image_store::strip_data_url(&input.image_b64);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw)
        .map_err(|e| format!("图片 base64 解码失败: {e}"))?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("图片解码失败: {e}"))?;
    let out = crate::basic_edit::apply_ops(img, &input.ops)?;
    let (width, height) = (out.width(), out.height());
    let mut cursor = std::io::Cursor::new(Vec::new());
    out.write_to(&mut cursor, image::ImageFormat::Png)
        .map_err(|e| format!("编辑结果编码失败: {e}"))?;
    let b64 = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(cursor.into_inner())
    );

    let parent = match input.parent_id {
        Some(pid) => storage::history_row(pid)?,
        None => None,
    };
    let now = storage::timestamp_millis();
    let name = image_store::unique_name("edit_", &now, 0);
    let (path, data_url) = image_store::save_b64_image(&app, &b64, &name)?;
    image_store::ensure_thumb(std::path::Path::new(&path));
    let prompt = parent
        .as_ref()
        .map(|p| p.prompt.clone())
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| "基础编辑".to_string());
    let id = storage::add_history(&storage::HistoryRow {
        id: 0,
        prompt,
        negative_prompt: parent
            .as_ref()
            .map(|p| p.negative_prompt.clone())
            .unwrap_or_default(),
        model: parent.as_ref().map(|p| p.model.clone()).unwrap_or_default(),
        provider_name: parent
            .as_ref()
            .map(|p| p.provider_name.clone())
            .unwrap_or_else(|| "本地编辑".to_string()),
        seed: None,
        width: width as i64,
        height: height as i64,
        guidance: 0.0,
        steps: 0,
        style: parent.as_ref().map(|p| p.style.clone()).unwrap_or_default(),
        file_path: path.clone(),
        favorite: false,
        created_at: now,
        parent_id: input.parent_id,
        op: "basic-edit".to_string(),
    })?;
    Ok(serde_json::json!({
        "historyId": id,
        "dataUrl": data_url,
        "filePath": path,
        "width": width,
        "height": height,
        "op": "basic-edit",
        "parentId": input.parent_id,
    }))
}

fn encode_png_data_url(img: &image::DynamicImage) -> Result<String, String> {
    use base64::Engine;
    let mut cursor = std::io::Cursor::new(Vec::new());
    img.write_to(&mut cursor, image::ImageFormat::Png)
        .map_err(|e| format!("图片编码失败: {e}"))?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(cursor.into_inner())
    ))
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceBackgroundInput {
    pub image_b64: String,
    /// 白色（luma）= 要替换的区域
    pub mask_b64: String,
    #[serde(default)]
    pub parent_id: Option<i64>,
    /// solid | gradient | ai
    pub kind: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub color_from: String,
    #[serde(default)]
    pub color_to: String,
    /// horizontal | vertical | diagonal
    #[serde(default)]
    pub direction: String,
    #[serde(default)]
    pub prompt: String,
    /// 仅 ai 需要
    #[serde(default)]
    pub provider_id: Option<i64>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub negative_prompt: Option<String>,
}

/// 换背景：纯色 / 渐变本地合成；AI 走服务商编辑接口（蒙版复用局部重绘链路）。
/// 结果统一入库为 op="background" 的派生图，原图保留。
#[tauri::command]
pub async fn replace_background(
    app: tauri::AppHandle,
    input: ReplaceBackgroundInput,
) -> Result<serde_json::Value, String> {
    use crate::background::{self, BackgroundFill};
    use base64::Engine;

    let base_raw = image_store::strip_data_url(&input.image_b64);
    let base_bytes = base64::engine::general_purpose::STANDARD
        .decode(&base_raw)
        .map_err(|e| format!("图片 base64 解码失败: {e}"))?;
    let base = image::load_from_memory(&base_bytes).map_err(|e| format!("图片解码失败: {e}"))?;
    let mask_raw = image_store::strip_data_url(&input.mask_b64);
    let mask_bytes = base64::engine::general_purpose::STANDARD
        .decode(&mask_raw)
        .map_err(|e| format!("蒙版 base64 解码失败: {e}"))?;
    let mask_img =
        image::load_from_memory(&mask_bytes).map_err(|e| format!("蒙版解码失败: {e}"))?;
    // 本地合成用「白 = 替换」口径；AI 路径沿用 inpainting 的透明孔口径
    let mask = mask_img.to_luma8();
    let painted = if input.kind == "ai" {
        background::alpha_has_region(&mask_img)
    } else {
        background::luma_has_region(&mask_img)
    };
    if !painted {
        return Err("请先涂抹要替换的背景区域".to_string());
    }
    let (base_w, base_h) = (base.width(), base.height());

    let (b64, provider_name, model, history_prompt) = match input.kind.as_str() {
        "solid" => {
            let color = background::parse_hex(&input.color)?;
            let out = background::composite(
                &base,
                &mask,
                &BackgroundFill::Solid(color),
                BACKGROUND_FEATHER,
            );
            (
                encode_png_data_url(&out)?,
                "本地合成".to_string(),
                String::new(),
                format!("换背景：纯色 {}", input.color.trim()),
            )
        }
        "gradient" => {
            let from = background::parse_hex(&input.color_from)?;
            let to = background::parse_hex(&input.color_to)?;
            let out = background::composite(
                &base,
                &mask,
                &BackgroundFill::Gradient {
                    from,
                    to,
                    direction: background::parse_direction(&input.direction),
                },
                BACKGROUND_FEATHER,
            );
            (
                encode_png_data_url(&out)?,
                "本地合成".to_string(),
                String::new(),
                format!(
                    "换背景：渐变 {} → {}",
                    input.color_from.trim(),
                    input.color_to.trim()
                ),
            )
        }
        "ai" => {
            let desc = input.prompt.trim().to_string();
            if desc.is_empty() {
                return Err("请输入背景描述".to_string());
            }
            let provider_id = input
                .provider_id
                .ok_or_else(|| "请先在「设置」中配置服务商".to_string())?;
            let model = input
                .model
                .clone()
                .filter(|m| !m.trim().is_empty())
                .ok_or_else(|| "请先在「设置」中选择默认模型".to_string())?;
            let row =
                storage::get_provider(provider_id)?.ok_or_else(|| "服务商不存在".to_string())?;
            let req = EditRequest {
                prompt: background::background_ai_prompt(&desc),
                negative_prompt: input.negative_prompt.clone(),
                model: model.clone(),
                image_b64: base_raw.to_string(),
                mask_b64: Some(mask_raw.to_string()),
                width: base_w,
                height: base_h,
            };
            let b64 = run_edit(provider_id, &req).await?;
            (b64, row.name.clone(), model, format!("换背景：{desc}"))
        }
        other => return Err(format!("未知的背景类型: {other}")),
    };

    let now = storage::timestamp_millis();
    let name = image_store::unique_name("bg_", &now, 0);
    let (path, data_url) = image_store::save_b64_image(&app, &b64, &name)?;
    image_store::ensure_thumb(std::path::Path::new(&path));
    let (width, height) = decoded_size(&b64);
    let id = storage::add_history(&storage::HistoryRow {
        id: 0,
        prompt: history_prompt,
        negative_prompt: input.negative_prompt.clone().unwrap_or_default(),
        model,
        provider_name,
        seed: None,
        width: width as i64,
        height: height as i64,
        guidance: 0.0,
        steps: 0,
        style: String::new(),
        file_path: path.clone(),
        favorite: false,
        created_at: now,
        parent_id: input.parent_id,
        op: "background".to_string(),
    })?;
    Ok(serde_json::json!({
        "historyId": id,
        "dataUrl": data_url,
        "filePath": path,
        "width": width,
        "height": height,
        "op": "background",
        "parentId": input.parent_id,
    }))
}

/// 同族图片（根 + 直接派生）：画布与画廊用它展示「派生自」关系
#[tauri::command]
pub async fn list_derived(history_id: i64) -> Result<serde_json::Value, String> {
    let items = storage::list_derived(history_id)?;
    Ok(serde_json::json!({ "items": items }))
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
    favorite_only: Option<bool>,
) -> Result<serde_json::Value, String> {
    let rows = storage::list_history(
        limit.unwrap_or(200),
        offset.unwrap_or(0),
        &model.unwrap_or_default(),
        &style.unwrap_or_default(),
        favorite_only.unwrap_or(false),
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

/// 画布粘贴：把剪贴板图片落盘并作为一条无提示词的画廊记录入库，
/// 让画布节点仍然只引用 historyId，不把 dataUrl 写进画布文件。
#[tauri::command]
pub async fn import_image(
    app: tauri::AppHandle,
    data_url: String,
) -> Result<serde_json::Value, String> {
    use base64::Engine;
    use image::GenericImageView;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(image_store::strip_data_url(&data_url))
        .map_err(|e| format!("图片 base64 解码失败: {e}"))?;
    let (width, height) = image::load_from_memory(&bytes)
        .map_err(|e| format!("图片解码失败: {e}"))?
        .dimensions();
    let now = storage::timestamp_millis();
    let name = image_store::unique_name("paste_", &now, 0);
    let (path, data_url) = image_store::save_b64_image(&app, &data_url, &name)?;
    image_store::ensure_thumb(std::path::Path::new(&path));
    let id = storage::add_history(&storage::HistoryRow {
        id: 0,
        prompt: String::new(),
        negative_prompt: String::new(),
        model: String::new(),
        provider_name: String::new(),
        seed: None,
        width: width as i64,
        height: height as i64,
        guidance: 0.0,
        steps: 0,
        style: String::new(),
        file_path: path.clone(),
        favorite: false,
        created_at: now,
        parent_id: None,
        op: "paste".to_string(),
    })?;
    Ok(serde_json::json!({
        "historyId": id,
        "dataUrl": data_url,
    }))
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

/// 按 id 取记录元信息：画布节点复用参数 / 编辑浮层需要提示词与尺寸
#[tauri::command]
pub async fn get_history_item(id: i64) -> Result<Option<storage::HistoryRow>, String> {
    Ok(storage::history_row(id)?)
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

    /// 参考图角色 / 强度：基础提示词（含风格）之后追加逐图说明，顺序与图片一致
    #[test]
    fn build_prompt_appends_reference_guidance_after_style() {
        use crate::reference::{ReferenceRole, ReferenceSpec};
        let input = GenerateCommandInput {
            provider_id: 1,
            prompt: "a cat".into(),
            negative_prompt: None,
            model: "m".into(),
            width: 512,
            height: 512,
            quality: None,
            guidance: None,
            steps: None,
            seed: None,
            style: "oil painting".into(),
            count: 1,
            images: None,
            references: None,
            job_id: None,
        };
        let refs = vec![ReferenceSpec {
            role: ReferenceRole::Style,
            strength: Some(90),
        }];
        let prompt = build_prompt(&input, &refs);
        assert!(prompt.starts_with("a cat, oil painting\nReference 1 (style, strong)"));
        // 没有参考图时不追加任何内容（简单模式行为不变）
        assert_eq!(build_prompt(&input, &[]), "a cat, oil painting");
    }

    #[test]
    fn normalize_generation_keeps_auto_size() {
        // 0×0 是自动尺寸哨兵：不能被钳到 64×64
        assert_eq!(normalize_generation(0, 0, 0), (0, 0, 1));
        assert_eq!(normalize_generation(0, 0, 9), (0, 0, 4));
        // 只有一边为 0 时仍按普通尺寸归一化
        assert_eq!(normalize_generation(0, 1024, 1), (SIZE_MIN, 1024, 1));
    }

    #[test]
    fn normalize_quality_whitelist() {
        assert_eq!(normalize_quality(Some("low")), Some("low".into()));
        assert_eq!(normalize_quality(Some("medium")), Some("medium".into()));
        assert_eq!(normalize_quality(Some("high")), Some("high".into()));
        assert_eq!(normalize_quality(Some("auto")), None);
        assert_eq!(normalize_quality(Some("ultra")), None);
        assert_eq!(normalize_quality(None), None);
    }

    /// 聊天内逐张进度：payload 形状固定；无 jobId（队列路径）不发事件
    #[test]
    fn progress_payload_shape_and_job_guard() {
        assert!(progress_payload(None, 1, 2, 4).is_none());
        let value = progress_payload(Some("job-9"), 3, 4, 4).expect("有 jobId 时必须有载荷");
        assert_eq!(value["jobId"], "job-9");
        assert_eq!(value["done"], 3);
        assert_eq!(value["total"], 4);
        assert_eq!(value["requested"], 4);
    }

    /// F-016：尺寸先夹区间再吸附 8 的倍数，0/超大值都不再透传给服务商
    #[test]
    fn normalize_size_clamps_then_snaps() {
        assert_eq!(normalize_size(0), SIZE_MIN);
        assert_eq!(normalize_size(1), SIZE_MIN);
        assert_eq!(normalize_size(512), 512);
        assert_eq!(normalize_size(1024), 1024);
        // 4090 就近吸附到 4088（与前端 appStore 的 round 口径一致），不会越过上限
        assert_eq!(normalize_size(4090), 4088);
        assert_eq!(normalize_size(4097), SIZE_MAX);
        assert_eq!(normalize_size(u32::MAX), SIZE_MAX);
        // 结果永远是 8 的倍数且在区间内
        for n in [0, 7, 63, 64, 65, 100, 1001, 4095, 5000] {
            let v = normalize_size(n);
            assert!(v.is_multiple_of(SIZE_STEP), "{n} -> {v} 不是 8 的倍数");
            assert!((SIZE_MIN..=SIZE_MAX).contains(&v), "{n} -> {v} 越界");
        }
    }

    /// F-016：张数归一化，0 张与超大张数都会被夹到 1–4
    #[test]
    fn normalize_count_clamps_to_range() {
        assert_eq!(normalize_count(0), 1);
        assert_eq!(normalize_count(1), 1);
        assert_eq!(normalize_count(4), 4);
        assert_eq!(normalize_count(9), COUNT_MAX);
        assert_eq!(normalize_generation(0, 100_000, 0), (64, 4096, 1));
    }
}
