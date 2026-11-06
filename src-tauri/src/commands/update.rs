use crate::adapters::http;
use crate::storage;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Updater, UpdaterExt};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

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
/// 更新包大小上限：分段直接落盘，但仍限制总量，避免异常清单把磁盘写满
const MAX_UPDATE_BYTES: u64 = 300 * 1024 * 1024;
/// 中断下载的残留只有在超过该时长后才清理，避免误删正在进行的下载
const STALE_DOWNLOAD_AGE: Duration = Duration::from_secs(24 * 60 * 60);

const USER_AGENT: &str = concat!("moling/", env!("CARGO_PKG_VERSION"));

/// 单次清单请求与边缘探测的超时；检查阶段整体不超过 CHECK_TIMEOUT
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(3);
const EDGE_PROBE_TIMEOUT: Duration = Duration::from_secs(4);
/// 下载前探测各通道的总预算；真正下载不受此限制
const PROBE_BUDGET: Duration = Duration::from_secs(45);
/// 清单缓存有效期：过期后下载前重新获取，避免装到过旧版本
const MANIFEST_TTL: Duration = Duration::from_secs(30 * 60);
/// 清单只有几百字节，异常响应直接拒绝，避免拖爆内存
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

/// 镜像按 `{prefix}/{原始 github URL}` 转发；实测 gh-proxy 支持 Range
const MIRRORS: &[(&str, &str)] = &[
    ("gh-proxy.com", "https://gh-proxy.com"),
    ("ghfast.top", "https://ghfast.top"),
];

/// 系统 DNS 可能解析到当前网络不可达的节点，这里按实测可达性排序。
/// 与 scripts/lib/gh-net.mjs 的 KNOWN_EDGE_IPS 需人工保持一致。
const EDGE_IPS: &[&str] = &[
    "140.82.112.3",
    "140.82.113.3",
    "140.82.114.3",
    "20.201.28.151",
    "20.27.177.113",
    "4.237.22.38",
    "140.82.121.3",
    "20.205.243.166",
];

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChannelTag {
    Official,
    Edge,
    Mirror,
}

/// 一条待尝试的下载通道：通道 × 线路（边缘 IP 只有直连）
#[derive(Debug, Clone, PartialEq, Eq)]
struct PlanItem {
    tag: ChannelTag,
    label: String,
    url: reqwest::Url,
    route: RouteKind,
    /// 仅边缘 IP 通道：把 github.com 固定到该地址
    pin: Option<IpAddr>,
}

fn is_github_endpoint(url: &reqwest::Url) -> bool {
    url.host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case("github.com"))
}

/// 本地验收端点（127.0.0.1 / ::1 / localhost）不能走代理，也没有镜像/边缘可言
fn is_loopback(url: &reqwest::Url) -> bool {
    match url.host_str() {
        Some("localhost") => true,
        Some(host) => host
            .parse::<IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false),
        None => false,
    }
}

fn mirror_url(prefix: &str, url: &reqwest::Url) -> Option<reqwest::Url> {
    let joined = format!("{}/{}", prefix.trim_end_matches('/'), url.as_str());
    reqwest::Url::parse(&joined).ok()
}

fn dedupe_ips(raw: &[&str]) -> Vec<IpAddr> {
    let mut out = Vec::new();
    for text in raw {
        let Ok(ip) = text.trim().parse::<IpAddr>() else {
            continue;
        };
        if !out.contains(&ip) {
            out.push(ip);
        }
    }
    out
}

fn routes_for(url: &reqwest::Url, mode: &str) -> Vec<RouteKind> {
    if is_loopback(url) {
        vec![RouteKind::Direct]
    } else {
        route_order(mode)
    }
}

/// 候选顺序：官方 → 边缘 IP → 镜像；非 github 端点只有官方。
fn download_plan(url: &reqwest::Url, mode: &str) -> Vec<PlanItem> {
    let routes = routes_for(url, mode);
    let mut plan = Vec::new();
    for route in routes.iter().copied() {
        plan.push(PlanItem {
            tag: ChannelTag::Official,
            label: format!("官方({})", route.label()),
            url: url.clone(),
            route,
            pin: None,
        });
    }
    if !is_github_endpoint(url) {
        return plan;
    }
    for ip in dedupe_ips(EDGE_IPS) {
        plan.push(PlanItem {
            tag: ChannelTag::Edge,
            label: format!("边缘IP {ip}"),
            url: url.clone(),
            // 走代理时目标域名由代理解析，`.resolve` 不会生效
            route: RouteKind::Direct,
            pin: Some(ip),
        });
    }
    for (name, prefix) in MIRRORS {
        let Some(mirror) = mirror_url(prefix, url) else {
            continue;
        };
        // 镜像本身就是为了绕开坏链路，前两条线路已足够
        for route in routes.iter().copied().take(2) {
            plan.push(PlanItem {
                tag: ChannelTag::Mirror,
                label: format!("镜像 {name}({})", route.label()),
                url: mirror.clone(),
                route,
                pin: None,
            });
        }
    }
    plan
}

fn summarize_manifest_failure(attempts: &[String]) -> String {
    if attempts.is_empty() {
        return "获取更新清单失败：没有可用通道；如网络受限，请到「设置 → 网络」启用代理后重试"
            .to_string();
    }
    let detail = attempts
        .iter()
        .take(3)
        .cloned()
        .collect::<Vec<_>>()
        .join("；");
    let suffix = if attempts.len() > 3 {
        format!("…（共 {} 条通道）", attempts.len())
    } else {
        String::new()
    };
    format!("获取更新清单失败：{detail}{suffix}；如网络受限，请到「设置 → 网络」启用代理后重试")
}

fn summarize_download_failure(attempts: &[String]) -> String {
    let mut lines = vec![format!("更新下载失败：已尝试 {} 条通道", attempts.len())];
    if attempts.is_empty() {
        lines.push("  · 没有可用通道".to_string());
    } else {
        for attempt in attempts.iter().take(5) {
            lines.push(format!("  · {attempt}"));
        }
        if attempts.len() > 5 {
            lines.push(format!("  · 其余 {} 条略", attempts.len() - 5));
        }
    }
    lines.push("如网络受限，请到「设置 → 网络」启用代理后重试。".to_string());
    lines.join("\n")
}

/// 直连客户端：边缘 IP 通道专用，不叠加用户代理
fn direct_config() -> http::ProxyConfig {
    http::ProxyConfig {
        mode: http::MODE_DIRECT.into(),
        ..Default::default()
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

fn configured_endpoint(app: &AppHandle) -> Result<reqwest::Url, String> {
    let raw = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("endpoints"))
        .and_then(|v| v.as_array())
        .and_then(|list| list.first())
        .and_then(|v| v.as_str())
        .ok_or_else(|| "尚未配置更新源".to_string())?;
    reqwest::Url::parse(raw).map_err(|e| format!("更新源地址无效: {e}"))
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

async fn fetch_manifest_once(
    client: &reqwest::Client,
    url: &reqwest::Url,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let mut response = client
        .get(url.clone())
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .header(reqwest::header::ACCEPT, "application/json")
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| format!("连接失败: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    if response
        .content_length()
        .is_some_and(|len| len > MAX_MANIFEST_BYTES)
    {
        return Err("更新清单异常（超出大小上限）".into());
    }
    let mut data = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("读取清单失败: {e}"))?
    {
        data.extend_from_slice(&chunk);
        if data.len() as u64 > MAX_MANIFEST_BYTES {
            return Err("更新清单异常（超出大小上限）".into());
        }
    }
    serde_json::from_slice(&data).map_err(|e| format!("清单格式无效: {e}"))
}

/// 并发探测边缘 IP，首个能取回清单的直接返回；其余探测立即取消。
async fn fetch_manifest_edges(
    endpoint: &reqwest::Url,
    timeout: Duration,
) -> Option<(serde_json::Value, String)> {
    let mut set = tokio::task::JoinSet::new();
    for ip in dedupe_ips(EDGE_IPS) {
        let url = endpoint.clone();
        set.spawn(async move {
            let client = http::build_client_pinned(
                &direct_config(),
                "",
                "github.com",
                SocketAddr::new(ip, 443),
            )
            .ok()?;
            let raw = fetch_manifest_once(&client, &url, timeout).await.ok()?;
            Some((ip, raw))
        });
    }
    while let Some(joined) = set.join_next().await {
        if let Ok(Some((ip, raw))) = joined {
            set.abort_all();
            return Some((raw, format!("边缘IP {ip}")));
        }
    }
    None
}

/// 按线路尝试一次清单请求；失败原因写入 attempts，供最终错误文案使用。
async fn try_manifest(
    label: &str,
    url: &reqwest::Url,
    route: RouteKind,
    deadline: Instant,
    attempts: &mut Vec<String>,
) -> Option<(serde_json::Value, String)> {
    let Some(client) = route_client(route) else {
        attempts.push(format!("{label}({}): 线路不可用", route.label()));
        return None;
    };
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return None;
    }
    match fetch_manifest_once(&client, url, MANIFEST_TIMEOUT.min(remaining)).await {
        Ok(raw) => Some((raw, format!("{label}({})", route.label()))),
        Err(e) => {
            attempts.push(format!("{label}({}): {e}", route.label()));
            None
        }
    }
}

/// 清单获取通道阶梯：官方（尊重用户代理）→ 边缘 IP（仅直连）→ 镜像。
async fn fetch_manifest_ladder(
    endpoint: &reqwest::Url,
    mode: &str,
) -> Result<(serde_json::Value, String, Vec<String>), String> {
    let deadline = Instant::now() + CHECK_TIMEOUT;
    let mut attempts = Vec::new();
    let routes = routes_for(endpoint, mode);

    for route in routes.iter().copied() {
        if Instant::now() >= deadline {
            break;
        }
        if let Some((raw, source)) =
            try_manifest("官方", endpoint, route, deadline, &mut attempts).await
        {
            return Ok((raw, source, attempts));
        }
    }

    let github = is_github_endpoint(endpoint);
    if github && Instant::now() < deadline {
        let timeout = EDGE_PROBE_TIMEOUT.min(deadline.saturating_duration_since(Instant::now()));
        match fetch_manifest_edges(endpoint, timeout).await {
            Some((raw, source)) => return Ok((raw, source, attempts)),
            None => attempts.push(format!("边缘IP×{}", dedupe_ips(EDGE_IPS).len())),
        }
    }

    if github {
        for (name, prefix) in MIRRORS {
            let label = format!("镜像 {name}");
            let Some(url) = mirror_url(prefix, endpoint) else {
                continue;
            };
            for route in routes.iter().copied().take(2) {
                if Instant::now() >= deadline {
                    attempts.push(format!("{label}: 预算耗尽未尝试"));
                    break;
                }
                if let Some((raw, source)) =
                    try_manifest(&label, &url, route, deadline, &mut attempts).await
                {
                    return Ok((raw, source, attempts));
                }
            }
        }
    }

    Err(summarize_manifest_failure(&attempts))
}

/// 上传进度：分段计数分开累加，重试/回退时可精确回滚，不会出现进度倒退或超 100%。
struct ProgressTracker {
    handle: AppHandle,
    total: u64,
    route: String,
    started: Instant,
    /// 0 号槽位给单连接，1..=PARALLEL_PARTS 给各分段
    counters: Vec<AtomicU64>,
    done: AtomicBool,
}

impl ProgressTracker {
    fn new(handle: AppHandle, total: u64, route: impl Into<String>) -> Self {
        Self {
            handle,
            total,
            route: route.into(),
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

/// 更新包落盘目录：放在系统缓存目录，便于启动时按年龄清理
fn updates_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("无法确定更新缓存目录: {e}"))?
        .join("updates");
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建更新缓存目录: {e}"))?;
    Ok(dir)
}

/// 版本号来自远端清单，不能直接拼进路径
fn safe_file_component(raw: &str) -> String {
    raw.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// 启动时清理中断下载留下的半成品；只删超过 24h 的文件，避免误伤正在下载的包
pub fn cleanup_stale_downloads(app: &AppHandle) {
    let Ok(dir) = app.path().app_cache_dir().map(|p| p.join("updates")) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let expired = entry
            .metadata()
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > STALE_DOWNLOAD_AGE);
        if expired && std::fs::remove_file(&path).is_ok() {
            tracing::warn!("已清理过期的更新下载残留: {}", path.display());
        }
    }
}

/// 失败路径统一把进度归零，避免界面停在半截进度条
fn reset_progress(app: &AppHandle) {
    let _ = app.emit(
        "update:progress",
        serde_json::json!({
            "downloaded": 0,
            "total": 0,
            "speed": 0,
            "route": "",
        }),
    );
}

async fn open_part(path: &Path, start: u64) -> Result<tokio::fs::File, String> {
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .await
        .map_err(|e| format!("打开临时文件失败: {e}"))?;
    file.seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(|e| format!("定位临时文件失败: {e}"))?;
    Ok(file)
}

async fn fetch_range(
    client: &reqwest::Client,
    url: &reqwest::Url,
    (start, end): (u64, u64),
    total: u64,
    progress: &ProgressTracker,
    slot: usize,
    path: &Path,
) -> Result<(), String> {
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

    let expected = end - start + 1;
    let mut file = open_part(path, start).await?;
    let mut written = 0u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("读取分段失败: {e}"))?
    {
        written += chunk.len() as u64;
        if written > expected {
            return Err("分段数据超出预期长度".into());
        }
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("写入临时文件失败: {e}"))?;
        progress.add(slot, chunk.len() as u64);
    }
    if written != expected {
        return Err(format!("分段数据不完整（{written} / {expected}）"));
    }
    Ok(())
}

async fn download_parallel(
    client: &reqwest::Client,
    url: &reqwest::Url,
    total: u64,
    progress: Arc<ProgressTracker>,
    path: PathBuf,
) -> Result<(), String> {
    let ranges = split_ranges(total, PARALLEL_PARTS);
    let mut handles = Vec::with_capacity(ranges.len());
    for (index, (start, end)) in ranges.iter().copied().enumerate() {
        let client = client.clone();
        let url = url.clone();
        let progress = progress.clone();
        let path = path.clone();
        let slot = index + 1;
        handles.push(tauri::async_runtime::spawn(async move {
            let mut last = String::new();
            for attempt in 0..2 {
                match fetch_range(&client, &url, (start, end), total, &progress, slot, &path).await
                {
                    Ok(()) => return Ok(()),
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

    let mut error = None;
    for handle in handles {
        match handle.await {
            Ok(Ok(())) => {}
            Ok(Err((index, e))) => {
                error.get_or_insert(format!("第 {} 段: {e}", index + 1));
            }
            Err(e) => {
                error.get_or_insert(format!("下载线程异常: {e}"));
            }
        }
    }
    match error {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

async fn download_single(
    client: &reqwest::Client,
    url: &reqwest::Url,
    total: u64,
    progress: &ProgressTracker,
    path: &Path,
) -> Result<(), String> {
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
    // 多线程失败回退时文件里可能已有半截数据，先清空再顺序写
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(path)
        .await
        .map_err(|e| format!("打开临时文件失败: {e}"))?;
    file.set_len(total)
        .await
        .map_err(|e| format!("预分配临时文件失败: {e}"))?;
    let mut written = 0u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("读取下载数据失败: {e}"))?
    {
        written += chunk.len() as u64;
        if written > total || written > MAX_UPDATE_BYTES {
            return Err("更新包超出大小上限，已中止下载".into());
        }
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("写入临时文件失败: {e}"))?;
        progress.add(0, chunk.len() as u64);
    }
    Ok(())
}

async fn download_with_route(
    client: &reqwest::Client,
    url: &reqwest::Url,
    total: u64,
    progress: Arc<ProgressTracker>,
    path: &Path,
) -> Result<(), String> {
    let monitor = spawn_progress_monitor(progress.clone());
    let result = if total >= MIN_PARALLEL_BYTES {
        match download_parallel(client, url, total, progress.clone(), path.to_path_buf()).await {
            Ok(()) => Ok(()),
            Err(e) => {
                tracing::warn!("多线程下载失败（{e}），回退单连接");
                progress.reset_all();
                download_single(client, url, total, &progress, path).await
            }
        }
    } else {
        download_single(client, url, total, &progress, path).await
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

/// 边缘 IP 组并发探测：先确认哪些可达，再串行下载，避免同时开多条下载连接。
async fn probe_edge_group(
    items: &[PlanItem],
    timeout: Duration,
) -> Vec<(String, reqwest::Client, reqwest::Url, u64)> {
    let mut set = tokio::task::JoinSet::new();
    for item in items {
        let Some(ip) = item.pin else {
            continue;
        };
        let label = item.label.clone();
        let url = item.url.clone();
        set.spawn(async move {
            let client = http::build_client_pinned(
                &direct_config(),
                "",
                "github.com",
                SocketAddr::new(ip, 443),
            )
            .ok()?;
            let total = tokio::time::timeout(timeout, probe_route(&client, &url))
                .await
                .ok()?
                .ok()?;
            Some((label, client, url, total))
        });
    }

    let mut reached = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(Some(item)) = joined {
            reached.push(item);
        }
    }
    reached
}

async fn download_with_client(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &reqwest::Url,
    total: u64,
    label: &str,
    path: &Path,
) -> Result<(), String> {
    validate_range_total(total)?;
    {
        let file = tokio::fs::File::create(path)
            .await
            .map_err(|e| format!("创建临时文件失败: {e}"))?;
        file.set_len(total)
            .await
            .map_err(|e| format!("预分配临时文件失败: {e}"))?;
    }
    let progress = Arc::new(ProgressTracker::new(app.clone(), total, label));
    download_with_route(client, url, total, progress, path).await?;
    let written = tokio::fs::metadata(path)
        .await
        .map_err(|e| format!("读取临时文件失败: {e}"))?
        .len();
    if written == total {
        Ok(())
    } else {
        Err(format!("下载不完整（{written} / {total} 字节）"))
    }
}

async fn try_download(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &reqwest::Url,
    label: &str,
    path: &Path,
) -> Result<(), String> {
    let total = probe_route(client, url).await?;
    download_with_client(app, client, url, total, label, path).await
}

/// 下载完成后先 fsync 再 rename：中断只会留下 `.tmp`，不会出现“看起来完整”的半包
async fn finalize_download(tmp: &Path, final_path: &Path) -> Result<(), String> {
    let file = tokio::fs::OpenOptions::new()
        .write(true)
        .open(tmp)
        .await
        .map_err(|e| format!("打开临时文件失败: {e}"))?;
    file.sync_all()
        .await
        .map_err(|e| format!("刷新临时文件失败: {e}"))?;
    drop(file);
    // Windows 上 rename 不覆盖已存在文件
    let _ = tokio::fs::remove_file(final_path).await;
    tokio::fs::rename(tmp, final_path)
        .await
        .map_err(|e| format!("保存更新包失败: {e}"))
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

    let endpoint = configured_endpoint(&app)?;
    let mode = http::stored_config().mode;
    let (raw, source, _) = match fetch_manifest_ladder(&endpoint, &mode).await {
        Ok(hit) => hit,
        // 检查失败（离线、更新源不可达）不是致命错误：前端要显示原因但保留重试入口
        Err(e) => {
            return Ok(UpdateStatus {
                current_version,
                configured: true,
                available: None,
                error: Some(e),
            })
        }
    };
    tracing::warn!("更新清单获取成功，来源：{source}");

    let updater = build_updater(&app)?;
    match updater.restore_update(raw.clone()) {
        Ok(Some(update)) => {
            store_manifest(&app, raw, &update.version, &source);
            Ok(UpdateStatus {
                current_version,
                configured: true,
                available: Some(AvailableUpdate {
                    version: update.version.clone(),
                    notes: update.body.clone(),
                    date: date_of(&update.raw_json),
                }),
                error: None,
            })
        }
        Ok(None) => {
            // 已是最新：旧清单不能再用于下载，否则可能装到过旧版本
            clear_manifest(&app);
            Ok(UpdateStatus {
                current_version,
                configured: true,
                available: None,
                error: None,
            })
        }
        Err(e) => Ok(UpdateStatus {
            current_version,
            configured: true,
            available: None,
            error: Some(format!("更新清单无效：{e}")),
        }),
    }
}

/// 最近一次成功获取的清单；下载阶段据此还原 Update，不再联网
#[derive(Clone)]
struct CachedManifest {
    raw_json: serde_json::Value,
    version: String,
    source: String,
    saved_at: Instant,
}

/// 已下载校验通过的更新包；安装阶段直接用它，不再联网。
struct CachedUpdate {
    update: tauri_plugin_updater::Update,
    bytes: Arc<Vec<u8>>,
}

#[derive(Default)]
struct UpdateCacheInner {
    manifest: Option<CachedManifest>,
    ready: Option<CachedUpdate>,
}

#[derive(Default)]
pub struct UpdateCache(Mutex<UpdateCacheInner>);

impl UpdateCache {
    /// 锁中毒时继续用内部值：缓存损坏不应让整个进程再也无法检查或安装更新
    fn with<R>(&self, f: impl FnOnce(&mut UpdateCacheInner) -> R) -> R {
        match self.0.lock() {
            Ok(mut guard) => f(&mut guard),
            Err(poisoned) => f(&mut poisoned.into_inner()),
        }
    }
}

fn store_manifest(app: &AppHandle, raw_json: serde_json::Value, version: &str, source: &str) {
    let cache = app.state::<UpdateCache>();
    cache.with(|inner| {
        inner.manifest = Some(CachedManifest {
            raw_json,
            version: version.to_string(),
            source: source.to_string(),
            saved_at: Instant::now(),
        });
        // 清单版本变了，之前下好的包不能再用于安装
        if inner
            .ready
            .as_ref()
            .is_some_and(|cached| cached.update.version != version)
        {
            inner.ready = None;
        }
    });
}

fn load_manifest(app: &AppHandle) -> Option<CachedManifest> {
    let cache = app.state::<UpdateCache>();
    cache.with(|inner| inner.manifest.clone())
}

fn clear_manifest(app: &AppHandle) {
    let cache = app.state::<UpdateCache>();
    cache.with(|inner| inner.manifest = None);
}

fn take_cached(app: &AppHandle) -> Option<CachedUpdate> {
    let cache = app.state::<UpdateCache>();
    cache.with(|inner| inner.ready.take())
}

fn restore_cached(app: &AppHandle, cached: CachedUpdate) {
    let cache = app.state::<UpdateCache>();
    cache.with(|inner| inner.ready = Some(cached));
}

fn cached_version(app: &AppHandle) -> Option<String> {
    let cache = app.state::<UpdateCache>();
    cache.with(|inner| {
        inner
            .ready
            .as_ref()
            .map(|cached| cached.update.version.clone())
    })
}

#[tauri::command]
pub async fn download_update(app: AppHandle) -> Result<(), String> {
    if !endpoints_configured(&app) {
        return Err("尚未配置更新源".to_string());
    }
    // 安装阶段会读内存缓存，两边同时进行会拿到被清掉的包
    if INSTALLING.load(Ordering::SeqCst) {
        return Err("正在安装更新，无法同时下载".to_string());
    }
    if DOWNLOADING.swap(true, Ordering::SeqCst) {
        return Err("正在下载更新，请稍候".to_string());
    }
    // 失败必须复位，否则本次进程内再也无法重试
    let result = download_update_inner(&app).await;
    DOWNLOADING.store(false, Ordering::SeqCst);
    if let Err(e) = &result {
        reset_progress(&app);
        tracing::warn!("更新下载失败: {e}");
    }
    result
}

fn verify_failure(err: &tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error as UpdaterError;
    match err {
        UpdaterError::SignedVersionMismatch { signed, announced } => format!(
            "更新包签名版本（{signed}）与清单版本（{announced}）不一致，可能被篡改，已拒绝安装"
        ),
        UpdaterError::MissingSignedVersion => {
            "更新包签名不含版本信息（旧构建产物），请用新版 Tauri CLI 重新构建发布".to_string()
        }
        other => format!("更新包校验失败: {other}"),
    }
}

async fn download_update_inner(app: &AppHandle) -> Result<(), String> {
    let updater = build_updater(app)?;
    let mode = http::stored_config().mode;

    // 优先复用最近一次检查的清单：网络抖动不应该在点「下载」时再失败一次
    let cached = load_manifest(app).filter(|manifest| manifest.saved_at.elapsed() < MANIFEST_TTL);
    let (raw, source) = match cached {
        Some(manifest) => {
            tracing::warn!(
                "复用缓存清单 v{}，来源：{}",
                manifest.version,
                manifest.source
            );
            (manifest.raw_json, manifest.source)
        }
        None => {
            let endpoint = configured_endpoint(app)?;
            let (raw, source, _) = fetch_manifest_ladder(&endpoint, &mode)
                .await
                .map_err(|e| format!("获取更新信息失败：{e}"))?;
            (raw, source)
        }
    };

    let update = match updater.restore_update(raw) {
        Ok(Some(update)) => update,
        Ok(None) => return Err("当前已是最新版本".to_string()),
        Err(e) => return Err(format!("更新清单无效：{e}")),
    };
    store_manifest(app, update.raw_json.clone(), &update.version, &source);

    if cached_version(app).as_deref() == Some(update.version.as_str()) {
        return Ok(());
    }

    let plan = download_plan(&update.download_url, &mode);
    let deadline = Instant::now() + PROBE_BUDGET;
    let mut attempts = Vec::new();
    let mut downloaded = false;
    let mut edge_done = false;

    // 下载直接写入临时文件：避免「分段 Vec + 拼接」造成 2 倍内存峰值
    let dir = updates_dir(app)?;
    let component = safe_file_component(&update.version);
    let tmp_path = dir.join(format!("moling-update-{component}.pkg.tmp"));
    let final_path = dir.join(format!("moling-update-{component}.pkg"));
    let _ = tokio::fs::remove_file(&tmp_path).await;

    for item in &plan {
        if Instant::now() >= deadline {
            attempts.push("剩余通道因探测超时未尝试".to_string());
            break;
        }

        if item.tag == ChannelTag::Edge {
            if edge_done {
                continue;
            }
            edge_done = true;
            let edges: Vec<PlanItem> = plan
                .iter()
                .filter(|entry| entry.tag == ChannelTag::Edge)
                .cloned()
                .collect();
            let remaining = deadline.saturating_duration_since(Instant::now());
            let reached = probe_edge_group(&edges, PROBE_TIMEOUT.min(remaining)).await;
            if reached.is_empty() {
                attempts.push(format!("边缘IP×{}", edges.len()));
            }
            for (label, client, url, total) in reached {
                match download_with_client(app, &client, &url, total, &label, &tmp_path).await {
                    Ok(()) => {
                        downloaded = true;
                        break;
                    }
                    Err(e) => {
                        tracing::warn!("{label} 下载失败: {e}");
                        attempts.push(format!("{label}: {e}"));
                    }
                }
            }
            if downloaded {
                break;
            }
            continue;
        }

        let Some(client) = route_client(item.route) else {
            continue;
        };
        match try_download(app, &client, &item.url, &item.label, &tmp_path).await {
            Ok(()) => {
                downloaded = true;
                break;
            }
            Err(e) => {
                tracing::warn!("{} 下载失败: {e}", item.label);
                attempts.push(format!("{}: {e}", item.label));
            }
        }
    }

    if !downloaded {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(summarize_download_failure(&attempts));
    }
    if let Err(e) = finalize_download(&tmp_path, &final_path).await {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(e);
    }
    let bytes = match tokio::fs::read(&final_path).await {
        Ok(bytes) => bytes,
        Err(e) => {
            let _ = tokio::fs::remove_file(&final_path).await;
            return Err(format!("读取更新包失败: {e}"));
        }
    };
    // 安装使用内存副本，磁盘上不保留整包
    let _ = tokio::fs::remove_file(&final_path).await;
    update.verify(&bytes).map_err(|e| verify_failure(&e))?;

    let cache = app.state::<UpdateCache>();
    cache.with(|inner| {
        inner.ready = Some(CachedUpdate {
            update,
            bytes: Arc::new(bytes),
        })
    });
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
            reset_progress(&app);
            tracing::warn!("安装更新失败: {e}");
            return Err(format!("安装更新失败: {e}"));
        }
        Err(e) => {
            restore_cached(&app, cached);
            INSTALLING.store(false, Ordering::SeqCst);
            reset_progress(&app);
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

    fn parse(url: &str) -> reqwest::Url {
        url.parse().expect("url 有效")
    }

    #[test]
    fn github_endpoint_detection_is_exact_host() {
        assert!(is_github_endpoint(&parse(
            "https://github.com/2426758093/moling/releases/latest/download/latest.json"
        )));
        assert!(!is_github_endpoint(&parse(
            "https://cdn.github.com/latest.json"
        )));
        assert!(!is_github_endpoint(&parse(
            "http://127.0.0.1:8787/latest.json"
        )));
        assert!(is_loopback(&parse("http://127.0.0.1:8787/latest.json")));
        assert!(is_loopback(&parse("http://localhost:8787/latest.json")));
        assert!(!is_loopback(&parse("https://gh-proxy.com/x")));
    }

    #[test]
    fn mirror_url_keeps_path_and_query() {
        let url = parse("https://github.com/o/r/releases/download/v1/latest.json?x=1");
        let mirror = mirror_url("https://gh-proxy.com/", &url).expect("可改写");
        assert_eq!(
            mirror.as_str(),
            "https://gh-proxy.com/https://github.com/o/r/releases/download/v1/latest.json?x=1"
        );
    }

    #[test]
    fn dedupe_ips_preserves_order_and_drops_invalid() {
        let ips = dedupe_ips(&["1.2.3.4", "bad", "1.2.3.4", "5.6.7.8", " "]);
        assert_eq!(ips.len(), 2);
        assert_eq!(ips[0].to_string(), "1.2.3.4");
        assert_eq!(ips[1].to_string(), "5.6.7.8");
    }

    #[test]
    fn routes_for_loopback_is_direct_only() {
        // 本地验收端点不能被系统代理接管
        assert_eq!(
            routes_for(
                &parse("http://127.0.0.1:8787/latest.json"),
                http::MODE_SYSTEM
            ),
            vec![RouteKind::Direct]
        );
        assert_eq!(
            routes_for(&parse("https://github.com/x"), http::MODE_DIRECT),
            vec![RouteKind::Direct, RouteKind::System]
        );
    }

    #[test]
    fn download_plan_orders_official_edge_mirror() {
        let url = parse(
            "https://github.com/2426758093/moling/releases/download/v1.2.1/moling_1.2.1_x64-setup.exe",
        );
        let plan = download_plan(&url, http::MODE_DIRECT);
        let official_last = plan
            .iter()
            .rposition(|item| item.tag == ChannelTag::Official)
            .expect("包含官方通道");
        let edge_first = plan
            .iter()
            .position(|item| item.tag == ChannelTag::Edge)
            .expect("包含边缘通道");
        let mirror_first = plan
            .iter()
            .position(|item| item.tag == ChannelTag::Mirror)
            .expect("包含镜像通道");
        assert!(official_last < edge_first && edge_first < mirror_first);

        let edge = &plan[edge_first];
        assert_eq!(edge.route, RouteKind::Direct);
        assert!(edge.pin.is_some());
        assert!(plan[mirror_first]
            .url
            .as_str()
            .starts_with("https://gh-proxy.com/https://github.com/"));
    }

    #[test]
    fn download_plan_for_localhost_has_no_edge_or_mirror() {
        let plan = download_plan(
            &parse("http://127.0.0.1:8787/moling.exe"),
            http::MODE_SYSTEM,
        );
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].tag, ChannelTag::Official);
        assert_eq!(plan[0].route, RouteKind::Direct);
    }

    #[test]
    fn failure_summaries_stay_actionable() {
        let attempts = vec![
            "官方(直连): 连接失败".to_string(),
            "镜像 gh-proxy.com(系统网络): 读取超时".to_string(),
        ];
        let single = summarize_manifest_failure(&attempts);
        assert!(single.contains("官方(直连)"));
        assert!(single.contains("设置 → 网络"));
        assert!(!single.contains('\n'));

        let multi = summarize_download_failure(&attempts);
        assert!(multi.contains("已尝试 2 条通道"));
        assert!(multi.contains("\n  · "));
        assert!(multi.contains("设置 → 网络"));
    }

    /// 起一个只响应一次的本地 HTTP 服务，避免测试依赖外网
    fn serve_once(response: &'static str) -> reqwest::Url {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("绑定本地端口");
        let addr = listener.local_addr().expect("本地地址");
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(response.as_bytes());
            }
        });
        parse(&format!("http://{addr}/latest.json"))
    }

    #[test]
    fn fetch_manifest_once_parses_json() {
        let url = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}",
        );
        let value = tauri::async_runtime::block_on(fetch_manifest_once(
            &reqwest::Client::new(),
            &url,
            Duration::from_secs(5),
        ))
        .expect("应解析成功");
        assert_eq!(value["ok"], serde_json::json!(true));
    }

    #[test]
    fn fetch_manifest_once_rejects_http_error() {
        let url = serve_once(
            "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        let err = tauri::async_runtime::block_on(fetch_manifest_once(
            &reqwest::Client::new(),
            &url,
            Duration::from_secs(5),
        ))
        .expect_err("500 应报错");
        assert!(err.contains("HTTP 500"), "{err}");
    }

    #[test]
    fn fetch_manifest_once_rejects_oversize() {
        let url =
            serve_once("HTTP/1.1 200 OK\r\nContent-Length: 2000000\r\nConnection: close\r\n\r\n");
        let err = tauri::async_runtime::block_on(fetch_manifest_once(
            &reqwest::Client::new(),
            &url,
            Duration::from_secs(5),
        ))
        .expect_err("超大清单应报错");
        assert!(err.contains("超出大小上限"), "{err}");
    }

    /// 版本号来自远端清单，拼接文件名时不能带出路径分隔符
    #[test]
    fn version_component_cannot_escape_cache_dir() {
        assert_eq!(safe_file_component("1.2.3"), "1.2.3");
        for raw in ["../../evil", r"..\..\evil", "a/b", "1.0 beta"] {
            let name = safe_file_component(raw);
            assert!(!name.contains('/'), "{name}");
            assert!(!name.contains('\\'), "{name}");
        }
    }

    #[test]
    fn finalize_download_atomically_replaces_target() {
        let dir = std::env::temp_dir().join(format!("moling-update-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let tmp = dir.join("pkg.tmp");
        let target = dir.join("pkg");
        std::fs::write(&tmp, b"new payload").unwrap();
        std::fs::write(&target, b"old").unwrap();

        tauri::async_runtime::block_on(finalize_download(&tmp, &target)).unwrap();

        assert!(!tmp.exists(), "临时文件应已重命名");
        assert_eq!(std::fs::read(&target).unwrap(), b"new payload");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
