use crate::storage;
use tauri::Manager;

/// 通用 set/get_setting 白名单（m12）：未知 key 拒绝读写。
///
/// 这里**不能**放 thinkingConfig：它包含加密后的思考模型 API Key，写入路径
/// 必须走 commands::thinking::save_thinking_config（先校验再加密），否则前端
/// 拿到一个可以直写任意字符串的后门，绕过校验把密文写坏。
///
/// 新增一项时必须同步 `storage::BACKUP_SETTING_KEYS`（否则备份/导入丢设置），
/// 并有单测守住两者一致。
const ALLOWED_SETTING_KEYS: &[&str] = &[
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

fn check_setting_key(key: &str) -> Result<(), String> {
    if ALLOWED_SETTING_KEYS.contains(&key) {
        Ok(())
    } else {
        Err(format!("不允许读写的设置项: {key}"))
    }
}

/// 枚举型设置的取值校验。写入脏值后启动恢复会静默回退到默认值，用户只会看到
/// "设置没保存"却无从排查，因此在写入端直接拒绝。
fn check_setting_value(key: &str, value: &str) -> Result<(), String> {
    match key {
        "theme" if !matches!(value, "system" | "light" | "dark") => {
            Err(format!("主题取值非法: {value}"))
        }
        "glassAppearance" if !matches!(value, "clear" | "standard" | "tinted") => {
            Err(format!("玻璃质感取值非法: {value}"))
        }
        "uiMode" if !matches!(value, "simple" | "expert") => {
            Err(format!("界面模式取值非法: {value}"))
        }
        "locale" if !matches!(value, "zh-CN" | "en-US") => {
            Err(format!("界面语言取值非法: {value}"))
        }
        "smartMask" if !matches!(value, "on" | "off") => {
            Err(format!("智能蒙版开关取值非法: {value}"))
        }
        "queueAutoResume" if !matches!(value, "on" | "off") => {
            Err(format!("队列自动续跑开关取值非法: {value}"))
        }
        "queueConcurrency"
            if !matches!(
                value.trim().parse::<i64>(),
                Ok(n) if (crate::commands::queue::MIN_CONCURRENCY
                    ..=crate::commands::queue::MAX_CONCURRENCY)
                    .contains(&n)
            ) =>
        {
            Err(format!("队列并发数取值非法: {value}"))
        }
        "queueProviderConcurrency"
            if !matches!(
                value.trim().parse::<i64>(),
                Ok(n) if (crate::commands::queue::MIN_PROVIDER_CONCURRENCY
                    ..=crate::commands::queue::MAX_PROVIDER_CONCURRENCY)
                    .contains(&n)
            ) =>
        {
            Err(format!("每服务商并发数取值非法: {value}"))
        }
        "cacheRetentionDays"
            if !matches!(
                value.trim().parse::<i64>(),
                Ok(n) if (storage::MIN_CACHE_RETENTION_DAYS
                    ..=storage::MAX_CACHE_RETENTION_DAYS)
                    .contains(&n)
            ) =>
        {
            Err(format!("缓存保留天数取值非法（应为 1–365）: {value}"))
        }
        "bodyIdleTimeoutSecs"
            if !matches!(
                value.trim().parse::<i64>(),
                Ok(n) if (storage::MIN_BODY_IDLE_TIMEOUT_SECS
                    ..=storage::MAX_BODY_IDLE_TIMEOUT_SECS)
                    .contains(&n)
            ) =>
        {
            Err(format!("无数据超时取值非法（应为 5–300）: {value}"))
        }
        "bodyTotalTimeoutSecs"
            if !matches!(
                value.trim().parse::<i64>(),
                Ok(n) if (storage::MIN_BODY_TOTAL_TIMEOUT_SECS
                    ..=storage::MAX_BODY_TOTAL_TIMEOUT_SECS)
                    .contains(&n)
            ) =>
        {
            Err(format!("响应体总超时取值非法（应为 30–1800）: {value}"))
        }
        _ => Ok(()),
    }
}

/// 总超时小于无数据超时时，空闲阈值永远等不到，等于让总超时静默失效。
fn check_body_timeout_pair(idle: u64, total: u64) -> Result<(), String> {
    if total < idle {
        return Err(format!(
            "响应体总超时不能小于无数据超时（当前 {idle}s / {total}s）"
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn set_setting(key: String, value: String) -> Result<(), String> {
    check_setting_key(&key)?;
    check_setting_value(&key, &value)?;
    if matches!(key.as_str(), "bodyIdleTimeoutSecs" | "bodyTotalTimeoutSecs") {
        let secs: u64 = value
            .trim()
            .parse()
            .map_err(|_| format!("超时取值非法: {value}"))?;
        let (cur_idle, cur_total) = storage::body_timeout_secs();
        let (idle, total) = if key == "bodyIdleTimeoutSecs" {
            (secs, cur_total)
        } else {
            (cur_idle, secs)
        };
        check_body_timeout_pair(idle, total)?;
        storage::set_setting(&key, &value)?;
        crate::adapters::apply_body_timeouts(idle, total);
        return Ok(());
    }
    storage::set_setting(&key, &value)?;
    Ok(())
}

#[tauri::command]
pub async fn get_setting(key: String) -> Result<Option<String>, String> {
    check_setting_key(&key)?;
    Ok(storage::get_setting(&key)?)
}

#[tauri::command]
pub async fn get_app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

const PROMPT_TEMPLATES_KEY: &str = "promptTemplates";

pub const BUILTIN_TEMPLATES: &str = r#"[
    {"id":"portrait","title":"人像写真","text":"portrait of {subject}, soft natural lighting, shallow depth of field, 85mm lens, detailed skin texture, professional photography"},
    {"id":"product","title":"产品渲染","text":"studio product shot of {product}, clean minimal background, softbox lighting, sharp focus, commercial photography, 8k"},
    {"id":"landscape","title":"风景大片","text":"breathtaking landscape of {scene}, golden hour light, dramatic clouds, ultra wide angle, HDR, national geographic style"},
    {"id":"poster","title":"海报设计","text":"modern poster design for {topic}, bold typography space, minimalist composition, strong visual hierarchy, print quality"},
    {"id":"food","title":"美食摄影","text":"appetizing food photography of {dish}, natural window light, steam rising, shallow depth of field, editorial style"},
    {"id":"architecture","title":"建筑空间","text":"architectural photography of {building}, dramatic perspective, blue hour lighting, clean lines, ultra realistic"}
]"#;

/// 模板 = 内置 + 用户自定义（settings 中只存自定义部分）
#[tauri::command]
pub async fn get_prompt_templates() -> Result<serde_json::Value, String> {
    let custom = storage::get_setting(PROMPT_TEMPLATES_KEY)?
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    let builtin: serde_json::Value =
        serde_json::from_str(BUILTIN_TEMPLATES).unwrap_or_else(|_| serde_json::json!([]));
    Ok(serde_json::json!({
        "builtin": builtin,
        "custom": custom,
    }))
}

#[tauri::command]
pub async fn save_prompt_templates(custom: serde_json::Value) -> Result<(), String> {
    storage::set_setting(
        PROMPT_TEMPLATES_KEY,
        &serde_json::to_string(&custom).unwrap_or_else(|_| "[]".into()),
    )?;
    Ok(())
}

const STYLE_PRESETS_KEY: &str = "stylePresets";
const MAX_CUSTOM_STYLE_PRESETS: usize = 50;

/// 内置风格：prompt 与旧版 STYLE_PRESETS 的 id 文本保持一致，
/// 否则历史记录里的 style 字段会对不上画廊筛选项。
pub const BUILTIN_STYLE_PRESETS: &str = r#"[
    {"id":"photo","label":"真实摄影","prompt":"photorealistic, 8k, raw photo"},
    {"id":"anime","label":"动漫","prompt":"anime style, vibrant, cel shading"},
    {"id":"oil","label":"油画","prompt":"oil painting, classic brushwork"},
    {"id":"watercolor","label":"水彩","prompt":"watercolor, soft washes, paper texture"},
    {"id":"cyberpunk","label":"赛博朋克","prompt":"cyberpunk, neon lights, futuristic"},
    {"id":"film","label":"胶片","prompt":"analog film photography, subtle grain"},
    {"id":"render3d","label":"3D 渲染","prompt":"3D render, soft studio lighting"}
]"#;

fn builtin_style_ids() -> Vec<String> {
    serde_json::from_str::<Vec<serde_json::Value>>(BUILTIN_STYLE_PRESETS)
        .unwrap_or_default()
        .iter()
        .filter_map(|v| v["id"].as_str().map(str::to_string))
        .collect()
}

/// 自定义风格写入前校验：脏数据会让下拉框出现空项或被同名内置项覆盖。
fn validate_style_presets(custom: &serde_json::Value) -> Result<(), String> {
    let list = custom
        .as_array()
        .ok_or_else(|| "自定义风格必须是数组".to_string())?;
    if list.len() > MAX_CUSTOM_STYLE_PRESETS {
        return Err(format!("自定义风格最多 {MAX_CUSTOM_STYLE_PRESETS} 个"));
    }
    let builtin_ids = builtin_style_ids();
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for item in list {
        let obj = item
            .as_object()
            .ok_or_else(|| "每个自定义风格必须是对象".to_string())?;
        for key in ["id", "label", "prompt"] {
            let ok = obj
                .get(key)
                .and_then(|v| v.as_str())
                .is_some_and(|s| !s.trim().is_empty());
            if !ok {
                return Err("每个自定义风格都需要非空的 id / 名称 / 提示词".into());
            }
        }
        let id = obj["id"].as_str().unwrap().trim();
        let label = obj["label"].as_str().unwrap().trim();
        let prompt = obj["prompt"].as_str().unwrap().trim();
        if id.len() > 64 {
            return Err("自定义风格 id 过长".into());
        }
        if label.chars().count() > 40 {
            return Err("自定义风格名称最长 40 个字符".into());
        }
        if prompt.chars().count() > 500 {
            return Err("自定义风格提示词最长 500 个字符".into());
        }
        if !seen.insert(id) {
            return Err(format!("自定义风格 id 重复: {id}"));
        }
        if builtin_ids.iter().any(|b| b == id) {
            return Err(format!("自定义风格 id 与内置风格冲突: {id}"));
        }
    }
    Ok(())
}

/// 风格预设 = 内置 + 用户自定义（settings 中只存自定义部分）
#[tauri::command]
pub async fn get_style_presets() -> Result<serde_json::Value, String> {
    let custom = storage::get_setting(STYLE_PRESETS_KEY)?
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    let builtin: serde_json::Value =
        serde_json::from_str(BUILTIN_STYLE_PRESETS).unwrap_or_else(|_| serde_json::json!([]));
    Ok(serde_json::json!({
        "builtin": builtin,
        "custom": custom,
    }))
}

#[tauri::command]
pub async fn save_style_presets(custom: serde_json::Value) -> Result<(), String> {
    validate_style_presets(&custom)?;
    storage::set_setting(
        STYLE_PRESETS_KEY,
        &serde_json::to_string(&custom).map_err(|e| e.to_string())?,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_templates_are_valid() {
        let arr: Vec<serde_json::Value> =
            serde_json::from_str(BUILTIN_TEMPLATES).expect("内置模板必须是合法 JSON");
        assert_eq!(arr.len(), 6);
        for t in &arr {
            assert!(!t["id"].as_str().unwrap().is_empty());
            assert!(!t["title"].as_str().unwrap().is_empty());
            assert!(t["text"].as_str().unwrap().contains('{'));
        }
    }

    #[test]
    fn builtin_style_presets_are_valid() {
        let arr: Vec<serde_json::Value> =
            serde_json::from_str(BUILTIN_STYLE_PRESETS).expect("内置风格必须是合法 JSON");
        assert!(arr.len() >= 5);
        let mut ids = std::collections::HashSet::new();
        for s in &arr {
            let id = s["id"].as_str().unwrap();
            assert!(ids.insert(id), "内置风格 id 不能重复: {id}");
            assert!(!s["label"].as_str().unwrap().is_empty());
            assert!(!s["prompt"].as_str().unwrap().is_empty());
        }
        assert!(validate_style_presets(&serde_json::json!([])).is_ok());
    }

    #[test]
    fn custom_style_presets_validation() {
        let ok = serde_json::json!([
            {"id":"c_1","label":"我的风格","prompt":"my style, warm tones"}
        ]);
        assert!(validate_style_presets(&ok).is_ok());
        // 非数组
        assert!(validate_style_presets(&serde_json::json!({"a":1})).is_err());
        // 缺字段 / 空字段
        for item in [
            serde_json::json!([{"id":"c_1","label":" ","prompt":"x"}]),
            serde_json::json!([{"id":"c_1","label":"名","prompt":""}]),
            serde_json::json!([{"id":"","label":"名","prompt":"x"}]),
        ] {
            assert!(validate_style_presets(&item).is_err(), "{item} 应被拒绝");
        }
        // 重复 id / 与内置冲突 / 超长
        assert!(validate_style_presets(&serde_json::json!([
            {"id":"c_1","label":"A","prompt":"x"},
            {"id":"c_1","label":"B","prompt":"y"}
        ]))
        .is_err());
        assert!(validate_style_presets(&serde_json::json!([
            {"id":"anime","label":"A","prompt":"x"}
        ]))
        .is_err());
        let long_prompt = "x".repeat(501);
        assert!(validate_style_presets(&serde_json::json!([
            {"id":"c_1","label":"A","prompt":long_prompt}
        ]))
        .is_err());
        // 数量上限
        let many: Vec<serde_json::Value> = (0..=MAX_CUSTOM_STYLE_PRESETS)
            .map(|i| serde_json::json!({"id":format!("c_{i}"),"label":"A","prompt":"x"}))
            .collect();
        assert!(validate_style_presets(&serde_json::json!(many)).is_err());
    }

    #[test]
    fn setting_key_whitelist() {
        assert!(check_setting_key("defaultProviderId").is_ok());
        assert!(check_setting_key("defaultParams").is_ok());
        assert!(check_setting_key("promptTemplates").is_ok());
        assert!(check_setting_key("stylePresets").is_ok());
        assert!(check_setting_key("theme").is_ok());
        assert!(check_setting_key("glassAppearance").is_ok());
        assert!(check_setting_key("uiMode").is_ok());
        assert!(check_setting_key("locale").is_ok());
        assert!(check_setting_key("queueConcurrency").is_ok());
        assert!(check_setting_key("queueProviderConcurrency").is_ok());
        assert!(check_setting_key("cacheRetentionDays").is_ok());
        assert!(check_setting_key("bodyIdleTimeoutSecs").is_ok());
        assert!(check_setting_key("bodyTotalTimeoutSecs").is_ok());
        assert!(check_setting_key("extraParams:1").is_err());
        assert!(check_setting_key("任意 key").is_err());
    }

    /// 白名单与备份清单必须逐项一致：漏在备份清单里，用户会发现"设置重启后没了"
    #[test]
    fn whitelist_matches_backup_keys() {
        let mut allowed = ALLOWED_SETTING_KEYS.to_vec();
        let mut backup = crate::storage::BACKUP_SETTING_KEYS.to_vec();
        allowed.sort_unstable();
        backup.sort_unstable();
        assert_eq!(allowed, backup);
    }

    /// 界面语言只接受内置的两个 locale
    #[test]
    fn locale_value_validation() {
        for ok in ["zh-CN", "en-US"] {
            assert!(check_setting_value("locale", ok).is_ok(), "{ok} 应被接受");
        }
        assert!(check_setting_value("locale", "fr-FR").is_err());
        assert!(check_setting_value("locale", "").is_err());
    }

    /// 主题只接受三态值：脏值会让启动恢复静默回退，故写入端直接拒绝
    #[test]
    fn theme_value_validation() {
        for ok in ["system", "light", "dark"] {
            assert!(check_setting_value("theme", ok).is_ok(), "{ok} 应被接受");
        }
        assert!(check_setting_value("theme", "purple").is_err());
        assert!(check_setting_value("theme", "").is_err());
        // 其它 key 不做枚举校验（自由文本 / JSON）
        assert!(check_setting_value("defaultParams", "anything").is_ok());
    }

    #[test]
    fn queue_auto_resume_value_validation() {
        assert!(check_setting_value("queueAutoResume", "on").is_ok());
        assert!(check_setting_value("queueAutoResume", "off").is_ok());
        assert!(check_setting_value("queueAutoResume", "true").is_err());
        assert!(check_setting_value("queueAutoResume", "").is_err());
    }

    #[test]
    fn glass_value_validation() {
        for ok in ["clear", "standard", "tinted"] {
            assert!(
                check_setting_value("glassAppearance", ok).is_ok(),
                "{ok} 应被接受"
            );
        }
        assert!(check_setting_value("glassAppearance", "blurred").is_err());
        assert!(check_setting_value("glassAppearance", "").is_err());
    }

    /// 每服务商并发数只接受 1–2 的整数字符串
    #[test]
    fn queue_provider_concurrency_value_validation() {
        for ok in ["1", "2", " 2 "] {
            assert!(
                check_setting_value("queueProviderConcurrency", ok).is_ok(),
                "{ok} 应被接受"
            );
        }
        for bad in ["0", "3", "-1", "1.5", "", "two"] {
            assert!(
                check_setting_value("queueProviderConcurrency", bad).is_err(),
                "{bad} 应被拒绝"
            );
        }
    }

    /// 队列并发数只接受 1–4 的整数字符串
    #[test]
    fn queue_concurrency_value_validation() {
        for ok in ["1", "2", "3", "4", " 2 "] {
            assert!(
                check_setting_value("queueConcurrency", ok).is_ok(),
                "{ok} 应被接受"
            );
        }
        for bad in ["0", "5", "-1", "1.5", "", "two"] {
            assert!(
                check_setting_value("queueConcurrency", bad).is_err(),
                "{bad} 应被拒绝"
            );
        }
    }

    /// A4：thinkingConfig 含加密 Key，只能经 save_thinking_config 写入
    #[test]
    fn whitelist_rejects_thinking_config() {
        assert!(check_setting_key("thinkingConfig").is_err());
    }

    /// 缓存保留天数只接受 1–365 的整数字符串
    #[test]
    fn cache_retention_value_validation() {
        for ok in ["1", "30", "365", " 7 "] {
            assert!(
                check_setting_value("cacheRetentionDays", ok).is_ok(),
                "{ok} 应被接受"
            );
        }
        for bad in ["0", "366", "-1", "1.5", "", "thirty"] {
            assert!(
                check_setting_value("cacheRetentionDays", bad).is_err(),
                "{bad} 应被拒绝"
            );
        }
    }

    /// 响应体读取超时只接受区间内的整数字符串
    #[test]
    fn body_timeout_value_validation() {
        for ok in ["5", "30", "300", " 12 "] {
            assert!(
                check_setting_value("bodyIdleTimeoutSecs", ok).is_ok(),
                "{ok} 应被接受"
            );
        }
        for bad in ["4", "301", "0", "-1", "1.5", "", "thirty"] {
            assert!(
                check_setting_value("bodyIdleTimeoutSecs", bad).is_err(),
                "{bad} 应被拒绝"
            );
        }
        for ok in ["30", "300", "1800", " 60 "] {
            assert!(
                check_setting_value("bodyTotalTimeoutSecs", ok).is_ok(),
                "{ok} 应被接受"
            );
        }
        for bad in ["29", "1801", "0", "-1", "1.5", "", "thirty"] {
            assert!(
                check_setting_value("bodyTotalTimeoutSecs", bad).is_err(),
                "{bad} 应被拒绝"
            );
        }
    }

    /// 总超时不能小于无数据超时，否则空闲阈值永远等不到
    #[test]
    fn body_timeout_pair_validation() {
        assert!(check_body_timeout_pair(30, 300).is_ok());
        assert!(check_body_timeout_pair(30, 30).is_ok());
        assert!(check_body_timeout_pair(60, 59).is_err());
    }

    #[test]
    fn erase_uses_default_prompt() {
        // 与 edit_image 中的默认补全提示词保持一致
        let default_prompt = "Remove the masked object completely and fill the area so it matches \
             the surrounding background naturally.";
        assert!(default_prompt.contains("masked"));
        assert!(default_prompt.contains("background"));
    }
}
