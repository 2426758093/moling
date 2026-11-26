use super::*;

use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{HashMap, HashSet};

pub fn set_setting(key: &str, value: &str) -> AppResult<()> {
    conn()?.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn get_setting(key: &str) -> AppResult<Option<String>> {
    let c = conn()?;
    let mut stmt = c.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let mut rows = stmt.query_map(params![key], |r| r.get(0))?;
    Ok(rows.next().transpose()?)
}

/// 删除设置项（不存在时静默成功）。用于清理指向已删除服务商的 defaultProviderId。
pub fn delete_setting(key: &str) -> AppResult<()> {
    conn()?.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
    Ok(())
}
/// 各业务表行数（诊断包用）。表名取自 sqlite_master，随迁移自动扩展。
pub fn table_row_counts() -> AppResult<Vec<(String, i64)>> {
    let c = conn()?;
    let names: Vec<String> = {
        let mut stmt = c.prepare(
            "SELECT name FROM sqlite_master
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let mut out = Vec::new();
    for name in names {
        // 表名来自 sqlite_master 而非用户输入，拼接安全
        let n: i64 = c.query_row(&format!("SELECT COUNT(*) FROM \"{name}\""), [], |r| {
            r.get(0)
        })?;
        out.push((name, n));
    }
    Ok(out)
}
/// 取导入文件中的 providers 数组；缺失或类型不对直接报错。
/// 必须在任何 DELETE 之前调用（P0-2：否则会先清空用户旧配置再报错/静默成功）。
fn require_providers(data: &serde_json::Value) -> AppResult<&[serde_json::Value]> {
    data.get("providers")
        .and_then(|p| p.as_array())
        .map(|p| p.as_slice())
        .ok_or_else(|| AppError::Other("导入文件缺少 providers 数组，已取消导入".into()))
}

/// 经由「通用 set/get_setting」通道持久化、并且会进备份与诊断包的设置项。
///
/// 与 `commands::settings::ALLOWED_SETTING_KEYS` 必须逐项一致（有单测守住）：
/// 新增一项只改动其中一处的后果是"设置能存但备份丢了"或反过来，两者都不报错。
pub const BACKUP_SETTING_KEYS: &[&str] = &[
    "defaultProviderId",
    "defaultParams",
    "promptTemplates",
    "stylePresets",
    "theme",
    "glassAppearance",
    "uiMode",
    "locale",
    "queueConcurrency",
    "queueProviderConcurrency",
    "queueAutoResume",
    "cacheRetentionDays",
    "bodyIdleTimeoutSecs",
    "bodyTotalTimeoutSecs",
    "smartMask",
];

/// 缓存（回收站）保留天数的合法区间与默认值
pub const MIN_CACHE_RETENTION_DAYS: i64 = 1;
pub const MAX_CACHE_RETENTION_DAYS: i64 = 365;
pub const DEFAULT_CACHE_RETENTION_DAYS: i64 = 30;

/// 响应体读取超时的合法区间与默认值（秒）
pub const MIN_BODY_IDLE_TIMEOUT_SECS: i64 = 5;
pub const MAX_BODY_IDLE_TIMEOUT_SECS: i64 = 300;
pub const DEFAULT_BODY_IDLE_TIMEOUT_SECS: u64 = 60;
pub const MIN_BODY_TOTAL_TIMEOUT_SECS: i64 = 30;
pub const MAX_BODY_TOTAL_TIMEOUT_SECS: i64 = 1800;
pub const DEFAULT_BODY_TOTAL_TIMEOUT_SECS: u64 = 600;

/// 读缓存保留天数；未设置/脏值回退默认（启动清理不能因为设置损坏而停摆）
pub fn cache_retention_days() -> i64 {
    let c = match conn() {
        Ok(c) => c,
        Err(_) => return DEFAULT_CACHE_RETENTION_DAYS,
    };
    cache_retention_days_in(&c)
}

pub(crate) fn cache_retention_days_in(c: &Connection) -> i64 {
    c.query_row(
        "SELECT value FROM settings WHERE key = 'cacheRetentionDays'",
        [],
        |r| r.get::<_, String>(0),
    )
    .ok()
    .and_then(|v| v.trim().parse::<i64>().ok())
    .filter(|n| (MIN_CACHE_RETENTION_DAYS..=MAX_CACHE_RETENTION_DAYS).contains(n))
    .unwrap_or(DEFAULT_CACHE_RETENTION_DAYS)
}

/// 读响应体读取超时（无数据 / 总时长，秒）。
/// 未设置、脏值或越界一律回退默认；总时长低于空闲时抬到空闲值，
/// 避免配置损坏导致「空闲阈值永远等不到」。
pub fn body_timeout_secs() -> (u64, u64) {
    match conn() {
        Ok(c) => body_timeout_secs_in(&c),
        Err(_) => (
            DEFAULT_BODY_IDLE_TIMEOUT_SECS,
            DEFAULT_BODY_TOTAL_TIMEOUT_SECS,
        ),
    }
}

pub(crate) fn body_timeout_secs_in(c: &Connection) -> (u64, u64) {
    let read = |key: &str, min: i64, max: i64| -> Option<u64> {
        c.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|n| (min..=max).contains(n))
        .map(|n| n as u64)
    };
    let idle = read(
        "bodyIdleTimeoutSecs",
        MIN_BODY_IDLE_TIMEOUT_SECS,
        MAX_BODY_IDLE_TIMEOUT_SECS,
    )
    .unwrap_or(DEFAULT_BODY_IDLE_TIMEOUT_SECS);
    let total = read(
        "bodyTotalTimeoutSecs",
        MIN_BODY_TOTAL_TIMEOUT_SECS,
        MAX_BODY_TOTAL_TIMEOUT_SECS,
    )
    .unwrap_or(DEFAULT_BODY_TOTAL_TIMEOUT_SECS);
    (idle, total.max(idle))
}

/// 导入时允许写入的设置项。v1 只有旧版导出的两项；v2 增加主题与自定义模板。
const IMPORT_SETTINGS_V1: &[&str] = &["defaultProviderId", "defaultParams"];
const IMPORT_SETTINGS_V2: &[&str] = &[
    "defaultProviderId",
    "defaultParams",
    "theme",
    "promptTemplates",
    "stylePresets",
    "glassAppearance",
    "uiMode",
    "locale",
    "queueConcurrency",
    "queueProviderConcurrency",
    "queueAutoResume",
    "cacheRetentionDays",
    "bodyIdleTimeoutSecs",
    "bodyTotalTimeoutSecs",
    "smartMask",
];

fn invalid_import(msg: &str) -> AppError {
    AppError::Other(format!("{msg}，已取消导入"))
}

/// v2 新增设置项的结构校验，必须在事务与 DELETE 之前调用。
fn validate_import_settings(
    settings: Option<&serde_json::Map<String, serde_json::Value>>,
    version: u64,
) -> AppResult<()> {
    let Some(settings) = settings else {
        return Ok(());
    };
    // v1 导出没有这些字段，保持原有的宽松导入行为
    if version < 2 {
        return Ok(());
    }
    if let Some(theme) = settings.get("theme") {
        let ok = theme
            .as_str()
            .is_some_and(|t| matches!(t, "system" | "light" | "dark"));
        if !ok {
            return Err(invalid_import("导入文件中的主题取值非法"));
        }
    }
    if let Some(glass) = settings.get("glassAppearance") {
        let ok = glass
            .as_str()
            .is_some_and(|g| matches!(g, "clear" | "standard" | "tinted"));
        if !ok {
            return Err(invalid_import("导入文件中的玻璃质感取值非法"));
        }
    }
    if let Some(templates) = settings.get("promptTemplates") {
        validate_import_templates(templates)?;
    }
    if let Some(styles) = settings.get("stylePresets") {
        validate_import_style_presets(styles)?;
    }
    if let Some(mode) = settings.get("uiMode") {
        let ok = mode
            .as_str()
            .is_some_and(|m| matches!(m, "simple" | "expert"));
        if !ok {
            return Err(invalid_import("导入文件中的界面模式取值非法"));
        }
    }
    if let Some(locale) = settings.get("locale") {
        let ok = locale
            .as_str()
            .is_some_and(|l| matches!(l, "zh-CN" | "en-US"));
        if !ok {
            return Err(invalid_import("导入文件中的界面语言取值非法"));
        }
    }
    if let Some(smart) = settings.get("smartMask") {
        let ok = smart.as_str().is_some_and(|v| matches!(v, "on" | "off"));
        if !ok {
            return Err(invalid_import("导入文件中的智能蒙版开关取值非法"));
        }
    }
    if let Some(auto) = settings.get("queueAutoResume") {
        let ok = auto.as_str().is_some_and(|v| matches!(v, "on" | "off"));
        if !ok {
            return Err(invalid_import("导入文件中的队列自动续跑开关取值非法"));
        }
    }
    if let Some(concurrency) = settings.get("queueConcurrency") {
        let ok = concurrency
            .as_str()
            .and_then(|v| v.trim().parse::<i64>().ok())
            .is_some_and(|n| {
                (crate::commands::queue::MIN_CONCURRENCY..=crate::commands::queue::MAX_CONCURRENCY)
                    .contains(&n)
            });
        if !ok {
            return Err(invalid_import("导入文件中的队列并发数取值非法"));
        }
    }
    if let Some(concurrency) = settings.get("queueProviderConcurrency") {
        let ok = concurrency
            .as_str()
            .and_then(|v| v.trim().parse::<i64>().ok())
            .is_some_and(|n| {
                (crate::commands::queue::MIN_PROVIDER_CONCURRENCY
                    ..=crate::commands::queue::MAX_PROVIDER_CONCURRENCY)
                    .contains(&n)
            });
        if !ok {
            return Err(invalid_import("导入文件中的每服务商并发数取值非法"));
        }
    }
    if let Some(days) = settings.get("cacheRetentionDays") {
        let ok = days
            .as_str()
            .and_then(|v| v.trim().parse::<i64>().ok())
            .is_some_and(|n| (MIN_CACHE_RETENTION_DAYS..=MAX_CACHE_RETENTION_DAYS).contains(&n));
        if !ok {
            return Err(invalid_import(
                "导入文件中的缓存保留天数取值非法（应为 1–365）",
            ));
        }
    }
    let idle = match settings.get("bodyIdleTimeoutSecs") {
        None => None,
        Some(v) => match v
            .as_str()
            .and_then(|s| s.trim().parse::<i64>().ok())
            .filter(|n| (MIN_BODY_IDLE_TIMEOUT_SECS..=MAX_BODY_IDLE_TIMEOUT_SECS).contains(n))
        {
            Some(n) => Some(n),
            None => {
                return Err(invalid_import(
                    "导入文件中的无数据超时取值非法（应为 5–300）",
                ))
            }
        },
    };
    let total = match settings.get("bodyTotalTimeoutSecs") {
        None => None,
        Some(v) => match v
            .as_str()
            .and_then(|s| s.trim().parse::<i64>().ok())
            .filter(|n| (MIN_BODY_TOTAL_TIMEOUT_SECS..=MAX_BODY_TOTAL_TIMEOUT_SECS).contains(n))
        {
            Some(n) => Some(n),
            None => {
                return Err(invalid_import(
                    "导入文件中的响应体总超时取值非法（应为 30–1800）",
                ))
            }
        },
    };
    if let (Some(idle), Some(total)) = (idle, total) {
        if total < idle {
            return Err(invalid_import("导入文件中的响应体总超时不能小于无数据超时"));
        }
    }
    Ok(())
}

/// 自定义模板在 settings 中以 JSON 字符串保存，必须是 `[{id,title,text}]` 数组。
fn validate_import_templates(value: &serde_json::Value) -> AppResult<()> {
    let raw = value
        .as_str()
        .ok_or_else(|| invalid_import("自定义模板必须是 JSON 字符串"))?;
    let parsed: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| invalid_import("自定义模板不是合法 JSON"))?;
    let list = parsed
        .as_array()
        .ok_or_else(|| invalid_import("自定义模板必须是数组"))?;
    for item in list {
        let obj = item
            .as_object()
            .ok_or_else(|| invalid_import("自定义模板项必须是对象"))?;
        for key in ["id", "title", "text"] {
            let ok = obj
                .get(key)
                .and_then(|v| v.as_str())
                .is_some_and(|s| !s.trim().is_empty());
            if !ok {
                return Err(invalid_import("自定义模板项缺少 id/title/text"));
            }
        }
    }
    Ok(())
}

fn validate_import_style_presets(value: &serde_json::Value) -> AppResult<()> {
    let raw = value
        .as_str()
        .ok_or_else(|| invalid_import("自定义风格必须是 JSON 字符串"))?;
    let parsed: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| invalid_import("自定义风格不是合法 JSON"))?;
    let list = parsed
        .as_array()
        .ok_or_else(|| invalid_import("自定义风格必须是数组"))?;
    for item in list {
        let obj = item
            .as_object()
            .ok_or_else(|| invalid_import("自定义风格项必须是对象"))?;
        for key in ["id", "label", "prompt"] {
            let ok = obj
                .get(key)
                .and_then(|v| v.as_str())
                .is_some_and(|s| !s.trim().is_empty());
            if !ok {
                return Err(invalid_import("自定义风格项缺少 id/label/prompt"));
            }
        }
    }
    Ok(())
}

/// v3 Key 列表与失效标记的格式校验，与其余导入校验一样在事务与 DELETE 之前执行。
fn validate_import_keys(providers: &[serde_json::Value], version: u64) -> AppResult<()> {
    if version < 3 {
        return Ok(());
    }
    for p in providers {
        if let Some(keys) = p.get("apiKeys") {
            let list = keys
                .as_array()
                .ok_or_else(|| invalid_import("apiKeys 必须是数组"))?;
            if list.iter().any(|k| !k.is_string()) {
                return Err(invalid_import("apiKeys 只能包含字符串"));
            }
        }
        if let Some(indexes) = p.get("invalidKeyIndexes") {
            let list = indexes
                .as_array()
                .ok_or_else(|| invalid_import("invalidKeyIndexes 必须是数组"))?;
            if list.iter().any(|v| v.as_u64().is_none()) {
                return Err(invalid_import("invalidKeyIndexes 只能包含整数"));
            }
        }
    }
    Ok(())
}

/// 从导入项取出整组 Key：优先 v3 `apiKeys`，兼容 v1/v2 单个 `apiKey`。
/// 失效标记按 `apiKeys` 原始下标给出，过滤空串后下标仍对应原数组。
fn import_keys(p: &serde_json::Value) -> Vec<ProviderKey> {
    let invalid: HashSet<usize> = p
        .get("invalidKeyIndexes")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_u64())
                .map(|n| n as usize)
                .collect()
        })
        .unwrap_or_default();
    let mut keys = Vec::new();
    let mut seen = HashSet::new();
    let mut push = |key: &str, index: usize| {
        let key = key.trim();
        if !key.is_empty() && seen.insert(key.to_string()) {
            keys.push(ProviderKey::restored(key, invalid.contains(&index)));
        }
    };
    match p.get("apiKeys").and_then(|v| v.as_array()) {
        Some(list) => {
            for (i, v) in list.iter().enumerate() {
                push(v.as_str().unwrap_or_default(), i);
            }
        }
        None => {
            if let Some(single) = p.get("apiKey").and_then(|v| v.as_str()) {
                push(single, 0);
            }
        }
    }
    keys
}

fn validate_import_thinking(value: &serde_json::Value) -> AppResult<()> {
    let obj = value
        .as_object()
        .ok_or_else(|| invalid_import("思考模型配置必须是对象"))?;
    if obj.get("enabled").is_some_and(|v| !v.is_boolean()) {
        return Err(invalid_import("思考模型 enabled 必须是布尔值"));
    }
    if let Some(mode) = obj.get("mode") {
        let ok = mode
            .as_str()
            .is_some_and(|m| matches!(m, "standalone" | "reuse"));
        if !ok {
            return Err(invalid_import("思考模型 mode 只能是 standalone 或 reuse"));
        }
    }
    if let Some(pid) = obj.get("providerId") {
        if !(pid.is_null() || pid.as_i64().is_some()) {
            return Err(invalid_import("思考模型 providerId 必须是整数或 null"));
        }
    }
    for key in ["baseUrl", "model"] {
        if obj.get(key).is_some_and(|v| v.as_str().is_none()) {
            return Err(invalid_import("思考模型配置字段类型非法"));
        }
    }
    Ok(())
}

/// v3 代理配置校验：只接受非密钥字段，手动代理必须带可解析的 http(s) 地址。
fn validate_import_network(value: &serde_json::Value) -> AppResult<()> {
    let obj = value
        .as_object()
        .ok_or_else(|| invalid_import("network 必须是对象"))?;
    let mode = obj.get("mode").and_then(|v| v.as_str()).unwrap_or("system");
    if !matches!(mode, "system" | "direct" | "manual") {
        return Err(invalid_import("代理模式只能是 system/direct/manual"));
    }
    for key in ["url", "noProxy"] {
        if obj.get(key).is_some_and(|v| !v.is_string()) {
            return Err(invalid_import("代理配置字段类型非法"));
        }
    }
    if mode == "manual" {
        let url = obj
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim();
        let parsed = reqwest::Url::parse(url).map_err(|_| invalid_import("代理地址无效"))?;
        let has_host = !parsed.host_str().unwrap_or_default().is_empty();
        if !matches!(parsed.scheme(), "http" | "https") || !has_host {
            return Err(invalid_import("代理地址无效"));
        }
    }
    Ok(())
}

/// 写入导入的代理配置：密码/用户名不随备份走，代理地址未变时沿用本机凭据，
/// 换地址则清空，避免把旧密码发到新代理上。
fn import_network(tx: &rusqlite::Transaction<'_>, value: &serde_json::Value) -> AppResult<()> {
    use crate::adapters::http::{ProxyConfig, PROXY_SETTING_KEY};
    let obj = value.as_object().expect("代理配置已在事务前校验为对象");
    let url = obj.get("url").and_then(|v| v.as_str()).unwrap_or_default();
    let old = tx
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![PROXY_SETTING_KEY],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .map(|raw| ProxyConfig::from_stored(Some(&raw)))
        .filter(|cfg| cfg.url == url);
    let cfg = ProxyConfig {
        mode: obj
            .get("mode")
            .and_then(|v| v.as_str())
            .unwrap_or("system")
            .to_string(),
        url: url.to_string(),
        username: old.as_ref().map(|o| o.username.clone()).unwrap_or_default(),
        password_enc: old
            .as_ref()
            .map(|o| o.password_enc.clone())
            .unwrap_or_default(),
        no_proxy: obj
            .get("noProxy")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
    };
    let json = serde_json::to_string(&cfg).map_err(|e| AppError::Other(e.to_string()))?;
    tx.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![PROXY_SETTING_KEY, json],
    )?;
    Ok(())
}

/// 事务内导入配置（替换语义，R5）：先清空旧 providers 及其 extraParams 设置项，
/// 再写入全部导入内容；中途任何失败整体回滚，不留半导入状态。
/// `data` 为前端导出的 JSON（version 校验由调用方完成），返回导入的服务商数量。
/// 把编辑/变换模板的三项字段拼成 JSON 存列；全空时存空串（= 未配置）。
/// providers/save 与 import 共用，保证两条写入路径的格式一致。
pub(crate) fn template_spec_json(url: &str, body: &str, response_path: &str) -> String {
    if url.trim().is_empty() && body.trim().is_empty() && response_path.trim().is_empty() {
        return String::new();
    }
    serde_json::json!({
        "url": url,
        "body": body,
        "responsePath": response_path,
    })
    .to_string()
}

#[cfg(test)]
pub fn import_config(data: &serde_json::Value) -> AppResult<usize> {
    let mut c = conn()?;
    import_config_in(&mut c, data)
}

/// 预设参考图的落盘回调：输入 data URL，返回保存后的绝对路径。
pub type RefWriter<'a> = Option<&'a dyn Fn(&str) -> AppResult<String>>;

/// 备份 v4 的预设参考图需要重新落盘：由调用方注入写文件闭包（单测传 None）。
pub fn import_config_with_refs(
    data: &serde_json::Value,
    write_ref: RefWriter<'_>,
) -> AppResult<usize> {
    // F-013：参考图落盘（慢 IO）在取 DB 锁之前完成，导入期间 UI 的读写不再被堵住。
    let assets = prepare_import_assets(data, write_ref)?;
    let mut c = conn()?;
    import_config_in_prepared(&mut c, data, assets)
}

#[derive(Debug)]
struct ImportFavorite {
    text: String,
    tags_json: String,
    created_at: String,
}

#[derive(Debug)]
struct ImportPreset {
    name: String,
    prompt: String,
    negative_prompt: String,
    params_json: String,
    refs_json: String,
    created_at: String,
    updated_at: String,
}

const MAX_IMPORT_FAVORITES: usize = 500;
const MAX_IMPORT_PRESETS: usize = 200;
const MAX_IMPORT_REF_DATA_URL: usize = 12 * 1024 * 1024;

fn import_ref_role_ok(role: &str) -> bool {
    matches!(role, "composition" | "style" | "face" | "element")
}

/// v4：收藏与预设数组的结构校验。任何一项非法都在事务与 DELETE 之前失败。
fn parse_import_prompt_assets(
    data: &serde_json::Value,
    write_ref: RefWriter<'_>,
) -> AppResult<(Vec<ImportFavorite>, Vec<ImportPreset>)> {
    let favorites_raw = data
        .get("favorites")
        .and_then(|v| v.as_array())
        .ok_or_else(|| invalid_import("导入文件缺少 favorites 数组"))?;
    if favorites_raw.len() > MAX_IMPORT_FAVORITES {
        return Err(invalid_import("导入文件中的收藏数量过多"));
    }
    let mut favorites = Vec::with_capacity(favorites_raw.len());
    for item in favorites_raw {
        let text = item
            .get("text")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .ok_or_else(|| invalid_import("收藏条目缺少提示词文本"))?;
        let tags: Vec<String> = match item.get("tags") {
            None | Some(serde_json::Value::Null) => Vec::new(),
            Some(v) => {
                let arr = v
                    .as_array()
                    .ok_or_else(|| invalid_import("收藏标签必须是字符串数组"))?;
                arr.iter()
                    .map(|t| {
                        t.as_str()
                            .map(str::to_string)
                            .ok_or_else(|| invalid_import("收藏标签必须是字符串数组"))
                    })
                    .collect::<AppResult<Vec<_>>>()?
            }
        };
        let tags = normalize_tags(&tags);
        favorites.push(ImportFavorite {
            text: text.to_string(),
            tags_json: serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into()),
            created_at: item
                .get("createdAt")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
        });
    }

    let presets_raw = data
        .get("presets")
        .and_then(|v| v.as_array())
        .ok_or_else(|| invalid_import("导入文件缺少 presets 数组"))?;
    if presets_raw.len() > MAX_IMPORT_PRESETS {
        return Err(invalid_import("导入文件中的预设数量过多"));
    }
    let mut presets = Vec::with_capacity(presets_raw.len());
    for item in presets_raw {
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .ok_or_else(|| invalid_import("预设缺少名称"))?;
        if name.chars().count() > MAX_PRESET_NAME_CHARS {
            return Err(invalid_import("预设名称过长"));
        }
        let params = match item.get("params") {
            None | Some(serde_json::Value::Null) => serde_json::json!({}),
            Some(v) if v.is_object() => v.clone(),
            Some(_) => return Err(invalid_import("预设参数必须是对象")),
        };
        let refs_raw = match item.get("refs") {
            None | Some(serde_json::Value::Null) => Vec::new(),
            Some(v) => v
                .as_array()
                .cloned()
                .ok_or_else(|| invalid_import("预设参考图必须是数组"))?,
        };
        if refs_raw.len() > MAX_PRESET_REFS {
            return Err(invalid_import("预设参考图超过上限"));
        }
        let mut refs = Vec::with_capacity(refs_raw.len());
        for r in refs_raw {
            let role = r.get("role").and_then(|v| v.as_str()).unwrap_or_default();
            if !import_ref_role_ok(role) {
                return Err(invalid_import("预设参考角色非法"));
            }
            let strength = r.get("strength").and_then(|v| v.as_u64()).unwrap_or(60);
            if strength > 100 {
                return Err(invalid_import("预设参考强度必须在 0–100 之间"));
            }
            let data_url = r
                .get("dataUrl")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if !data_url.starts_with("data:image/") {
                return Err(invalid_import("预设参考图缺少有效的 dataUrl"));
            }
            if data_url.len() > MAX_IMPORT_REF_DATA_URL {
                return Err(invalid_import("预设参考图过大"));
            }
            let path = match write_ref {
                Some(write) => write(data_url)?,
                None => String::new(),
            };
            if path.is_empty() {
                continue;
            }
            refs.push(PresetRef {
                path,
                role: role.to_string(),
                strength: strength as u32,
            });
        }
        presets.push(ImportPreset {
            name: name.to_string(),
            prompt: item
                .get("prompt")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            negative_prompt: item
                .get("negativePrompt")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            params_json: serde_json::to_string(&params).unwrap_or_else(|_| "{}".into()),
            refs_json: serde_json::to_string(&refs).unwrap_or_else(|_| "[]".into()),
            created_at: item
                .get("createdAt")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            updated_at: item
                .get("updatedAt")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
        });
    }
    Ok((favorites, presets))
}

fn insert_import_prompt_assets(
    tx: &rusqlite::Transaction<'_>,
    favorites: &[ImportFavorite],
    presets: &[ImportPreset],
) -> AppResult<()> {
    tx.execute("DELETE FROM prompt_favorites", [])?;
    tx.execute("DELETE FROM workflow_presets", [])?;
    let now = timestamp_millis();
    for f in favorites {
        let created = if f.created_at.is_empty() {
            now.as_str()
        } else {
            f.created_at.as_str()
        };
        tx.execute(
            "INSERT INTO prompt_favorites (text, tags_json, created_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(text) DO UPDATE SET tags_json = excluded.tags_json",
            params![f.text, f.tags_json, created],
        )?;
    }
    for p in presets {
        let created = if p.created_at.is_empty() {
            now.as_str()
        } else {
            p.created_at.as_str()
        };
        let updated = if p.updated_at.is_empty() {
            created
        } else {
            p.updated_at.as_str()
        };
        tx.execute(
            "INSERT INTO workflow_presets
             (name, prompt, negative_prompt, params_json, refs_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                p.name,
                p.prompt,
                p.negative_prompt,
                p.params_json,
                p.refs_json,
                created,
                updated
            ],
        )?;
    }
    Ok(())
}

/// import_config 的可测接缝：在给定连接上执行导入（单测用内存库，避免共享全局 DB）。
/// 入参校验放在事务与 DELETE 之前，非法导入绝不触碰表内旧数据。
#[cfg(test)]
fn import_config_in(c: &mut Connection, data: &serde_json::Value) -> AppResult<usize> {
    let assets = prepare_import_assets(data, None)?;
    import_config_in_prepared(c, data, assets)
}

/// 单测接缝：在给定连接上执行导入，参考图落盘仍走本连接（测试用内存库，无锁竞争）。
#[cfg(test)]
fn import_config_in_with_refs(
    c: &mut Connection,
    data: &serde_json::Value,
    write_ref: RefWriter<'_>,
) -> AppResult<usize> {
    let assets = prepare_import_assets(data, write_ref)?;
    import_config_in_prepared(c, data, assets)
}

/// 导入前的「慢准备」：预设参考图落盘。
///
/// F-013：这一步必须发生在拿 DB 锁之前——原先在 `conn()` 的 Mutex 内写文件，
/// 大导入期间所有 UI 读写都被堵在同一条连接后面。校验失败或事务回滚只会留下
/// 孤儿文件，由 image_gc 回收（与事务失败同口径）。
fn prepare_import_assets(
    data: &serde_json::Value,
    write_ref: RefWriter<'_>,
) -> AppResult<Option<(Vec<ImportFavorite>, Vec<ImportPreset>)>> {
    let version = data.get("version").and_then(|v| v.as_u64()).unwrap_or(1);
    if version < 4 {
        return Ok(None);
    }
    Ok(Some(parse_import_prompt_assets(data, write_ref)?))
}

fn import_config_in_prepared(
    c: &mut Connection,
    data: &serde_json::Value,
    prompt_assets: Option<(Vec<ImportFavorite>, Vec<ImportPreset>)>,
) -> AppResult<usize> {
    let version = data.get("version").and_then(|v| v.as_u64()).unwrap_or(1);
    let providers = require_providers(data)?;
    let settings = match data.get("settings") {
        Some(v) => {
            let obj = v.as_object();
            if version >= 2 && obj.is_none() {
                return Err(invalid_import("导入文件中的 settings 必须是对象"));
            }
            obj
        }
        None => None,
    };
    validate_import_settings(settings, version)?;
    let thinking = if version >= 2 {
        data.get("thinking")
    } else {
        None
    };
    if let Some(t) = thinking {
        validate_import_thinking(t)?;
    }
    validate_import_keys(providers, version)?;
    if version >= 3 {
        if let Some(net) = data.get("network") {
            validate_import_network(net)?;
        }
    }
    debug_assert!(
        version < 4 || prompt_assets.is_some(),
        "v4 导入必须先在锁外准备好预设参考图"
    );

    let tx = c.transaction()?;
    // v2/v3 默认不导出明文 Key：删除前记录旧密文，导入项无 Key 且
    // name+baseUrl 一致时复用，避免「不含 Key 的备份」在换机/回滚时清空密钥。
    let old_keys: HashMap<(String, String), (String, String)> = {
        let mut stmt =
            tx.prepare("SELECT name, base_url, api_keys_enc, api_key_enc FROM providers")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                (r.get::<_, String>(0)?, r.get::<_, String>(1)?),
                (r.get::<_, String>(2)?, r.get::<_, String>(3)?),
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?.into_iter().collect()
    };
    // thinkingConfig 不参与替换，但 v2 导出从不含 Key，导入时必须沿用本机密文
    let old_thinking_enc = if thinking.is_some() {
        tx.query_row(
            "SELECT value FROM settings WHERE key = 'thinkingConfig'",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| {
            v.get("apiKeyEnc")
                .and_then(|s| s.as_str())
                .map(str::to_string)
        })
        .unwrap_or_default()
    } else {
        String::new()
    };

    // 替换语义：删除旧服务商及与之关联的 extraParams 设置
    let old_ids: Vec<i64> = {
        let mut stmt = tx.prepare("SELECT id FROM providers")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect::<Result<Vec<i64>, _>>()?
    };
    tx.execute("DELETE FROM providers", [])?;
    for id in old_ids {
        tx.execute(
            "DELETE FROM settings WHERE key = ?1",
            params![format!("extraParams:{id}")],
        )?;
    }
    // 导出时的旧服务商 id → 导入后的新 id（自增 id 会变，设置项需据此重映射）
    let mut id_map: HashMap<i64, i64> = HashMap::new();
    for p in providers {
        let get = |k: &str| {
            p.get(k)
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string()
        };
        let name = get("name");
        let base_url = get("baseUrl");
        // v3 带整组 Key；v1/v2 只有单个 apiKey；都没有时沿用本机旧密文（含整组列表）
        let keys = import_keys(p);
        let (keys_enc, enc) = if keys.is_empty() {
            match old_keys.get(&(name.clone(), base_url.clone())) {
                Some((old_keys_enc, old_enc)) => (old_keys_enc.clone(), old_enc.clone()),
                None => (String::new(), encrypt_secret("")?),
            }
        } else {
            encode_keys(&keys)?
        };
        tx.execute(
            "INSERT INTO providers (name, base_url, api_key_enc, api_keys_enc, kind, models_json,
             default_model, timeout_secs, template_url, template_body, template_response_path,
             edit_template_json, transform_template_json)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            params![
                name,
                base_url,
                enc,
                keys_enc,
                get("kind"),
                get("modelsJson"),
                get("defaultModel"),
                p.get("timeoutSecs")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(DEFAULT_PROVIDER_TIMEOUT_SECS) as i64,
                get("templateUrl"),
                get("templateBody"),
                get("templateResponsePath"),
                template_spec_json(
                    &get("editTemplateUrl"),
                    &get("editTemplateBody"),
                    &get("editTemplateResponsePath")
                ),
                template_spec_json(
                    &get("transformTemplateUrl"),
                    &get("transformTemplateBody"),
                    &get("transformTemplateResponsePath")
                )
            ],
        )?;
        let new_id = tx.last_insert_rowid();
        // 仅新版导出（provider 带整数 id）才能建立旧→新映射；旧导出无 id 则无从映射
        if let Some(old_id) = p.get("id").and_then(|v| v.as_i64()) {
            id_map.insert(old_id, new_id);
        }
        // 恢复透传参数（extraParams 存于 settings KV，导入时必须一并恢复）
        if let Some(ep) = p.get("extraParams").and_then(|v| v.as_str()) {
            tx.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![format!("extraParams:{new_id}"), ep],
            )?;
        }
    }
    if let Some(settings) = settings {
        let allowed = if version >= 2 {
            IMPORT_SETTINGS_V2
        } else {
            IMPORT_SETTINGS_V1
        };
        for k in allowed {
            let Some(value) = settings.get(*k).and_then(|v| v.as_str()) else {
                continue;
            };
            // P0-2：defaultProviderId 存的是服务商 id，导入后 id 已变，必须重映射；
            // 无法映射（旧格式导出 / 指向不存在的服务商）时删除该设置，避免默认服务商悬空
            if *k == "defaultProviderId" {
                let mapped = value
                    .trim()
                    .parse::<i64>()
                    .ok()
                    .and_then(|old_id| id_map.get(&old_id).copied());
                match mapped {
                    Some(new_id) => {
                        tx.execute(
                            "INSERT INTO settings (key, value) VALUES (?1, ?2)
                             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                            params![k, new_id.to_string()],
                        )?;
                    }
                    None => {
                        tx.execute("DELETE FROM settings WHERE key = ?1", params![k])?;
                        tracing::warn!(
                            "配置导入：defaultProviderId={value} 无法映射到导入后的服务商，已清除该设置"
                        );
                    }
                }
                continue;
            }
            tx.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![k, value],
            )?;
        }
    }
    // 思考模型：只覆盖导出的非密钥字段，providerId 按 id_map 重映射，密文沿用本机
    if let Some(t) = thinking {
        let obj = t.as_object().expect("思考模型配置已在事务前校验为对象");
        let old_pid = obj.get("providerId").and_then(|v| v.as_i64());
        let provider_id = old_pid.and_then(|old| id_map.get(&old).copied());
        if old_pid.is_some() && provider_id.is_none() {
            tracing::warn!("配置导入：思考模型 providerId 无法映射到导入后的服务商，已清空");
        }
        let value = serde_json::json!({
            "enabled": obj.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false),
            "mode": obj.get("mode").and_then(|v| v.as_str()).unwrap_or("reuse"),
            "providerId": provider_id,
            "baseUrl": obj.get("baseUrl").and_then(|v| v.as_str()).unwrap_or_default(),
            "apiKeyEnc": old_thinking_enc,
            "model": obj.get("model").and_then(|v| v.as_str()).unwrap_or_default(),
            "titleEnabled": obj.get("titleEnabled").and_then(|v| v.as_bool()).unwrap_or(true),
            "optimizeEnabled": obj.get("optimizeEnabled").and_then(|v| v.as_bool()).unwrap_or(true),
            "autoTranslateOnBlur": obj
                .get("autoTranslateOnBlur")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        });
        tx.execute(
            "INSERT INTO settings (key, value) VALUES ('thinkingConfig', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![value.to_string()],
        )?;
    }
    // v3 备份携带代理的非密钥字段；密码与用户名留在本机
    if version >= 3 {
        if let Some(net) = data.get("network") {
            import_network(&tx, net)?;
        }
    }
    // v4：收藏与预设为替换语义；v1–v3 备份不触碰本机现有资产
    if let Some((favorites, presets)) = &prompt_assets {
        insert_import_prompt_assets(&tx, favorites, presets)?;
    }
    tx.commit()?;
    Ok(providers.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::*;

    /// 所有依赖全局 DB 的断言集中在一个测试中（DB 为进程级 OnceLock，无法重复 init）
    #[test]
    fn storage_roundtrip_key_safety_and_import_tx() {
        let _guard = ENV_LOCK.lock().unwrap();
        // 全局 DB 可能已被其它测试模块先初始化，此时沿用对方的连接
        let _db_guard = TEST_DB_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var(MASTER_KEY_ENV, "aa".repeat(32));
        let dir = test_dir();
        let owns_db = DB.get().is_none();
        if owns_db {
            let _ = std::fs::remove_dir_all(&dir);
            init(dir.clone()).expect("init storage");
        }

        let secret = "sk-test-1234567890";
        let row =
            save_provider(None, &draft("Mock 服务商", Some(secret), None)).expect("save provider");
        assert_eq!(row.api_key_masked, "sk-t...7890");
        assert!(row.has_key);
        assert!(!row.key_error);
        // 密文不应包含明文
        assert!(!row.api_key_enc.contains(secret));

        let decrypted = decrypt_secret(&row.api_key_enc).expect("decrypt");
        assert_eq!(decrypted, secret);

        let list = list_providers().expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "Mock 服务商");

        // M2：编辑/变换模板 JSON 列往返（保存 → 重读 → 清空写回）
        let spec = template_spec_json(
            "https://api.example.com/edit",
            "{\"m\":\"{{mask}}\"}",
            "data.0.url",
        );
        let mut tpl_draft = draft("模板服务商", None, None);
        tpl_draft.kind = "template";
        tpl_draft.edit_template_json = &spec;
        let tpl = save_provider(None, &tpl_draft).expect("save template provider");
        assert_eq!(tpl.edit_template_json, spec);
        assert_eq!(tpl.transform_template_json, "");
        let reloaded = get_provider(tpl.id)
            .unwrap()
            .expect("template provider exists");
        assert_eq!(reloaded.edit_template_json, spec);
        assert_eq!(reloaded.transform_template_json, "");
        tpl_draft.edit_template_json = "";
        let cleared = save_provider(Some(tpl.id), &tpl_draft).expect("clear template spec");
        assert_eq!(cleared.edit_template_json, "");
        delete_provider(tpl.id).unwrap();

        // 不传 Key 更新时保留旧密文
        let updated =
            save_provider(Some(row.id), &draft("改名", None, None)).expect("update without key");
        assert_eq!(decrypt_secret(&updated.api_key_enc).unwrap(), secret);
        assert_eq!(updated.timeout_secs, 60);

        // R2：主密钥变化后旧密文解密失败 → key_error 标记透出，而非静默空 Key
        std::env::set_var(MASTER_KEY_ENV, "bb".repeat(32));
        let broken = get_provider(row.id).expect("get").expect("row exists");
        assert!(broken.key_error);
        assert!(!broken.has_key);
        assert_eq!(broken.api_key_masked, "****");
        // 用当前主密钥重新加密后可恢复
        let re_saved =
            save_provider(Some(row.id), &draft("改名", Some(secret), None)).expect("re-save key");
        assert!(!re_saved.key_error);
        std::env::set_var(MASTER_KEY_ENV, "aa".repeat(32));

        // 设置项
        set_setting("defaultProviderId", "42").unwrap();
        assert_eq!(
            get_setting("defaultProviderId").unwrap().as_deref(),
            Some("42")
        );

        // R5：import_config 事务 + 替换语义 + extraParams 恢复
        set_setting(&format!("extraParams:{}", row.id), r#"{"steps":30}"#).unwrap();
        let data = serde_json::json!({
            "version": 1,
            "providers": [{
                "name": "导入的服务商",
                "baseUrl": "https://api.example.com",
                "apiKey": "sk-imported-0000",
                "kind": "openai",
                "modelsJson": "[\"m1\"]",
                "defaultModel": "m1",
                "timeoutSecs": 30,
                "templateUrl": "",
                "templateBody": "",
                "templateResponsePath": "",
                "editTemplateUrl": "https://api.example.com/edit?img={{image}}",
                "editTemplateBody": "{\"mask\":\"{{mask}}\"}",
                "editTemplateResponsePath": "data.0.url",
                "transformTemplateUrl": "https://api.example.com/up",
                "transformTemplateBody": "{\"scale\":{{scale}}}",
                "transformTemplateResponsePath": "",
                "extraParams": r#"{"quality":"high"}"#,
            }],
            "settings": { "defaultProviderId": "7" },
        });
        let count = import_config(&data).expect("import");
        assert_eq!(count, 1);
        let after = list_providers().unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].name, "导入的服务商");
        assert_eq!(after[0].timeout_secs, 30);
        // M2：模板列随备份导入还原
        let edit_spec: serde_json::Value =
            serde_json::from_str(&after[0].edit_template_json).expect("edit spec json");
        assert_eq!(
            edit_spec["url"],
            "https://api.example.com/edit?img={{image}}"
        );
        assert_eq!(edit_spec["body"], "{\"mask\":\"{{mask}}\"}");
        assert_eq!(edit_spec["responsePath"], "data.0.url");
        let transform_spec: serde_json::Value =
            serde_json::from_str(&after[0].transform_template_json).expect("transform spec json");
        assert_eq!(transform_spec["url"], "https://api.example.com/up");
        assert_eq!(transform_spec["body"], "{\"scale\":{{scale}}}");
        assert_eq!(transform_spec["responsePath"], "");
        // 旧服务商及其 extraParams 已随替换删除
        assert!(get_setting(&format!("extraParams:{}", row.id))
            .unwrap()
            .is_none());
        // 新服务商的 extraParams 已恢复
        assert_eq!(
            get_setting(&format!("extraParams:{}", after[0].id))
                .unwrap()
                .as_deref(),
            Some(r#"{"quality":"high"}"#)
        );
        // P0-2：旧格式导出（provider 无 id）无法映射 defaultProviderId，导入后应清除而非悬空
        assert!(get_setting("defaultProviderId").unwrap().is_none());

        // 替换语义：导入空 providers 数组 = 清空全部服务商
        let empty = serde_json::json!({ "version": 1, "providers": [] });
        import_config(&empty).unwrap();
        assert!(list_providers().unwrap().is_empty());

        // 历史记录
        let hid = add_history(&HistoryRow {
            id: 0,
            prompt: "a cat".into(),
            negative_prompt: String::new(),
            model: "mock-draw-v1".into(),
            provider_name: "Mock".into(),
            seed: Some(7),
            width: 1024,
            height: 1024,
            guidance: 7.5,
            steps: 30,
            style: String::new(),
            file_path: "/tmp/x.png".into(),
            favorite: false,
            created_at: "1".into(),
            parent_id: None,
            op: "generate".into(),
        })
        .unwrap();
        let history = list_history(10, 0, None, "", "", false).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].id, hid);
        assert_eq!(history[0].seed, Some(7));
        set_favorite(hid, true).unwrap();
        assert!(list_history(10, 0, None, "", "", false).unwrap()[0].favorite);
        let plan = delete_history(hid).unwrap();
        assert_eq!(plan.file_path.as_deref(), Some("/tmp/x.png"));
        assert!(!plan.still_referenced, "无消息引用时应允许回收文件");
        assert!(list_history(10, 0, None, "", "", false).unwrap().is_empty());

        // 迁移 007：派生图血统 —— 父图 + 放大子图，list_derived 以根为单位返回同族
        let parent = add_history(&HistoryRow {
            id: 0,
            prompt: "root".into(),
            negative_prompt: String::new(),
            model: "mock-draw-v1".into(),
            provider_name: "Mock".into(),
            seed: None,
            width: 1024,
            height: 1024,
            guidance: 0.0,
            steps: 0,
            style: String::new(),
            file_path: "/tmp/root.png".into(),
            favorite: false,
            created_at: "2".into(),
            parent_id: None,
            op: "generate".into(),
        })
        .unwrap();
        let child = add_history(&HistoryRow {
            id: 0,
            prompt: "upscale 2x".into(),
            negative_prompt: String::new(),
            model: "mock-draw-v1".into(),
            provider_name: "Mock".into(),
            seed: None,
            width: 2048,
            height: 2048,
            guidance: 0.0,
            steps: 0,
            style: String::new(),
            file_path: "/tmp/child.png".into(),
            favorite: false,
            created_at: "3".into(),
            parent_id: Some(parent),
            op: "upscale".into(),
        })
        .unwrap();
        let family = list_derived(child).unwrap();
        assert_eq!(
            family.iter().map(|r| r.id).collect::<Vec<_>>(),
            vec![parent, child]
        );
        assert_eq!(family[1].parent_id, Some(parent));
        assert_eq!(family[1].op, "upscale");
        // 从父图查同族结果一致（根节点不因入参不同而变）
        assert_eq!(list_derived(parent).unwrap().len(), 2);
        assert!(list_derived(999_999).unwrap().is_empty());

        delete_provider(after[0].id).unwrap();
        assert!(list_providers().unwrap().is_empty());

        std::env::remove_var(MASTER_KEY_ENV);
        if owns_db {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// P0-2：缺 providers 数组必须在任何 DELETE 之前拒绝，表内旧数据保持不变
    #[test]
    fn import_config_requires_providers_array() {
        let mut c = mem_conn();
        c.execute(
            "INSERT INTO providers (name, base_url, api_key_enc) VALUES ('旧服务商', '', '')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO settings (key, value) VALUES ('defaultProviderId', '1')",
            [],
        )
        .unwrap();
        // 缺失与类型错误都必须报错，且错误文案指明已取消导入
        for bad in [
            serde_json::json!({ "version": 1 }),
            serde_json::json!({ "version": 1, "providers": "oops" }),
        ] {
            let err = import_config_in(&mut c, &bad).expect_err("providers 非法应报错");
            assert!(err.to_string().contains("缺少 providers 数组"), "{err}");
            assert_eq!(count_providers(&c), 1);
            assert_eq!(setting_of(&c, "defaultProviderId").as_deref(), Some("1"));
        }
    }

    /// P0-2：导入后 extraParams 必须挂到新自增 id 上，不能留在旧 id
    #[test]
    fn import_config_realigns_extra_params_to_new_ids() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var(MASTER_KEY_ENV, "aa".repeat(32));
        let mut c = mem_conn();
        c.execute(
            "INSERT INTO providers (name, base_url, api_key_enc) VALUES ('旧服务商', '', '')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO settings (key, value) VALUES ('extraParams:1', '{\"old\":true}')",
            [],
        )
        .unwrap();
        let data = serde_json::json!({
            "version": 1,
            "providers": [{
                "id": 5,
                "name": "新服务商",
                "extraParams": r#"{"quality":"high"}"#,
            }],
        });
        import_config_in(&mut c, &data).expect("import");
        let new_id = provider_id_by_name(&c, "新服务商");
        assert_ne!(new_id, 1);
        assert_eq!(
            setting_of(&c, &format!("extraParams:{new_id}")).as_deref(),
            Some(r#"{"quality":"high"}"#)
        );
        // 旧 id 的 extraParams 随替换语义一并删除
        assert!(setting_of(&c, "extraParams:1").is_none());
        std::env::remove_var(MASTER_KEY_ENV);
    }

    /// P0-2：defaultProviderId 按旧 id → 新 id 重映射，其它设置原样恢复
    #[test]
    fn import_config_maps_default_provider_id_to_new_id() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var(MASTER_KEY_ENV, "aa".repeat(32));
        let mut c = mem_conn();
        let data = serde_json::json!({
            "version": 1,
            "providers": [
                { "id": 5, "name": "A" },
                { "id": 9, "name": "B" },
            ],
            "settings": { "defaultProviderId": "9", "defaultParams": "{\"steps\":30}" },
        });
        import_config_in(&mut c, &data).expect("import");
        let b_id = provider_id_by_name(&c, "B").to_string();
        assert_eq!(
            setting_of(&c, "defaultProviderId").as_deref(),
            Some(b_id.as_str())
        );
        assert_eq!(
            setting_of(&c, "defaultParams").as_deref(),
            Some("{\"steps\":30}")
        );
        std::env::remove_var(MASTER_KEY_ENV);
    }

    /// P0-2：旧格式导出（provider 无 id）无法映射 defaultProviderId，导入后清除该设置
    #[test]
    fn import_config_clears_default_provider_id_for_legacy_export() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var(MASTER_KEY_ENV, "aa".repeat(32));
        let mut c = mem_conn();
        c.execute(
            "INSERT INTO settings (key, value) VALUES ('defaultProviderId', '7')",
            [],
        )
        .unwrap();
        let data = serde_json::json!({
            "version": 1,
            "providers": [{ "name": "旧格式服务商" }],
            "settings": { "defaultProviderId": "7", "defaultParams": "{}" },
        });
        import_config_in(&mut c, &data).expect("import");
        assert!(setting_of(&c, "defaultProviderId").is_none());
        // 其它设置项照旧写入
        assert_eq!(setting_of(&c, "defaultParams").as_deref(), Some("{}"));
        std::env::remove_var(MASTER_KEY_ENV);
    }

    /// v2：无 Key 导入按 name+baseUrl 复用旧密文；主题 / 模板 / 思考配置恢复，
    /// 思考模型 providerId 重映射到新 id 且密文保留
    #[test]
    fn import_config_v2_reuses_keys_and_restores_settings() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var(MASTER_KEY_ENV, "aa".repeat(32));
        let mut c = mem_conn();
        let old_enc = encrypt_secret("sk-old-secret").unwrap();
        c.execute(
            "INSERT INTO providers (name, base_url, api_key_enc)
             VALUES ('同机服务商', 'https://api.example.com', ?1)",
            params![old_enc],
        )
        .unwrap();
        let old_pid: i64 = c.last_insert_rowid();
        let thinking = serde_json::json!({
            "enabled": true,
            "mode": "reuse",
            "providerId": old_pid,
            "baseUrl": "https://api.example.com",
            "model": "gpt-4o-mini",
            "apiKeyEnc": encrypt_secret("thinking-secret").unwrap(),
        });
        c.execute(
            "INSERT INTO settings (key, value) VALUES ('thinkingConfig', ?1)",
            params![thinking.to_string()],
        )
        .unwrap();

        let data = serde_json::json!({
            "version": 2,
            "exportedAt": "1.000",
            "providers": [
                {
                    "id": 9,
                    "name": "同机服务商",
                    "baseUrl": "https://api.example.com",
                    "apiKey": "",
                    "hasKey": true,
                    "kind": "openai",
                    "defaultModel": "gpt-image-1",
                },
                {
                    "id": 10,
                    "name": "新服务商",
                    "baseUrl": "https://new.example.com",
                    "apiKey": "sk-new-secret",
                    "kind": "openai",
                },
            ],
            "settings": {
                "defaultProviderId": "9",
                "theme": "dark",
                "glassAppearance": "tinted",
                "locale": "en-US",
                "bodyIdleTimeoutSecs": "45",
                "bodyTotalTimeoutSecs": "900",
                "promptTemplates": r#"[{"id":"my","title":"我的模板","text":"a {subject}"}]"#,
                "stylePresets": r#"[{"id":"c_1","label":"我的风格","prompt":"warm tones"}]"#,
                "unknownKey": "ignored",
            },
            "thinking": {
                "enabled": true,
                "mode": "reuse",
                "providerId": 9,
                "baseUrl": "https://api.example.com",
                "model": "gpt-4o-mini",
            },
        });
        import_config_in(&mut c, &data).expect("import v2");

        let reused_id = provider_id_by_name(&c, "同机服务商");
        let reused_enc: String = c
            .query_row(
                "SELECT api_key_enc FROM providers WHERE id = ?1",
                params![reused_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(decrypt_secret(&reused_enc).unwrap(), "sk-old-secret");
        let new_id = provider_id_by_name(&c, "新服务商");
        let new_enc: String = c
            .query_row(
                "SELECT api_key_enc FROM providers WHERE id = ?1",
                params![new_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(decrypt_secret(&new_enc).unwrap(), "sk-new-secret");

        assert_eq!(setting_of(&c, "theme").as_deref(), Some("dark"));
        let default_id = setting_of(&c, "defaultProviderId").expect("默认服务商已恢复");
        assert_eq!(default_id, reused_id.to_string());
        assert!(setting_of(&c, "promptTemplates")
            .expect("模板已导入")
            .contains("我的模板"));
        assert!(setting_of(&c, "stylePresets")
            .expect("风格已导入")
            .contains("我的风格"));
        // 白名单外的设置项不落库
        assert!(setting_of(&c, "unknownKey").is_none());
        assert_eq!(
            setting_of(&c, "glassAppearance").as_deref(),
            Some("tinted"),
            "玻璃质感随备份往返"
        );
        assert_eq!(
            setting_of(&c, "locale").as_deref(),
            Some("en-US"),
            "界面语言随备份往返"
        );
        assert_eq!(
            setting_of(&c, "bodyIdleTimeoutSecs").as_deref(),
            Some("45"),
            "响应体无数据超时随备份往返"
        );
        assert_eq!(
            setting_of(&c, "bodyTotalTimeoutSecs").as_deref(),
            Some("900"),
            "响应体总超时随备份往返"
        );

        let raw = setting_of(&c, "thinkingConfig").expect("思考配置已导入");
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["providerId"].as_i64(), Some(reused_id));
        assert_eq!(v["model"].as_str(), Some("gpt-4o-mini"));
        // 密文沿用本机旧值，换机导入不会丢思考模型 Key
        assert_eq!(
            decrypt_secret(v["apiKeyEnc"].as_str().unwrap()).unwrap(),
            "thinking-secret"
        );
        std::env::remove_var(MASTER_KEY_ENV);
    }

    /// v2：非法主题 / 模板 / 思考配置必须在 DELETE 前拒绝，旧数据保持不变
    #[test]
    fn import_config_v2_validates_before_delete() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var(MASTER_KEY_ENV, "aa".repeat(32));
        let mut c = mem_conn();
        c.execute(
            "INSERT INTO providers (name, base_url, api_key_enc) VALUES ('旧服务商', '', '')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO settings (key, value) VALUES ('theme', 'light')",
            [],
        )
        .unwrap();
        let bad_settings = [
            (serde_json::json!({ "theme": "purple" }), "主题取值非法"),
            (
                serde_json::json!({ "glassAppearance": "blurred" }),
                "玻璃质感取值非法",
            ),
            (serde_json::json!({ "locale": "fr-FR" }), "界面语言取值非法"),
            (
                serde_json::json!({ "promptTemplates": "not-json" }),
                "自定义模板",
            ),
            (
                serde_json::json!({ "promptTemplates": "[{\"id\":\"a\"}]" }),
                "自定义模板",
            ),
            (
                serde_json::json!({ "stylePresets": "[{\"id\":\"c_1\",\"label\":\"A\"}]" }),
                "自定义风格",
            ),
            (
                serde_json::json!({ "bodyIdleTimeoutSecs": "4" }),
                "无数据超时",
            ),
            (
                serde_json::json!({ "bodyTotalTimeoutSecs": "1801" }),
                "总超时",
            ),
            (
                serde_json::json!({
                    "bodyIdleTimeoutSecs": "60",
                    "bodyTotalTimeoutSecs": "30"
                }),
                "不能小于",
            ),
        ];
        for (settings, needle) in bad_settings {
            let data = serde_json::json!({
                "version": 2,
                "providers": [{ "name": "新服务商" }],
                "settings": settings,
            });
            let err = import_config_in(&mut c, &data).expect_err("应拒绝导入");
            assert!(err.to_string().contains(needle), "{err}");
            assert_eq!(count_providers(&c), 1);
            assert_eq!(setting_of(&c, "theme").as_deref(), Some("light"));
        }
        let bad_thinking = serde_json::json!({
            "version": 2,
            "providers": [],
            "thinking": { "enabled": true, "mode": "weird" },
        });
        let err = import_config_in(&mut c, &bad_thinking).expect_err("应拒绝导入");
        assert!(err.to_string().contains("思考模型"), "{err}");
        assert_eq!(count_providers(&c), 1);
        std::env::remove_var(MASTER_KEY_ENV);
    }

    /// 缓存保留天数：缺省 30，合法值生效，脏值/越界回退默认
    #[test]
    fn cache_retention_days_defaults_and_validates() {
        let c = mem_conn();
        assert_eq!(cache_retention_days_in(&c), DEFAULT_CACHE_RETENTION_DAYS);
        for (raw, expected) in [
            ("7", 7),
            ("365", 365),
            (" 1 ", 1),
            ("0", DEFAULT_CACHE_RETENTION_DAYS),
            ("366", DEFAULT_CACHE_RETENTION_DAYS),
            ("abc", DEFAULT_CACHE_RETENTION_DAYS),
        ] {
            c.execute(
                "INSERT INTO settings (key, value) VALUES ('cacheRetentionDays', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![raw],
            )
            .unwrap();
            assert_eq!(cache_retention_days_in(&c), expected, "raw={raw}");
        }
    }

    /// 响应体超时：缺省 30/300，合法值生效，脏值/越界回退默认，总时长不低于空闲
    #[test]
    fn body_timeout_secs_defaults_and_validates() {
        let c = mem_conn();
        assert_eq!(
            body_timeout_secs_in(&c),
            (
                DEFAULT_BODY_IDLE_TIMEOUT_SECS,
                DEFAULT_BODY_TOTAL_TIMEOUT_SECS
            )
        );
        let set = |key: &str, value: &str| {
            c.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .unwrap();
        };
        set("bodyIdleTimeoutSecs", "45");
        set("bodyTotalTimeoutSecs", "900");
        assert_eq!(body_timeout_secs_in(&c), (45, 900));
        for bad in ["4", "301", "abc"] {
            set("bodyIdleTimeoutSecs", bad);
            assert_eq!(
                body_timeout_secs_in(&c),
                (DEFAULT_BODY_IDLE_TIMEOUT_SECS, 900),
                "idle={bad}"
            );
        }
        set("bodyIdleTimeoutSecs", "45");
        set("bodyTotalTimeoutSecs", "40");
        assert_eq!(
            body_timeout_secs_in(&c),
            (45, 45),
            "总超时低于空闲时应抬到空闲值"
        );
    }

    /// C2：v3 备份导入恢复整组 Key 与失效状态；不含 Key 的备份沿用本机整组密文
    #[test]
    fn import_v3_roundtrip_keeps_keys_and_invalid_state() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var(MASTER_KEY_ENV, "ee".repeat(32));
        let mut c = mem_conn();
        let provider = |keys: serde_json::Value, invalid: serde_json::Value| {
            serde_json::json!({
                "name": "P",
                "baseUrl": "https://api.example.com",
                "kind": "openai",
                "hasKeys": 3,
                "apiKeys": keys,
                "invalidKeyIndexes": invalid,
                "modelsJson": "[\"m1\"]",
                "defaultModel": "m1",
                "timeoutSecs": 30,
                "templateUrl": "",
                "templateBody": "",
                "templateResponsePath": "",
            })
        };
        let data = serde_json::json!({
            "version": 3,
            "providers": [provider(
                serde_json::json!(["sk-a", "sk-b", "sk-c"]),
                serde_json::json!([1]),
            )],
            "settings": {},
            "network": {
                "mode": "manual",
                "url": "http://127.0.0.1:7890",
                "noProxy": "localhost",
            },
        });
        import_config_in(&mut c, &data).expect("import v3");

        let read_keys = |c: &Connection| -> Vec<ProviderKey> {
            let (keys_enc, first): (String, String) = c
                .query_row("SELECT api_keys_enc, api_key_enc FROM providers", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .unwrap();
            decode_keys(&keys_enc, &first).expect("decode keys")
        };
        let keys = read_keys(&c);
        assert_eq!(
            keys.iter().map(|k| k.key.as_str()).collect::<Vec<_>>(),
            vec!["sk-a", "sk-b", "sk-c"]
        );
        assert!(!keys[0].invalid);
        assert!(keys[1].invalid, "失效下标必须随备份恢复");
        assert!(!keys[2].invalid);

        // 代理只恢复非密钥字段，密码永远不来自备份
        let net: serde_json::Value =
            serde_json::from_str(&setting_of(&c, "networkProxy").expect("networkProxy")).unwrap();
        assert_eq!(net["mode"], "manual");
        assert_eq!(net["url"], "http://127.0.0.1:7890");
        assert_eq!(net["noProxy"], "localhost");
        assert_eq!(net["passwordEnc"], "");

        // includeKeys=false 的备份（apiKeys 为空）：按 name+baseUrl 复用本机整组 Key
        let no_keys = serde_json::json!({
            "version": 3,
            "providers": [provider(serde_json::json!([]), serde_json::json!([]))],
            "settings": {},
        });
        import_config_in(&mut c, &no_keys).expect("import v3 without keys");
        let keys = read_keys(&c);
        assert_eq!(keys.len(), 3);
        assert!(keys[1].invalid);
        std::env::remove_var(MASTER_KEY_ENV);
    }

    /// C2：v3 的 Key 字段类型错误必须在事务与 DELETE 之前被拒绝
    #[test]
    fn import_v3_rejects_bad_keys_before_touching_data() {
        let mut c = mem_conn();
        c.execute(
            "INSERT INTO providers (name, base_url, api_key_enc) VALUES ('旧', '', '')",
            [],
        )
        .unwrap();
        for bad in [
            serde_json::json!({
                "version": 3,
                "providers": [{ "name": "P", "baseUrl": "", "apiKeys": "oops" }],
                "settings": {},
            }),
            serde_json::json!({
                "version": 3,
                "providers": [{ "name": "P", "baseUrl": "", "apiKeys": [], "invalidKeyIndexes": ["x"] }],
                "settings": {},
            }),
            serde_json::json!({
                "version": 3,
                "providers": [{ "name": "P", "baseUrl": "", "apiKeys": [] }],
                "settings": {},
                "network": { "mode": "manual", "url": "socks5://127.0.0.1:1080" },
            }),
        ] {
            import_config_in(&mut c, &bad).expect_err("非法 Key/代理配置应拒绝导入");
            assert_eq!(count_providers(&c), 1, "拒绝时不得删除旧数据");
        }
    }

    /// M9：v4 备份导入替换收藏与预设，参考图经注入闭包重新落盘
    #[test]
    fn import_v4_replaces_prompt_assets() {
        let mut c = mem_conn();
        upsert_favorite_in(&c, "旧收藏", &["old".into()]).unwrap();
        save_preset_in(&c, None, "旧预设", "", "", "{}", &[]).unwrap();

        let data = serde_json::json!({
            "version": 4,
            "providers": [{ "name": "P", "baseUrl": "" }],
            "settings": {},
            "favorites": [
                { "text": "a cat", "tags": ["动物", "橘猫"], "createdAt": "1700000000" },
                { "text": "a cat", "tags": ["去重"], "createdAt": "1700000001" },
            ],
            "presets": [{
                "name": "夜景",
                "prompt": "city at night",
                "negativePrompt": "blur",
                "params": { "ratio": "16:9" },
                "refs": [
                    { "role": "style", "strength": 80, "dataUrl": "data:image/png;base64,AAAA" },
                    { "role": "composition", "strength": 20, "dataUrl": "data:image/png;base64,BBBB" },
                ],
            }],
        });
        let written: Mutex<Vec<String>> = Mutex::new(Vec::new());
        let write = |data_url: &str| -> AppResult<String> {
            let mut w = written.lock().unwrap();
            w.push(data_url.to_string());
            Ok(format!("C:/refs/ref-{}.png", w.len()))
        };
        import_config_in_with_refs(&mut c, &data, Some(&write)).expect("import v4");

        let favs = list_favorites_in(&c).unwrap();
        assert_eq!(favs.len(), 1, "重复文本只保留一条收藏");
        assert_eq!(favs[0].text, "a cat");
        assert_eq!(favs[0].tags, vec!["去重".to_string()]);
        let presets = list_presets_in(&c).unwrap();
        assert_eq!(presets.len(), 1, "旧预设必须被替换");
        assert_eq!(presets[0].name, "夜景");
        assert_eq!(presets[0].params_json, r#"{"ratio":"16:9"}"#);
        assert_eq!(presets[0].refs.len(), 2);
        assert_eq!(presets[0].refs[0].path, "C:/refs/ref-1.png");
        assert_eq!(presets[0].refs[0].role, "style");
        assert_eq!(presets[0].refs[0].strength, 80);
        assert_eq!(written.lock().unwrap().len(), 2);
    }

    /// M9：v4 资产非法时在事务与 DELETE 之前失败，旧收藏/预设保持原样
    #[test]
    fn import_v4_rejects_bad_assets_before_delete() {
        let mut c = mem_conn();
        upsert_favorite_in(&c, "旧收藏", &[]).unwrap();
        save_preset_in(&c, None, "旧预设", "", "", "{}", &[]).unwrap();
        let provider = serde_json::json!({ "name": "P", "baseUrl": "" });
        let five_refs: Vec<serde_json::Value> = (0..=MAX_PRESET_REFS)
            .map(|_| {
                serde_json::json!({
                    "role": "style",
                    "strength": 60,
                    "dataUrl": "data:image/png;base64,AAAA",
                })
            })
            .collect();
        for bad in [
            serde_json::json!({
                "version": 4, "providers": [provider.clone()], "settings": {},
                "favorites": [], "presets": {},
            }),
            serde_json::json!({
                "version": 4, "providers": [provider.clone()], "settings": {},
                "favorites": [], "presets": [{ "name": "  " }],
            }),
            serde_json::json!({
                "version": 4, "providers": [provider.clone()], "settings": {},
                "favorites": [], "presets": [{
                    "name": "n",
                    "refs": [{ "role": "style", "strength": 60, "dataUrl": "not-an-image" }],
                }],
            }),
            serde_json::json!({
                "version": 4, "providers": [provider.clone()], "settings": {},
                "favorites": [], "presets": [{ "name": "n", "refs": five_refs }],
            }),
            serde_json::json!({
                "version": 4, "providers": [provider.clone()], "settings": {},
                "favorites": "oops", "presets": [],
            }),
        ] {
            import_config_in(&mut c, &bad).expect_err("非法 v4 资产必须拒绝导入");
            assert_eq!(list_favorites_in(&c).unwrap().len(), 1);
            assert_eq!(list_presets_in(&c).unwrap().len(), 1);
            assert_eq!(count_providers(&c), 0, "拒绝时不得删除旧服务商");
        }
    }

    /// M9：v1–v3 备份不触碰本机收藏与预设
    #[test]
    fn import_v3_leaves_prompt_assets_untouched() {
        let mut c = mem_conn();
        upsert_favorite_in(&c, "本机收藏", &["keep".into()]).unwrap();
        save_preset_in(&c, None, "本机预设", "", "", "{}", &[]).unwrap();
        let data = serde_json::json!({
            "version": 3,
            "providers": [{ "name": "P", "baseUrl": "" }],
            "settings": {},
            "favorites": [],
            "presets": [],
        });
        import_config_in(&mut c, &data).expect("import v3");
        assert_eq!(list_favorites_in(&c).unwrap().len(), 1);
        assert_eq!(list_presets_in(&c).unwrap().len(), 1);
    }
}
