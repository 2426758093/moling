use crate::adapters::http::{self, ProxyConfig};
use crate::storage;
use std::sync::Arc;
use std::time::{Duration, Instant};

const PROXY_TEST_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyInput {
    pub mode: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub username: String,
    /// `None` = 保持已保存密码；`Some("")` = 清除密码；`Some(p)` = 设置新密码
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub no_proxy: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyView {
    pub mode: String,
    pub url: String,
    pub username: String,
    pub has_password: bool,
    pub no_proxy: String,
}

fn view_of(cfg: &ProxyConfig) -> ProxyView {
    ProxyView {
        mode: cfg.mode.clone(),
        url: cfg.url.clone(),
        username: cfg.username.clone(),
        has_password: !cfg.password_enc.is_empty(),
        no_proxy: cfg.no_proxy.clone(),
    }
}

fn load_stored() -> Result<ProxyConfig, String> {
    Ok(ProxyConfig::from_stored(
        storage::get_setting(http::PROXY_SETTING_KEY)?.as_deref(),
    ))
}

/// 把表单与已存密文合并成待保存配置，返回 (配置, 明文密码)。
/// 密码只在本函数内解密，调用方不得把它写进日志。
fn resolve(input: &ProxyInput, stored: &ProxyConfig) -> Result<(ProxyConfig, String), String> {
    let mut cfg = ProxyConfig {
        mode: input.mode.trim().to_string(),
        url: input.url.trim().to_string(),
        username: input.username.trim().to_string(),
        password_enc: stored.password_enc.clone(),
        no_proxy: input.no_proxy.trim().to_string(),
    };
    cfg.validate()?;
    let password = match input.password.as_deref() {
        Some("") => {
            cfg.password_enc.clear();
            String::new()
        }
        Some(p) => {
            cfg.password_enc = storage::encrypt_secret(p)?;
            p.to_string()
        }
        None => storage::decrypt_secret(&cfg.password_enc)
            .map_err(|e| format!("已保存的代理密码无法解密，请重新填写: {e}"))?,
    };
    Ok((cfg, password))
}

#[tauri::command]
pub async fn get_proxy_config() -> Result<ProxyView, String> {
    Ok(view_of(&load_stored()?))
}

#[tauri::command]
pub async fn save_proxy_config(input: ProxyInput) -> Result<ProxyView, String> {
    let stored = load_stored()?;
    let (cfg, password) = resolve(&input, &stored)?;
    // 先构建成功再落库/替换：构建失败时旧客户端与旧设置都保持不变
    let client = http::build_client(&cfg, &password)?;
    storage::set_setting(
        http::PROXY_SETTING_KEY,
        &serde_json::to_string(&cfg).map_err(|e| e.to_string())?,
    )?;
    http::install(Arc::new(client));
    tracing::warn!("代理配置已更新：{}", cfg.mode);
    Ok(view_of(&cfg))
}

/// 连通性测试：用表单值构建临时客户端，访问该服务商的 baseUrl。
/// 收到任意 HTTP 状态即视为链路可达（不校验鉴权），避免硬编码第三方测试地址。
#[tauri::command]
pub async fn test_proxy(input: ProxyInput, provider_id: i64) -> Result<serde_json::Value, String> {
    let stored = load_stored()?;
    let (cfg, password) = resolve(&input, &stored)?;
    let provider = storage::get_provider(provider_id)?
        .ok_or_else(|| "服务商不存在，请先在「服务商管理」中配置".to_string())?;
    if provider.base_url.trim().is_empty() {
        return Err("该服务商没有填写 Base URL，无法测试".into());
    }
    let client = http::build_client(&cfg, &password)?;
    let start = Instant::now();
    match client
        .get(provider.base_url.trim())
        .timeout(PROXY_TEST_TIMEOUT)
        .send()
        .await
    {
        Ok(resp) => Ok(serde_json::json!({
            "ok": true,
            "latencyMs": start.elapsed().as_millis() as u64,
            "status": resp.status().as_u16(),
        })),
        Err(e) => {
            let kind = if e.is_timeout() {
                "代理连接超时"
            } else if e.is_connect() {
                "无法连接代理或目标地址"
            } else {
                "请求失败"
            };
            Ok(serde_json::json!({
                "ok": false,
                "latencyMs": start.elapsed().as_millis() as u64,
                "error": format!("{kind}: {e}"),
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored() -> ProxyConfig {
        ProxyConfig {
            mode: http::MODE_MANUAL.into(),
            url: "http://127.0.0.1:7890".into(),
            password_enc: "legacy-enc".into(),
            ..Default::default()
        }
    }

    #[test]
    fn resolve_validates_mode_and_url() {
        let mut input = ProxyInput {
            mode: "manual".into(),
            url: "".into(),
            username: String::new(),
            // 空密码避免单测触碰系统凭据管理器
            password: Some("".into()),
            no_proxy: String::new(),
        };
        assert!(resolve(&input, &ProxyConfig::default()).is_err());
        input.url = "http://127.0.0.1:7890".into();
        input.mode = "direct".into();
        assert!(resolve(&input, &ProxyConfig::default()).is_ok());
    }

    #[test]
    fn resolve_clears_password_only_when_explicit() {
        let mut input = ProxyInput {
            mode: "direct".into(),
            url: String::new(),
            username: String::new(),
            password: Some("".into()),
            no_proxy: String::new(),
        };
        let (cfg, pwd) = resolve(&input, &stored()).expect("clear password");
        assert!(cfg.password_enc.is_empty());
        assert!(pwd.is_empty());

        // 未提供密码时沿用已存密文；这里密文非法，必须报错而不是静默空密码
        input.password = None;
        assert!(resolve(&input, &stored()).is_err());
    }
}
