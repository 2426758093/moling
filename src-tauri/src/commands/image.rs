use crate::adapters::{self, AdapterError, EditRequest, GenerateRequest, TransformRequest};
use crate::billing_journal::{self, AttemptCtx, AttemptSpec, BillingClass};
use crate::image_store::{self, SAFE_NAME_MAX_CHARS};
use crate::key_pool;
use crate::storage;
use std::hash::{Hash, Hasher};
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
pub(crate) fn is_cancelled(token: &Option<CancelToken>) -> bool {
    token
        .as_ref()
        .map(|t| t.load(Ordering::SeqCst))
        .unwrap_or(false)
}

/// RA-04/A6：只重试「连接都没建立」的 Network 错误（肯定未计费）。
/// Timeout 可能是上游已经生成、只是读响应超时，自动重试会重复扣费，因此不重试；
/// QuotaExceeded/AuthInvalid/ContentBlocked/Other 重试同样既无意义又可能重复扣费。
fn is_retryable(err: &AdapterError) -> bool {
    matches!(err, AdapterError::Network { .. })
}

/// 超时提示：上游可能已生成并计费，引导用户先确认再重试。
/// 等待响应头超时多半是出图本身慢（60s 旧默认尤其常见），额外交代可调高超时；
/// 响应体停滞则与生成时长无关，只保留计费提示。
fn timeout_billing_hint(err: AdapterError) -> AdapterError {
    match err {
        AdapterError::Timeout { message } => {
            let hint = if message.contains("等待服务商响应超时") {
                "图片生成常需数分钟，可在「服务商管理」中调高「超时」；\
                 请求可能已在上游生成并计费，请先到画廊或服务商后台确认后再重试"
            } else {
                "请求可能已在上游生成并计费，请先到画廊或服务商后台确认后再重试"
            };
            AdapterError::Timeout {
                message: format!("{message}（{hint}）"),
            }
        }
        other => other,
    }
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
    let scope = GenerateScope::chat(input.job_id.as_deref());
    let progress_app = app.clone();
    let job_id = input.job_id.clone();
    let requested = normalize_count(input.count);
    let outcome = generate_core(&app, &input, &scope, cancel_token, move |done, total| {
        // 事件发不出去（窗口已关）不影响生成
        if let Some(payload) = progress_payload(job_id.as_deref(), done, total, requested) {
            let _ = progress_app.emit("image:progress", payload);
        }
    })
    .await?;
    Ok(serde_json::json!({
        "images": outcome.images,
        "cancelled": outcome.cancelled,
        "failed": outcome.failed,
    }))
}

/// 生成结果（聊天命令与队列 worker 共用）
pub(crate) struct GenerateOutcome {
    pub images: Vec<GeneratedImage>,
    /// 单张落盘/入库失败明细：部分失败不影响其余图片
    pub failed: Vec<FailedImage>,
    pub cancelled: bool,
}

/// 单张图片落盘失败：序号从 1 开始，与用户看到的第几张一致
#[derive(serde::Serialize)]
pub(crate) struct FailedImage {
    pub index: usize,
    pub reason: String,
}

/// 缩略图生成要完整解码图片，属于 CPU 密集操作：放到 blocking 线程池，
/// 避免大图把异步运行时的 worker 卡住（B5）。
async fn ensure_thumb_async(path: String) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        image_store::ensure_thumb(std::path::Path::new(&path));
    })
    .await;
}

/// 一次生成动作的归属：聊天（前端 jobId）或队列（jobs.id）。
/// 同一次用户动作里的多次 HTTP 尝试共享 group_id，便于对账时归组。
pub(crate) struct GenerateScope {
    pub entry: &'static str,
    pub group_id: String,
    pub job_id: Option<i64>,
}

impl GenerateScope {
    pub(crate) fn chat(job_id: Option<&str>) -> Self {
        Self {
            entry: "chat",
            group_id: job_id
                .map(str::to_string)
                .unwrap_or_else(|| format!("chat-{}", storage::timestamp_millis())),
            job_id: None,
        }
    }

    pub(crate) fn queue(job_id: i64) -> Self {
        Self {
            entry: "queue",
            group_id: format!("queue-{job_id}-{}", storage::timestamp_millis()),
            job_id: Some(job_id),
        }
    }
}

/// 请求指纹：参数完全相同且仍在途，几乎只可能是连点/重复提交。
fn param_fingerprint(input: &GenerateCommandInput, req: &GenerateRequest) -> String {
    use std::collections::hash_map::DefaultHasher;
    let mut hasher = DefaultHasher::new();
    input.provider_id.hash(&mut hasher);
    req.model.hash(&mut hasher);
    req.prompt.hash(&mut hasher);
    req.negative_prompt.hash(&mut hasher);
    req.width.hash(&mut hasher);
    req.height.hash(&mut hasher);
    req.quality.hash(&mut hasher);
    req.guidance.map(f32::to_bits).hash(&mut hasher);
    req.steps.hash(&mut hasher);
    req.seed.hash(&mut hasher);
    req.count.hash(&mut hasher);
    for img in &req.images {
        img.hash(&mut hasher);
    }
    format!("{:016x}", hasher.finish())
}

fn request_endpoint(req: &GenerateRequest) -> &'static str {
    if req.images.is_empty() {
        "/images/generations"
    } else {
        "/images/edits"
    }
}

/// 把「可能需要用户确认」的失败包装成 `Unconfirmed`：前端据此提示先对账再重试。
fn billing_error(ctx: &AttemptCtx, err: AdapterError, class: BillingClass) -> AdapterError {
    match class {
        BillingClass::NotBilled => timeout_billing_hint(err),
        BillingClass::PossiblyBilled | BillingClass::BilledUnrecovered => {
            let slow_hint = match &err {
                AdapterError::Timeout { message } if message.contains("等待服务商响应超时") => {
                    "图片生成常需数分钟，可在「服务商管理」中调高「超时」；"
                }
                _ => "",
            };
            let tail = if class == BillingClass::BilledUnrecovered {
                "服务商已受理并计费，但图片未能取回；可稍后在「请求记录」里尝试恢复，不要直接重新生成"
            } else {
                "请求可能已在上游生成并计费，请先到画廊或服务商后台确认后再重试"
            };
            AdapterError::Unconfirmed {
                message: format!("{}{}（{tail}）", err.message(), slow_hint),
                request_id: ctx.client_request_id().to_string(),
                artifact: None,
            }
        }
    }
}

/// 生成 + 逐张落盘/入库的核心流程；取消 token 由调用方注册与回收。
/// `on_progress(done, total)` 在每张图落盘入库后调用一次（队列据此发进度事件）。
pub(crate) async fn generate_core<F>(
    app: &tauri::AppHandle,
    input: &GenerateCommandInput,
    scope: &GenerateScope,
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

    let param_hash = param_fingerprint(input, &req);
    let endpoint = request_endpoint(&req);

    // 失败自动重试：只有「肯定未计费」的建连失败才重试一次（RA-04）；
    // 401/403 视为该 Key 不可用，切到下一个 Key（请求被拒不会计费）。
    // 其余失败（超时 / 断连 / 5xx / 解析失败）可能已在上游生成并计费，一律不重发。
    let mut cancelled = false;
    let mut last_err: Option<AdapterError> = None;
    let mut generated: Option<(AttemptCtx, Vec<String>)> = None;
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
            // 先落请求意图再发送：连 DB 都写不进去就不发计费请求（fail-closed）
            let ctx = match AttemptCtx::begin(&AttemptSpec {
                group_id: &scope.group_id,
                entry: scope.entry,
                op: "generate",
                job_id: scope.job_id,
                provider_id: input.provider_id,
                provider_name: &row.name,
                model: &input.model,
                prompt: &full_prompt,
                endpoint,
                attempt: attempt + 1,
                param_hash: &param_hash,
                image_count: count,
            }) {
                Ok(ctx) => ctx,
                Err(e) => return Err(e.to_string()),
            };
            match adapter.generate_journaled(config, &req, Some(&ctx)).await {
                Ok(imgs) => {
                    key_pool::note_success(input.provider_id, candidate.index);
                    generated = Some((ctx, imgs));
                    break 'keys;
                }
                Err(e) if key_pool::is_auth(&e) => {
                    key_pool::note_auth_failure(input.provider_id, candidate.index, &e);
                    ctx.finish(billing_journal::STATE_FAILED, Some(&e), &[]);
                    tracing::warn!(
                        "服务商「{}」第 {} 个 Key 鉴权失败，尝试下一个 Key",
                        row.name,
                        candidate.index + 1
                    );
                    last_err = Some(e);
                    break;
                }
                Err(e) => {
                    let class = billing_journal::classify_billing(&e, ctx.is_billed());
                    ctx.finish(
                        match class {
                            BillingClass::NotBilled => billing_journal::STATE_FAILED,
                            BillingClass::PossiblyBilled => billing_journal::STATE_UNKNOWN,
                            BillingClass::BilledUnrecovered => {
                                billing_journal::STATE_BILLED_UNRECOVERED
                            }
                        },
                        Some(&e),
                        &[],
                    );
                    // 可能已计费：绝不自动重发，交给用户对账后决定
                    if class != BillingClass::NotBilled {
                        return Err(adapters::adapter_error_json(billing_error(&ctx, e, class)));
                    }
                    let retry = is_retryable(&e) && attempt + 1 < GENERATE_MAX_ATTEMPTS;
                    if retry {
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
                    return Err(adapters::adapter_error_json(timeout_billing_hint(e)));
                }
            }
        }
    }

    let now = storage::timestamp_millis();
    let mut out = Vec::new();
    let mut failed: Vec<FailedImage> = Vec::new();
    if let Some((ctx, images)) = generated {
        let total = images.len();
        // 请求已发出就以拿回产物为先：停止只影响展示与最终标记，
        // 不再丢弃服务商已经返回（并且已经计费）的图片。
        cancelled = is_cancelled(&cancel_token);
        let mut saved_paths: Vec<String> = Vec::with_capacity(total);
        for (i, b64) in images.iter().enumerate() {
            // B4：单张失败只记录明细，不丢掉已成功的其它图片
            let seed_val = Some(input.seed.map(|s| s as i64).unwrap_or_else(rand::random));
            let persisted = (|| -> Result<(String, String, i64), String> {
                let name = image_store::unique_name("", &now, i);
                let (path, data_url) = image_store::save_b64_image_with_retry(app, b64, &name)
                    .map_err(|e| e.to_string())?;
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
                })
                .map_err(|e| e.to_string())?;
                Ok((path, data_url, id))
            })();
            match persisted {
                Ok((path, data_url, id)) => {
                    // 生成即建缩略图：画廊首屏只传缩略图，避免每页几十 MB 的原图 base64
                    ensure_thumb_async(path.clone()).await;
                    saved_paths.push(path.clone());
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
                Err(reason) => {
                    tracing::warn!("第 {} 张图片保存失败: {reason}", i + 1);
                    // 保底：把图片本体留在请求目录，恢复入口不需要重新生成
                    if let Some(stashed) =
                        billing_journal::stash_b64_artifact(ctx.client_request_id(), i, b64)
                    {
                        ctx.note_artifact(&stashed);
                    }
                    failed.push(FailedImage {
                        index: i + 1,
                        reason,
                    });
                }
            }
        }
        let state = if out.is_empty() {
            billing_journal::STATE_BILLED_UNRECOVERED
        } else if failed.is_empty() {
            billing_journal::STATE_SUCCEEDED
        } else {
            billing_journal::STATE_PARTIAL
        };
        let save_error = failed.first().map(|f| AdapterError::Other {
            message: format!("第 {} 张：{}", f.index, f.reason),
        });
        ctx.finish(state, save_error.as_ref(), &saved_paths);
        if state == billing_journal::STATE_SUCCEEDED {
            ctx.discard_raw();
            return Ok(GenerateOutcome {
                images: out,
                failed,
                cancelled,
            });
        }
        if out.is_empty() {
            // 已计费但一个字节都没落库：给出可恢复的错误，而不是普通失败
            let reason = failed
                .iter()
                .map(|f| format!("第 {} 张：{}", f.index, f.reason))
                .collect::<Vec<_>>()
                .join("；");
            return Err(adapters::adapter_error_json(AdapterError::Unconfirmed {
                message: format!(
                    "图片已生成但本地保存失败：{reason}（原图已缓存，可在「请求记录」中恢复）"
                ),
                request_id: ctx.client_request_id().to_string(),
                artifact: None,
            }));
        }
    } else if !cancelled {
        // 未取消却没有图片：只可能是所有 Key 均鉴权失败或重试耗尽
        return Err(adapters::adapter_error_json(
            last_err.expect("无图片且未取消必有错误"),
        ));
    }
    Ok(GenerateOutcome {
        images: out,
        failed,
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

/// 编辑类请求的对账信息（一次用户动作一条 group）。
struct EditJournal<'a> {
    group_id: &'a str,
    entry: &'a str,
    op: &'a str,
    param_hash: &'a str,
    provider_name: &'a str,
    model: &'a str,
    prompt: &'a str,
}

/// 编辑类请求的公共执行段：Key 轮换 + 单次调用（编辑计费，鉴权失败不重发）。
/// 成功时把 `AttemptCtx` 交给调用方：图片落盘入库后再写终态与产物路径。
async fn run_edit(
    provider_id: i64,
    req: &EditRequest,
    journal: &EditJournal<'_>,
) -> Result<(AttemptCtx, String), String> {
    let candidates = key_pool::candidates(provider_id)?;
    if candidates.is_empty() {
        return Err("该服务商还没有配置 API Key".to_string());
    }
    let mut last_err: Option<AdapterError> = None;
    for candidate in &candidates {
        let adapter =
            adapters::get_adapter(&candidate.config.kind).map_err(adapters::adapter_error_json)?;
        // 先落请求意图再发送：没有流水就不发计费请求
        let ctx = AttemptCtx::begin(&AttemptSpec {
            group_id: journal.group_id,
            entry: journal.entry,
            op: journal.op,
            job_id: None,
            provider_id,
            provider_name: journal.provider_name,
            model: journal.model,
            prompt: journal.prompt,
            endpoint: "/images/edits",
            attempt: candidate.index as u32 + 1,
            param_hash: journal.param_hash,
            image_count: 1,
        })
        .map_err(|e| e.to_string())?;
        match adapter
            .edit_journaled(&candidate.config, req, Some(&ctx))
            .await
        {
            Ok(result) => {
                key_pool::note_success(provider_id, candidate.index);
                return Ok((ctx, result));
            }
            Err(e) if key_pool::is_auth(&e) => {
                key_pool::note_auth_failure(provider_id, candidate.index, &e);
                ctx.finish(billing_journal::STATE_FAILED, Some(&e), &[]);
                last_err = Some(e);
            }
            Err(e) => {
                let class = billing_journal::classify_billing(&e, ctx.is_billed());
                ctx.finish(
                    match class {
                        BillingClass::NotBilled => billing_journal::STATE_FAILED,
                        BillingClass::PossiblyBilled => billing_journal::STATE_UNKNOWN,
                        BillingClass::BilledUnrecovered => {
                            billing_journal::STATE_BILLED_UNRECOVERED
                        }
                    },
                    Some(&e),
                    &[],
                );
                return Err(adapters::adapter_error_json(billing_error(&ctx, e, class)));
            }
        }
    }
    Err(adapters::adapter_error_json(
        last_err.expect("候选列表非空时必有结果或错误"),
    ))
}

/// 图片落盘 / 入库失败但请求已计费：留底并给出可恢复错误，绝不丢图。
fn billed_save_error(ctx: &AttemptCtx, b64: &str, reason: String) -> String {
    if let Some(stashed) = billing_journal::stash_b64_artifact(ctx.client_request_id(), 0, b64) {
        ctx.note_artifact(&stashed);
    }
    let err = AdapterError::Other {
        message: reason.clone(),
    };
    ctx.finish(billing_journal::STATE_BILLED_UNRECOVERED, Some(&err), &[]);
    adapters::adapter_error_json(AdapterError::Unconfirmed {
        message: format!(
            "图片已生成但本地保存失败：{reason}（原图已缓存，可在「请求记录」中恢复）"
        ),
        request_id: ctx.client_request_id().to_string(),
        artifact: None,
    })
}

/// 指纹：参数 + 输入图内容；用于阻止连点造成的重复计费。
fn edit_fingerprint(parts: &[&str]) -> String {
    use std::collections::hash_map::DefaultHasher;
    let mut hasher = DefaultHasher::new();
    for part in parts {
        part.hash(&mut hasher);
    }
    format!("{:016x}", hasher.finish())
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
    let now = storage::timestamp_millis();
    let op = normalize_edit_op(input.op.as_deref(), erase);
    let group_id = format!("edit-{now}");
    let param_hash = edit_fingerprint(&[
        &input.provider_id.to_string(),
        &input.model,
        &req.prompt,
        req.negative_prompt.as_deref().unwrap_or(""),
        &req.image_b64,
        req.mask_b64.as_deref().unwrap_or(""),
        op,
        &input.width.to_string(),
        &input.height.to_string(),
    ]);
    let (ctx, b64) = run_edit(
        input.provider_id,
        &req,
        &EditJournal {
            group_id: &group_id,
            entry: "edit",
            op,
            param_hash: &param_hash,
            provider_name: &row.name,
            model: &input.model,
            prompt: &input.prompt,
        },
    )
    .await?;
    // 统一命名：edit_ 前缀 + 纳秒 + 随机尾（旧版只到毫秒，同毫秒多张编辑会互相覆盖）
    let name = image_store::unique_name("edit_", &now, 0);
    let (path, data_url) = match image_store::save_b64_image_with_retry(&app, &b64, &name) {
        Ok(v) => v,
        Err(e) => return Err(billed_save_error(&ctx, &b64, e.to_string())),
    };
    ensure_thumb_async(path.clone()).await;
    let id = match storage::add_history(&storage::HistoryRow {
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
    }) {
        Ok(id) => id,
        Err(e) => return Err(billed_save_error(&ctx, &b64, e.to_string())),
    };
    ctx.finish(
        billing_journal::STATE_SUCCEEDED,
        None,
        std::slice::from_ref(&path),
    );
    ctx.discard_raw();
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
    match image_store::decode_limited(&bytes) {
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
    let mut journaled: Option<(AttemptCtx, String)> = None;
    let mut last_err: Option<AdapterError> = None;
    let now = storage::timestamp_millis();
    let group_id = format!("transform-{now}");
    let param_hash = edit_fingerprint(&[
        &input.provider_id.to_string(),
        &input.model,
        &style,
        op,
        mode,
        &scale.to_string(),
        &req.image_b64,
    ]);
    for candidate in &candidates {
        let adapter =
            adapters::get_adapter(&candidate.config.kind).map_err(adapters::adapter_error_json)?;
        let ctx = AttemptCtx::begin(&AttemptSpec {
            group_id: &group_id,
            entry: "transform",
            op,
            job_id: None,
            provider_id: input.provider_id,
            provider_name: &row.name,
            model: &input.model,
            prompt: &style,
            endpoint: "/images/edits",
            attempt: candidate.index as u32 + 1,
            param_hash: &param_hash,
            image_count: 1,
        })
        .map_err(|e| e.to_string())?;
        match adapter
            .transform_journaled(&candidate.config, &req, Some(&ctx))
            .await
        {
            Ok(result) => {
                key_pool::note_success(input.provider_id, candidate.index);
                journaled = Some((ctx, result));
                break;
            }
            Err(e) if key_pool::is_auth(&e) => {
                key_pool::note_auth_failure(input.provider_id, candidate.index, &e);
                ctx.finish(billing_journal::STATE_FAILED, Some(&e), &[]);
                last_err = Some(e);
            }
            Err(e) => {
                let class = billing_journal::classify_billing(&e, ctx.is_billed());
                ctx.finish(
                    match class {
                        BillingClass::NotBilled => billing_journal::STATE_FAILED,
                        BillingClass::PossiblyBilled => billing_journal::STATE_UNKNOWN,
                        BillingClass::BilledUnrecovered => {
                            billing_journal::STATE_BILLED_UNRECOVERED
                        }
                    },
                    Some(&e),
                    &[],
                );
                return Err(adapters::adapter_error_json(billing_error(&ctx, e, class)));
            }
        }
    }
    let (ctx, b64) = journaled.ok_or_else(|| {
        adapters::adapter_error_json(last_err.expect("候选列表非空时必有结果或错误"))
    })?;

    let parent = match input.parent_id {
        Some(pid) => storage::history_row(pid)?,
        None => None,
    };
    let prefix = if op == "style" { "style_" } else { "up_" };
    let name = image_store::unique_name(prefix, &now, 0);
    let (path, data_url) = match image_store::save_b64_image_with_retry(&app, &b64, &name) {
        Ok(v) => v,
        Err(e) => return Err(billed_save_error(&ctx, &b64, e.to_string())),
    };
    ensure_thumb_async(path.clone()).await;
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
    let id = match storage::add_history(&storage::HistoryRow {
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
    }) {
        Ok(id) => id,
        Err(e) => return Err(billed_save_error(&ctx, &b64, e.to_string())),
    };
    ctx.finish(
        billing_journal::STATE_SUCCEEDED,
        None,
        std::slice::from_ref(&path),
    );
    ctx.discard_raw();
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
    let img = image_store::decode_limited(&bytes).map_err(|e| format!("图片解码失败: {e}"))?;
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
    ensure_thumb_async(path.clone()).await;
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
    let base =
        image_store::decode_limited(&base_bytes).map_err(|e| format!("图片解码失败: {e}"))?;
    let mask_raw = image_store::strip_data_url(&input.mask_b64);
    let mask_bytes = base64::engine::general_purpose::STANDARD
        .decode(&mask_raw)
        .map_err(|e| format!("蒙版 base64 解码失败: {e}"))?;
    let mask_img =
        image_store::decode_limited(&mask_bytes).map_err(|e| format!("蒙版解码失败: {e}"))?;
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

    let (b64, provider_name, model, history_prompt, journal_ctx) = match input.kind.as_str() {
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
                None,
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
                None,
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
            let group_id = format!("background-{}", storage::timestamp_millis());
            let param_hash = edit_fingerprint(&[
                &provider_id.to_string(),
                &model,
                &desc,
                &req.image_b64,
                &mask_raw,
            ]);
            let (ctx, b64) = run_edit(
                provider_id,
                &req,
                &EditJournal {
                    group_id: &group_id,
                    entry: "background",
                    op: "background",
                    param_hash: &param_hash,
                    provider_name: &row.name,
                    model: &model,
                    prompt: &desc,
                },
            )
            .await?;
            (
                b64,
                row.name.clone(),
                model,
                format!("换背景：{desc}"),
                Some(ctx),
            )
        }
        other => return Err(format!("未知的背景类型: {other}")),
    };

    let now = storage::timestamp_millis();
    let name = image_store::unique_name("bg_", &now, 0);
    let (path, data_url) = match &journal_ctx {
        Some(ctx) => image_store::save_b64_image_with_retry(&app, &b64, &name)
            .map_err(|e| billed_save_error(ctx, &b64, e.to_string()))?,
        None => image_store::save_b64_image(&app, &b64, &name).map_err(|e| e.to_string())?,
    };
    ensure_thumb_async(path.clone()).await;
    let (width, height) = decoded_size(&b64);
    let id = match storage::add_history(&storage::HistoryRow {
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
    }) {
        Ok(id) => id,
        Err(e) => match &journal_ctx {
            Some(ctx) => return Err(billed_save_error(ctx, &b64, e.to_string())),
            None => return Err(e.to_string()),
        },
    };
    if let Some(ctx) = &journal_ctx {
        ctx.finish(
            billing_journal::STATE_SUCCEEDED,
            None,
            std::slice::from_ref(&path),
        );
        ctx.discard_raw();
    }
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

/// 画廊列表：只返回缩略图 data URL（缺失时为空串，前端显示占位）。
/// 不回退原图：原图是几 MB 的 base64，回退会把列表响应撑爆。
/// 读盘 + base64 编码是 CPU/IO 操作，整段放阻塞线程。
#[tauri::command]
pub async fn list_history(
    limit: Option<i64>,
    offset: Option<i64>,
    before_id: Option<i64>,
    model: Option<String>,
    style: Option<String>,
    favorite_only: Option<bool>,
) -> Result<serde_json::Value, String> {
    let limit = limit.unwrap_or(200);
    let offset = offset.unwrap_or(0);
    let model = model.unwrap_or_default();
    let style = style.unwrap_or_default();
    let favorite_only = favorite_only.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let rows = storage::list_history(limit, offset, before_id, &model, &style, favorite_only)
            .map_err(|e| e.to_string())?;
        let items: Vec<serde_json::Value> = rows
            .into_iter()
            .map(|r| {
                let thumb = image_store::thumb_path_for(std::path::Path::new(&r.file_path));
                let thumb_url =
                    image_store::path_to_data_url(&thumb.to_string_lossy()).unwrap_or_default();
                serde_json::json!({ "history": r, "thumbUrl": thumb_url })
            })
            .collect();
        Ok(serde_json::json!({ "items": items }))
    })
    .await
    .map_err(|e| format!("读取画廊失败: {e}"))?
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
    let (width, height) = image_store::decode_limited(&bytes)
        .map_err(|e| format!("图片解码失败: {e}"))?
        .dimensions();
    let now = storage::timestamp_millis();
    let name = image_store::unique_name("paste_", &now, 0);
    let (path, data_url) = image_store::save_b64_image(&app, &data_url, &name)?;
    ensure_thumb_async(path.clone()).await;
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

    /// A6：只有 Network（连接未建立）可重试；Timeout 可能已计费，配额/鉴权/内容拦截/其他一律不重试
    #[test]
    fn retry_whitelist_only_network() {
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
                false,
            ),
            (
                AdapterError::QuotaExceeded {
                    message: "x".into(),
                    retry_after: None,
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

    /// A6：超时错误必须带上「可能已计费」提示，其他错误原样返回
    #[test]
    fn timeout_error_carries_billing_hint() {
        let err = timeout_billing_hint(AdapterError::Timeout {
            message: "x".into(),
        });
        assert!(err.message().contains("可能已在上游生成并计费"));
        // 等待响应头超时要额外给出「可调高超时」的可执行建议
        let header_wait = timeout_billing_hint(AdapterError::Timeout {
            message: "/images/edits 等待服务商响应超时（60s）".into(),
        });
        assert!(
            header_wait.message().contains("调高「超时」"),
            "{header_wait:?}"
        );
        assert!(header_wait.message().contains("可能已在上游生成并计费"));
        let other = timeout_billing_hint(AdapterError::Other {
            message: "y".into(),
        });
        assert_eq!(other.message(), "y");
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
