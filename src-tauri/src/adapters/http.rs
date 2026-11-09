//! 全局 HTTP 客户端与代理配置。
//!
//! 代理可在运行时切换：先构建新客户端，成功后再原子替换全局 `Arc`，
//! 在途请求持有旧 `Arc` 自然完成，不会因切换被中断。

use std::sync::{Arc, RwLock};

/// 代理设置存于 settings KV；不走通用白名单，只经 commands::network 读写。
pub const PROXY_SETTING_KEY: &str = "networkProxy";

pub const MODE_SYSTEM: &str = "system";
pub const MODE_DIRECT: &str = "direct";
pub const MODE_MANUAL: &str = "manual";

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub username: String,
    /// 代理密码密文（AES-256-GCM）；空串表示无密码
    #[serde(default)]
    pub password_enc: String,
    #[serde(default)]
    pub no_proxy: String,
}

fn default_mode() -> String {
    MODE_SYSTEM.to_string()
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            mode: default_mode(),
            url: String::new(),
            username: String::new(),
            password_enc: String::new(),
            no_proxy: String::new(),
        }
    }
}

impl ProxyConfig {
    pub fn validate(&self) -> Result<(), String> {
        match self.mode.as_str() {
            MODE_SYSTEM | MODE_DIRECT => Ok(()),
            MODE_MANUAL => {
                let raw = self.url.trim();
                if raw.is_empty() {
                    return Err("手动代理需要填写代理地址".into());
                }
                let parsed = reqwest::Url::parse(raw).map_err(|e| format!("代理地址无效: {e}"))?;
                if !matches!(parsed.scheme(), "http" | "https" | "socks5" | "socks5h") {
                    return Err(format!(
                        "代理地址只支持 http/https/socks5/socks5h，收到 {}",
                        parsed.scheme()
                    ));
                }
                if parsed.host_str().unwrap_or_default().is_empty() {
                    return Err("代理地址缺少主机名".into());
                }
                Ok(())
            }
            other => Err(format!("未知代理模式: {other}")),
        }
    }

    /// 读回设置；损坏或取值非法时回落到系统代理（启动不因配置损坏失败）。
    pub fn from_stored(raw: Option<&str>) -> Self {
        let Some(raw) = raw else {
            return Self::default();
        };
        match serde_json::from_str::<Self>(raw) {
            Ok(cfg) if cfg.validate().is_ok() => cfg,
            Ok(_) => {
                tracing::warn!("代理设置取值非法，本次按系统代理启动");
                Self::default()
            }
            Err(e) => {
                tracing::warn!("代理设置解析失败（{e}），本次按系统代理启动");
                Self::default()
            }
        }
    }
}

static CLIENT: RwLock<Option<Arc<reqwest::Client>>> = RwLock::new(None);
/// 图片下载专用客户端：与主客户端同代理配置，但重定向逐跳校验（防 SSRF）
static IMAGE_CLIENT: RwLock<Option<Arc<reqwest::Client>>> = RwLock::new(None);

/// 当前生效的客户端。首次访问时按系统代理解析并缓存。
///
/// D3/D4：构建失败必须上抛（带可读原因），不能在 release 下静默 abort。
pub(crate) fn current_client() -> Result<Arc<reqwest::Client>, String> {
    if let Some(client) = read_installed() {
        return Ok(client);
    }
    let client = Arc::new(build_generation_client(&ProxyConfig::default(), "")?);
    install(client.clone());
    Ok(client)
}

/// 图片下载客户端：沿用当前代理配置，但要求每一跳重定向都通过内网校验。
/// 构建失败时退回主客户端（首跳仍会被 `validate_remote_url` 拦截）。
pub(crate) fn image_client() -> Result<Arc<reqwest::Client>, String> {
    if let Some(client) = read_guard(&IMAGE_CLIENT) {
        return Ok(client);
    }
    let raw = crate::storage::get_setting(PROXY_SETTING_KEY)
        .ok()
        .flatten();
    let cfg = ProxyConfig::from_stored(raw.as_deref());
    let password = if cfg.mode == MODE_MANUAL {
        crate::storage::decrypt_secret(&cfg.password_enc).unwrap_or_default()
    } else {
        String::new()
    };
    let built = client_builder(&cfg, &password)
        .and_then(|builder| {
            builder
                .redirect(super::safe_redirect_policy())
                .build()
                .map_err(|e| e.to_string())
        })
        .map(Arc::new);
    match built {
        Ok(client) => {
            write_guard(&IMAGE_CLIENT, client.clone());
            Ok(client)
        }
        Err(e) => {
            tracing::warn!("图片下载客户端构建失败（{e}），退回主客户端");
            current_client()
        }
    }
}

fn read_installed() -> Option<Arc<reqwest::Client>> {
    read_guard(&CLIENT)
}

fn read_guard(slot: &RwLock<Option<Arc<reqwest::Client>>>) -> Option<Arc<reqwest::Client>> {
    match slot.read() {
        Ok(guard) => guard.clone(),
        // 写线程 panic 不应让整个应用再也不能发请求；恢复内部值继续用
        Err(poisoned) => poisoned.into_inner().clone(),
    }
}

fn write_guard(slot: &RwLock<Option<Arc<reqwest::Client>>>, client: Arc<reqwest::Client>) {
    match slot.write() {
        Ok(mut guard) => *guard = Some(client),
        Err(poisoned) => *poisoned.into_inner() = Some(client),
    }
}

/// 原子替换全局客户端。调用方必须先用 `build_client` 构建成功。
pub fn install(client: Arc<reqwest::Client>) {
    write_guard(&CLIENT, client);
    // 代理切换后图片下载客户端必须重建
    match IMAGE_CLIENT.write() {
        Ok(mut guard) => *guard = None,
        Err(poisoned) => *poisoned.into_inner() = None,
    }
}

fn client_builder(cfg: &ProxyConfig, password: &str) -> Result<reqwest::ClientBuilder, String> {
    cfg.validate()?;
    // 明确要求明文：压缩由 adapters::mod 兜底解码，避免中间层谎报编码时原始字节被丢弃
    let mut default_headers = reqwest::header::HeaderMap::new();
    default_headers.insert(
        reqwest::header::ACCEPT_ENCODING,
        reqwest::header::HeaderValue::from_static("identity"),
    );
    let mut builder = reqwest::Client::builder()
        // 连接超时与请求总超时分离：连不上要尽快失败，慢生成由请求级超时管
        .connect_timeout(std::time::Duration::from_secs(10))
        .default_headers(default_headers);
    match cfg.mode.as_str() {
        MODE_DIRECT => builder = builder.no_proxy(),
        MODE_MANUAL => {
            let mut proxy =
                reqwest::Proxy::all(cfg.url.trim()).map_err(|e| format!("代理地址无效: {e}"))?;
            if !cfg.username.trim().is_empty() {
                proxy = proxy.basic_auth(&cfg.username, password);
            }
            if !cfg.no_proxy.trim().is_empty() {
                proxy = proxy.no_proxy(reqwest::NoProxy::from_string(&cfg.no_proxy));
            }
            builder = builder.proxy(proxy);
        }
        // system：由 reqwest 的 system-proxy 特性读取系统/环境代理
        _ => {}
    }
    Ok(builder)
}

pub fn build_client(cfg: &ProxyConfig, password: &str) -> Result<reqwest::Client, String> {
    client_builder(cfg, password)?
        .build()
        .map_err(|e| format!("HTTP 客户端构建失败: {e}"))
}

/// 生成客户端：代理配置与主客户端一致，但不保留空闲连接。
///
/// reqwest 默认把空闲连接留在池里 90s。服务商 / 代理 / NAT 常更早单方面关闭
/// 连接且不通知客户端；下一次计费 POST 复用到这条死连接时，写出请求体就会
/// 收到 RST（Windows os error 10054）。`/images/edits` 的请求体是流式
/// multipart，hyper 无法安全重放，只能整次失败。生成请求间隔通常远大于连接
/// 存活期，重开 TLS 的代价远小于一次失败/重复计费风险。
pub fn build_generation_client(
    cfg: &ProxyConfig,
    password: &str,
) -> Result<reqwest::Client, String> {
    client_builder(cfg, password)?
        .pool_max_idle_per_host(0)
        .build()
        .map_err(|e| format!("HTTP 客户端构建失败: {e}"))
}

/// 把 `host` 固定到指定地址，绕过系统 DNS；TLS 仍按原域名校验证书。
/// 仅适用于受限网络下访问解析结果不可达的同名主机。
pub fn build_client_pinned(
    cfg: &ProxyConfig,
    password: &str,
    host: &str,
    addr: std::net::SocketAddr,
) -> Result<reqwest::Client, String> {
    client_builder(cfg, password)?
        .resolve(host, addr)
        .build()
        .map_err(|e| format!("HTTP 客户端构建失败: {e}"))
}

/// 已保存的代理配置（含密码密文）；备份导出只取其中的非密钥字段。
pub fn stored_config() -> ProxyConfig {
    let raw = crate::storage::get_setting(PROXY_SETTING_KEY)
        .ok()
        .flatten();
    ProxyConfig::from_stored(raw.as_deref())
}

/// 启动时应用已保存的代理配置；任何失败只落日志，不阻断启动。
pub fn init_from_storage() {
    let raw = match crate::storage::get_setting(PROXY_SETTING_KEY) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("读取代理设置失败（{e}），本次按系统代理启动");
            return;
        }
    };
    if raw.is_none() {
        return;
    }
    let cfg = ProxyConfig::from_stored(raw.as_deref());
    let password = match crate::storage::decrypt_secret(&cfg.password_enc) {
        Ok(p) => p,
        Err(e) => {
            // 密码解不出时不降级成「无密码代理」，否则会出现难以理解的 407
            tracing::warn!("代理密码解密失败（{e}），本次按系统代理启动");
            return;
        }
    };
    match build_generation_client(&cfg, &password) {
        Ok(client) => {
            install(Arc::new(client));
            tracing::warn!("已应用代理配置：{}", cfg.mode);
        }
        Err(e) => tracing::warn!("代理配置无效（{e}），本次按系统代理启动"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manual(url: &str) -> ProxyConfig {
        ProxyConfig {
            mode: MODE_MANUAL.into(),
            url: url.into(),
            ..Default::default()
        }
    }

    #[test]
    fn validate_accepts_three_modes() {
        for mode in [MODE_SYSTEM, MODE_DIRECT] {
            let cfg = ProxyConfig {
                mode: mode.into(),
                ..Default::default()
            };
            assert!(cfg.validate().is_ok(), "{mode} 应通过");
        }
        assert!(manual("http://127.0.0.1:7890").validate().is_ok());
        assert!(manual("https://proxy.example.com:8443").validate().is_ok());
        assert!(manual("socks5://127.0.0.1:1080").validate().is_ok());
        assert!(manual("socks5h://127.0.0.1:1080").validate().is_ok());
    }

    #[test]
    fn validate_rejects_bad_manual_url() {
        assert!(manual("").validate().is_err());
        assert!(manual("socks4://127.0.0.1:1080").validate().is_err());
        assert!(manual("not a url").validate().is_err());
        assert!(manual("http://127.0.0.1:99999").validate().is_err());
        let unknown = ProxyConfig {
            mode: "auto".into(),
            ..Default::default()
        };
        assert!(unknown.validate().is_err());
    }

    #[test]
    fn build_client_supports_all_modes() {
        for mode in [MODE_SYSTEM, MODE_DIRECT] {
            let cfg = ProxyConfig {
                mode: mode.into(),
                ..Default::default()
            };
            assert!(build_client(&cfg, "").is_ok(), "{mode} 应能构建");
        }
        let cfg = manual("http://127.0.0.1:7890");
        assert!(build_client(&cfg, "secret").is_ok());
    }

    #[test]
    fn build_client_pinned_accepts_direct_mode() {
        let cfg = ProxyConfig {
            mode: MODE_DIRECT.into(),
            ..Default::default()
        };
        let addr: std::net::SocketAddr = "140.82.112.3:443".parse().expect("地址有效");
        assert!(build_client_pinned(&cfg, "", "github.com", addr).is_ok());
        // 配置非法时仍然要报错，不能静默放过
        assert!(build_client_pinned(&manual(""), "", "github.com", addr).is_err());
    }

    #[test]
    fn from_stored_falls_back_to_system() {
        assert_eq!(ProxyConfig::from_stored(None).mode, MODE_SYSTEM);
        assert_eq!(
            ProxyConfig::from_stored(Some("{bad json")).mode,
            MODE_SYSTEM
        );
        assert_eq!(
            ProxyConfig::from_stored(Some(r#"{"mode":"manual","url":""}"#)).mode,
            MODE_SYSTEM
        );
        let ok = ProxyConfig::from_stored(Some(
            r#"{"mode":"manual","url":"http://127.0.0.1:7890","username":"u","passwordEnc":"x","noProxy":"localhost"}"#,
        ));
        assert_eq!(ok.mode, MODE_MANUAL);
        assert_eq!(ok.url, "http://127.0.0.1:7890");
        assert_eq!(ok.no_proxy, "localhost");
    }
}
