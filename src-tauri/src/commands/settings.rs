use crate::storage;
use tauri::Manager;

/// 通用 set/get_setting 白名单（m12）：未知 key 拒绝读写，
/// 避免直通 thinkingConfig 等敏感密文 KV。
const ALLOWED_SETTING_KEYS: &[&str] = &[
    "defaultProviderId",
    "defaultParams",
    "thinkingConfig",
    "promptTemplates",
];

fn check_setting_key(key: &str) -> Result<(), String> {
    if ALLOWED_SETTING_KEYS.contains(&key) {
        Ok(())
    } else {
        Err(format!("不允许读写的设置项: {key}"))
    }
}

#[tauri::command]
pub async fn set_setting(key: String, value: String) -> Result<(), String> {
    check_setting_key(&key)?;
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
    fn setting_key_whitelist() {
        assert!(check_setting_key("defaultProviderId").is_ok());
        assert!(check_setting_key("defaultParams").is_ok());
        assert!(check_setting_key("thinkingConfig").is_ok());
        assert!(check_setting_key("promptTemplates").is_ok());
        assert!(check_setting_key("extraParams:1").is_err());
        assert!(check_setting_key("任意 key").is_err());
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
