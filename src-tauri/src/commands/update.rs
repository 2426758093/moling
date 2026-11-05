use crate::adapters::http;
use crate::storage;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Updater, UpdaterExt};

/// 同一时刻只允许一次下载 / 安装：重复点击会重复下载整包
static DOWNLOADING: AtomicBool = AtomicBool::new(false);
static INSTALLING: AtomicBool = AtomicBool::new(false);

/// 检查更新与探测线路的超时：启动检查不能让界面等太久
const CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);
/// 单段下载的总超时；分段后每段数据量不大，5 分钟足够慢速网络
const PART_TIMEOUT: Duration = Duration::from_secs(300);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(400);

/// 小于该大小分段收益有限，直接单连接
const MIN_PARALLEL_BYTES: u64 = 1024 * 1024;
const PARALLEL_PARTS: usize = 4;
/// 更新包大小上限：全量放内存，避免异常清单把进程拖爆
const MAX_UPDATE_BYTES: u64 = 300 * 1024 * 1024;

const USER_AGENT: &str = concat!("moling/", env!("CARGO_PKG_VERSION"));

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

/// 下载线路：按用户代理设置排出优先级，逐条探测可用性。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RouteKind {
    Manual,
    System,
    Direct,
}

impl RouteKind {
    fn label(self) -> &'static str {
        match self {
            Self::Manual => "手动代理",
            Self::System => "系统网络",
            Self::Direct => "直连",
        }
    }
}

/// 已配置的模式优先，其次才尝试其它线路；用户显式选「直连」时也不放弃系统代理，
/// 否则在必须代理的网络里永远下载失败。
fn route_order(mode: &str) -> Vec<RouteKind> {
    match mode {
        http::MODE_MANUAL => vec![RouteKind::Manual, RouteKind::System, RouteKind::Direct],
        http::MODE_DIRECT => vec![RouteKind::Direct, RouteKind::System],
        _ => vec![RouteKind::System, RouteKind::Direct],
    }
}

/// 把 `[0,total)` 拆成若干闭区间，覆盖完整且互不重叠。
fn split_ranges(total: u64, parts: usize) -> Vec<(u64, u64)> {
    if total == 0 {
        return Vec::new();
    }
    let parts = (parts.max(1) as u64).min(total);
    let chunk = total.div_ceil(parts);
    let mut ranges = Vec::new();
    let mut start = 0;
    while start < total {
        let end = (start + chunk - 1).min(total - 1);
        ranges.push((start, end));
        start = end + 1;
    }
    ranges
}

/// 解析 `Content-Range: bytes 100-199/1000`；`*` 总长视为无效。
fn parse_content_range(value: &str) -> Option<(u64, u64, u64)> {
    let rest = value.trim().strip_prefix("bytes")?.trim_start();
    let (range, total) = rest.split_once('/')?;
    let total: u64 = total.trim().parse().ok()?;
    let (start, end) = range.split_once('-')?;
    Some((start.trim().parse().ok()?, end.trim().parse().ok()?, total))
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

/// 检查更新走用户配置的代理；手动代理带认证时用 configure_client 注入凭据，
/// 避免把密码拼进 URL（插件会把它写进日志）。
fn build_updater(app: &AppHandle) -> Result<Updater, String> {
    let cfg = http::stored_config();
    let mut builder = app.updater_builder().timeout(CHECK_TIMEOUT);
    match cfg.mode.as_str() {
        http::MODE_DIRECT => builder = builder.no_proxy(),
        http::MODE_MANUAL => {
            let url = cfg.url.trim().to_string();
            reqwest::Url::parse(&url).map_err(|e| format!("代理地址无效: {e}"))?;
            let username = cfg.username.trim().to_string();
            let no_proxy = cfg.no_proxy.trim().to_string();
            let password = if username.is_empty() {
                String::new()
            } else {
                storage::decrypt_secret(&cfg.password_enc).unwrap_or_else(|e| {
                    tracing::warn!("代理密码解密失败（{e}），更新请求将不带代理认证");
                    String::new()
                })
            };
            builder = builder.configure_client(move |client| {
                let proxy = match reqwest013::Proxy::all(&url) {
                    Ok(proxy) if !username.is_empty() => proxy.basic_auth(&username, &password),
                    Ok(proxy) => proxy,
                    Err(_) => return client,
                };
                let proxy = if no_proxy.is_empty() {
                    proxy
                } else {
                    proxy.no_proxy(reqwest013::NoProxy::from_string(&no_proxy))
                };
                client.proxy(proxy)
            });
        }
        _ => {}
    }
    builder
        .build()
        .map_err(|e| format!("初始化更新器失败: {e}"))
}

/// 按线路构建请求客户端；手动代理配置损坏时该线路直接跳过。
fn route_client(kind: RouteKind) -> Option<reqwest::Client> {
    let cfg = match kind {
        RouteKind::Manual => {
            let cfg = http::stored_config();
            if cfg.mode != http::MODE_MANUAL {
                return None;
            }
            cfg
        }
        RouteKind::System => http::ProxyConfig {
            mode: http::MODE_SYSTEM.into(),
            ..Default::default()
        },
        RouteKind::Direct => http::ProxyConfig {
            mode: http::MODE_DIRECT.into(),
            ..Default::default()
        },
    };
    let password = if cfg.mode == http::MODE_MANUAL {
        match storage::decrypt_secret(&cfg.password_enc) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!("代理密码解密失败（{e}），跳过手动代理线路");
                return None;
            }
        }
    } else {
        String::new()
    };
    match http::build_client(&cfg, &password) {
        Ok(client) => Some(client),
        Err(e) => {
            tracing::warn!("构建代理客户端失败（{e}），跳过该线路");
            None
        }
    }
}

/// 用 1 字节 Range 探测线路是否可用，顺带拿到文件总长。
/// 服务器忽略 Range（200）时仍算可达，后续会自动退回单连接。
async fn probe_route(client: &reqwest::Client, url: &reqwest::Url) -> Result<u64, String> {
    let response = client
        .get(url.clone())
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .header(reqwest::header::RANGE, "bytes=0-0")
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .timeout(PROBE_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("连接失败: {e}"))?;
    let status = response.status();
    if status == reqwest::StatusCode::PARTIAL_CONTENT {
        let raw = response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .ok_or("缺少 Content-Range")?;
        let (_, _, total) = parse_content_range(raw).ok_or("Content-Range 格式无效")?;
        return Ok(total);
    }
    if status.is_success() {
        return response
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse().ok())
            .ok_or_else(|| "服务器未返回文件长度".to_string());
    }
    Err(format!("HTTP {status}"))
}

/// 上传进度：分段计数分开累加，重试/回退时可精确回滚，不会出现进度倒退或超 100%。
struct ProgressTracker {
    handle: AppHandle,
    total: u64,
    route: &'static str,
    started: Instant,
    /// 0 号槽位给单连接，1..=PARALLEL_PARTS 给各分段
    counters: Vec<AtomicU64>,
    done: AtomicBool,
}

impl ProgressTracker {
    fn new(handle: AppHandle, total: u64, route: &'static str) -> Self {
        Self {
            handle,
            total,
            route,
            started: Instant::now(),
            counters: (0..=PARALLEL_PARTS).map(|_| AtomicU64::new(0)).collect(),
            done: AtomicBool::new(false),
        }
    }

    fn add(&self, slot: usize, bytes: u64) {
        if let Some(counter) = self.counters.get(slot) {
            counter.fetch_add(bytes, Ordering::Relaxed);
        }
    }

    fn reset(&self, slot: usize) {
        if let Some(counter) = self.counters.get(slot) {
            counter.store(0, Ordering::Relaxed);
        }
    }

    fn reset_all(&self) {
        for counter in &self.counters {
            counter.store(0, Ordering::Relaxed);
        }
    }

    fn downloaded(&self) -> u64 {
        self.counters
            .iter()
            .map(|c| c.load(Ordering::Relaxed))
            .sum()
    }

    fn finish(&self) {
        self.done.store(true, Ordering::Relaxed);
    }

    fn emit(&self) {
        let downloaded = self.downloaded();
        let secs = self.started.elapsed().as_secs_f64().max(0.001);
        let speed = (downloaded as f64 / secs) as u64;
        let _ = self.handle.emit(
            "update:progress",
            serde_json::json!({
                "downloaded": downloaded,
                "total": self.total,
                "speed": speed,
                "route": self.route,
            }),
        );
    }
}

fn spawn_progress_monitor(progress: Arc<ProgressTracker>) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(PROGRESS_INTERVAL).await;
            progress.emit();
            if progress.done.load(Ordering::Relaxed) {
                // 收尾再发一次，确保界面看到最终数值
                progress.emit();
                break;
            }
        }
    })
}

async fn fetch_range(
    client: &reqwest::Client,
    url: &reqwest::Url,
    start: u64,
    end: u64,
    total: u64,
    progress: &ProgressTracker,
    slot: usize,
) -> Result<Vec<u8>, String> {
    let mut response = client
        .get(url.clone())
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .header(reqwest::header::RANGE, format!("bytes={start}-{end}"))
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .timeout(PART_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(format!("服务器未按分段返回（HTTP {}）", response.status()));
    }
    let raw = response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .ok_or("缺少 Content-Range")?
        .to_string();
    match parse_content_range(&raw) {
        Some((got_start, got_end, got_total))
            if got_start == start && got_end == end && got_total == total =>
        {
            validate_range_total(total)?;
        }
        _ => return Err(format!("分段响应不匹配: {raw}")),
    }

    let expected = (end - start + 1) as usize;
    let mut data = Vec::with_capacity(expected);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("读取分段失败: {e}"))?
    {
        data.extend_from_slice(&chunk);
        if data.len() > expected {
            return Err("分段数据超出预期长度".into());
        }
        progress.add(slot, chunk.len() as u64);
    }
    if data.len() != expected {
        return Err(format!("分段数据不完整（{} / {expected}）", data.len()));
    }
    Ok(data)
}

async fn download_parallel(
    client: &reqwest::Client,
    url: &reqwest::Url,
    total: u64,
    progress: Arc<ProgressTracker>,
) -> Result<Vec<u8>, String> {
    let ranges = split_ranges(total, PARALLEL_PARTS);
    let mut handles = Vec::with_capacity(ranges.len());
    for (index, (start, end)) in ranges.iter().copied().enumerate() {
        let client = client.clone();
        let url = url.clone();
        let progress = progress.clone();
        let slot = index + 1;
        handles.push(tauri::async_runtime::spawn(async move {
            let mut last = String::new();
            for attempt in 0..2 {
                match fetch_range(&client, &url, start, end, total, &progress, slot).await {
                    Ok(bytes) => return Ok((index, bytes)),
                    Err(e) => {
                        last = e;
                        if attempt == 0 {
                            progress.reset(slot);
                            tracing::warn!("分段 {} 下载失败，重试一次: {last}", slot);
                        }
                    }
                }
            }
            Err((index, last))
        }));
    }

    let mut pieces: Vec<Option<Vec<u8>>> = vec![None; ranges.len()];
    let mut error = None;
    for handle in handles {
        match handle.await {
            Ok(Ok((index, bytes))) => pieces[index] = Some(bytes),
            Ok(Err((index, e))) => {
                error.get_or_insert(format!("第 {} 段: {e}", index + 1));
            }
            Err(e) => {
                error.get_or_insert(format!("下载线程异常: {e}"));
            }
        }
    }
    if let Some(e) = error {
        return Err(e);
    }

    let mut out = Vec::with_capacity(total as usize);
    for piece in pieces {
        out.extend_from_slice(&piece.ok_or_else(|| "分段结果缺失".to_string())?);
    }
    Ok(out)
}

async fn download_single(
    client: &reqwest::Client,
    url: &reqwest::Url,
    total: u64,
    progress: &ProgressTracker,
) -> Result<Vec<u8>, String> {
    let mut response = client
        .get(url.clone())
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .send()
        .await
        .map_err(|e| format!("下载失败: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("下载失败（HTTP {}）", response.status()));
    }
    let mut data = Vec::with_capacity(total as usize);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("读取下载数据失败: {e}"))?
    {
        data.extend_from_slice(&chunk);
        progress.add(0, chunk.len() as u64);
        if data.len() as u64 > MAX_UPDATE_BYTES {
            return Err("更新包超出大小上限，已中止下载".into());
        }
    }
    Ok(data)
}

async fn download_with_route(
    client: &reqwest::Client,
    url: &reqwest::Url,
    total: u64,
    progress: Arc<ProgressTracker>,
) -> Result<Vec<u8>, String> {
    let monitor = spawn_progress_monitor(progress.clone());
    let result = if total >= MIN_PARALLEL_BYTES {
        match download_parallel(client, url, total, progress.clone()).await {
            Ok(bytes) => Ok(bytes),
            Err(e) => {
                tracing::warn!("多线程下载失败（{e}），回退单连接");
                progress.reset_all();
                download_single(client, url, total, &progress).await
            }
        }
    } else {
        download_single(client, url, total, &progress).await
    };
    progress.finish();
    let _ = monitor.await;
    result
}

fn validate_range_total(total: u64) -> Result<(), String> {
    if total > MAX_UPDATE_BYTES {
        return Err(format!(
            "更新包过大（{} MB），已取消下载",
            total / (1024 * 1024)
        ));
    }
    Ok(())
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
    let updater = build_updater(&app)?;
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

/// 已下载校验通过的更新包；安装阶段直接用它，不再联网。
struct CachedUpdate {
    update: tauri_plugin_updater::Update,
    bytes: Arc<Vec<u8>>,
}

#[derive(Default)]
pub struct UpdateCache(Mutex<Option<CachedUpdate>>);

fn take_cached(app: &AppHandle) -> Option<CachedUpdate> {
    let cache = app.state::<UpdateCache>();
    let taken = match cache.0.lock() {
        Ok(mut guard) => guard.take(),
        Err(poisoned) => poisoned.into_inner().take(),
    };
    taken
}

fn restore_cached(app: &AppHandle, cached: CachedUpdate) {
    let cache = app.state::<UpdateCache>();
    match cache.0.lock() {
        Ok(mut guard) => *guard = Some(cached),
        Err(poisoned) => *poisoned.into_inner() = Some(cached),
    };
}

fn cached_version(app: &AppHandle) -> Option<String> {
    let cache = app.state::<UpdateCache>();
    let version = match cache.0.lock() {
        Ok(guard) => guard.as_ref().map(|c| c.update.version.clone()),
        Err(poisoned) => poisoned
            .into_inner()
            .as_ref()
            .map(|c| c.update.version.clone()),
    };
    version
}

#[tauri::command]
pub async fn download_update(app: AppHandle) -> Result<(), String> {
    if !endpoints_configured(&app) {
        return Err("尚未配置更新源".to_string());
    }
    if DOWNLOADING.swap(true, Ordering::SeqCst) {
        return Err("正在下载更新，请稍候".to_string());
    }
    // 失败必须复位，否则本次进程内再也无法重试
    let result = download_update_inner(&app).await;
    DOWNLOADING.store(false, Ordering::SeqCst);
    result
}

async fn download_update_inner(app: &AppHandle) -> Result<(), String> {
    let updater = build_updater(app)?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("检查更新失败: {e}"))?
        .ok_or_else(|| "当前已是最新版本".to_string())?;

    if cached_version(app).as_deref() == Some(update.version.as_str()) {
        return Ok(());
    }

    let mode = http::stored_config().mode;
    let url = update.download_url.clone();
    let mut last_error = String::new();
    let mut downloaded: Option<Vec<u8>> = None;
    // 线路逐条尝试：探测通过但下载中途失败时，继续走下一线路
    for kind in route_order(&mode) {
        let Some(client) = route_client(kind) else {
            continue;
        };
        let total = match probe_route(&client, &url).await {
            Ok(total) => total,
            Err(e) => {
                tracing::warn!("更新线路 {} 探测失败: {e}", kind.label());
                last_error = format!("{}: {e}", kind.label());
                continue;
            }
        };
        validate_range_total(total)?;

        tracing::warn!("更新下载线路已选：{}", kind.label());
        let progress = Arc::new(ProgressTracker::new(app.clone(), total, kind.label()));
        match download_with_route(&client, &url, total, progress).await {
            Ok(bytes) if bytes.len() as u64 == total => {
                downloaded = Some(bytes);
                break;
            }
            Ok(bytes) => {
                tracing::warn!(
                    "线路 {} 下载长度不符（{} / {total}）",
                    kind.label(),
                    bytes.len()
                );
                last_error = format!(
                    "{}: 下载不完整（{} / {total} 字节）",
                    kind.label(),
                    bytes.len()
                );
            }
            Err(e) => {
                tracing::warn!("线路 {} 下载失败: {e}", kind.label());
                last_error = format!("{}: {e}", kind.label());
            }
        }
    }
    let Some(bytes) = downloaded else {
        return Err(format!("更新下载失败（{last_error}）"));
    };
    update
        .verify(&bytes)
        .map_err(|e| format!("更新包校验失败: {e}"))?;

    {
        let cache = app.state::<UpdateCache>();
        let mut guard = match cache.0.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        *guard = Some(CachedUpdate {
            update,
            bytes: Arc::new(bytes),
        });
    }
    let _ = app.emit("update:downloaded", serde_json::json!({}));
    Ok(())
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    if !endpoints_configured(&app) {
        return Err("尚未配置更新源".to_string());
    }
    if DOWNLOADING.load(Ordering::SeqCst) {
        return Err("更新包还在下载中".to_string());
    }
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("正在安装更新，请稍候".to_string());
    }
    let Some(cached) = take_cached(&app) else {
        INSTALLING.store(false, Ordering::SeqCst);
        return Err("更新包尚未下载完成".to_string());
    };

    let update = cached.update.clone();
    let bytes = cached.bytes.clone();
    // Windows 上安装成功会直接退出进程；放到阻塞线程避免卡住 async 运行时
    let result =
        tauri::async_runtime::spawn_blocking(move || update.install(bytes.as_slice())).await;
    match result {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            restore_cached(&app, cached);
            INSTALLING.store(false, Ordering::SeqCst);
            tracing::warn!("安装更新失败: {e}");
            return Err(format!("安装更新失败: {e}"));
        }
        Err(e) => {
            restore_cached(&app, cached);
            INSTALLING.store(false, Ordering::SeqCst);
            return Err(format!("安装更新失败: {e}"));
        }
    }
    // Windows 正常到不了这里；其它平台需要主动重启才能运行新版本
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_ranges_covers_whole_file_without_overlap() {
        let ranges = split_ranges(10, 4);
        assert_eq!(ranges, vec![(0, 2), (3, 5), (6, 8), (9, 9)]);

        let single = split_ranges(1, 4);
        assert_eq!(single, vec![(0, 0)]);
        assert!(split_ranges(0, 4).is_empty());

        // 总长小于段数时每段至少 1 字节，且不产生越界区间
        let tiny = split_ranges(3, 8);
        assert_eq!(tiny, vec![(0, 0), (1, 1), (2, 2)]);
        for (start, end) in split_ranges(1_000_000, 4) {
            assert!(start <= end);
            assert!(end < 1_000_000);
        }
    }

    #[test]
    fn content_range_parsing_requires_explicit_total() {
        assert_eq!(parse_content_range("bytes 0-0/12345"), Some((0, 0, 12345)));
        assert_eq!(
            parse_content_range("bytes 100-199/1000"),
            Some((100, 199, 1000))
        );
        // `*` 总长、缺字段、乱码都不能当成有效响应
        assert_eq!(parse_content_range("bytes 0-0/*"), None);
        assert_eq!(parse_content_range("bytes 0-0"), None);
        assert_eq!(parse_content_range("garbage"), None);
    }

    #[test]
    fn route_order_follows_configured_proxy_mode() {
        assert_eq!(
            route_order(http::MODE_MANUAL),
            vec![RouteKind::Manual, RouteKind::System, RouteKind::Direct]
        );
        assert_eq!(
            route_order(http::MODE_SYSTEM),
            vec![RouteKind::System, RouteKind::Direct]
        );
        assert_eq!(
            route_order(http::MODE_DIRECT),
            vec![RouteKind::Direct, RouteKind::System]
        );
        // 未知取值按系统代理处理，不 panic
        assert_eq!(
            route_order("bogus"),
            vec![RouteKind::System, RouteKind::Direct]
        );
    }

    fn plugin_config_of(raw: &str) -> tauri_plugin_updater::Config {
        let root: serde_json::Value = serde_json::from_str(raw).expect("有效 JSON");
        serde_json::from_value(root["plugins"]["updater"].clone()).expect("插件配置能反序列化")
    }

    /// 配置写错会让应用启动即失败（插件初始化时解析），因此在门禁里先验一遍
    #[test]
    fn shipped_updater_config_parses_and_stays_offline() {
        let cfg = plugin_config_of(include_str!("../../tauri.conf.json"));
        assert!(cfg.endpoints.is_empty(), "基础配置不得内置更新端点");
        assert!(!cfg.pubkey.is_empty(), "pubkey 是必填项");
        assert!(!cfg.dangerous_insecure_transport_protocol);
    }

    #[test]
    fn updater_test_config_points_at_localhost() {
        let cfg = plugin_config_of(include_str!("../../tauri.updater-test.conf.json"));
        assert_eq!(cfg.endpoints.len(), 1);
        assert_eq!(
            cfg.endpoints[0].as_str(),
            "http://127.0.0.1:8787/latest.json"
        );
        assert!(cfg.dangerous_insecure_transport_protocol);
    }
}
