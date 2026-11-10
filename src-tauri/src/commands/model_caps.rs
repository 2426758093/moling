use crate::storage;
use std::collections::HashMap;

/// 模型能力元数据：只决定界面开关，不改变请求形状。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelCaps {
    pub negative: bool,
    pub edit: bool,
    pub transform: bool,
    pub max_side: u32,
    pub multi_image: bool,
    /// 是否支持 GIF 输出（gpt-image-2.6 系列默认开，其余需手动勾选）
    pub gif: bool,
    /// GIF 帧数上限：直连 OpenAI 为 16，网关放宽时用户可自行上调
    pub gif_max_frames: u32,
}

impl Default for ModelCaps {
    fn default() -> Self {
        Self {
            negative: true,
            edit: true,
            transform: true,
            max_side: 1024,
            multi_image: true,
            gif: false,
            gif_max_frames: 16,
        }
    }
}

/// 按模型名启发式给出默认能力；用户在服务商弹窗里勾选后以覆盖值为准。
pub fn heuristic_caps(model: &str) -> ModelCaps {
    let m = model.to_ascii_lowercase();
    let mut caps = ModelCaps::default();
    // OpenAI 图像接口没有标准负向字段（ADR #3），界面不展示负向输入
    if m.contains("dall-e") || m.contains("gpt-image") {
        caps.negative = false;
    }
    // 只有 gpt-image-2.6 系列在服务端打开了 GIF 输出（flare / sunburst 两个型号）
    if m.contains("gpt-image-2.6") {
        caps.gif = true;
    }
    caps
}

fn provider_models(provider_id: i64) -> Result<Vec<String>, String> {
    let provider = storage::get_provider(provider_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("服务商 #{provider_id} 不存在"))?;
    let models: Vec<String> = serde_json::from_str(&provider.models_json).unwrap_or_default();
    Ok(models
        .into_iter()
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .collect())
}

/// 返回该服务商每个模型的能力：有覆盖值用覆盖值，否则按名称启发式。
#[tauri::command]
pub fn get_model_caps(provider_id: i64) -> Result<HashMap<String, ModelCaps>, String> {
    let stored: HashMap<String, ModelCaps> = storage::list_model_caps(provider_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter_map(|(model, json)| {
            serde_json::from_str::<ModelCaps>(&json)
                .ok()
                .map(|caps| (model, caps))
        })
        .collect();
    Ok(provider_models(provider_id)?
        .into_iter()
        .map(|model| {
            let caps = stored
                .get(&model)
                .cloned()
                .unwrap_or_else(|| heuristic_caps(&model));
            (model, caps)
        })
        .collect())
}

#[tauri::command]
pub fn set_model_caps(provider_id: i64, model: String, caps: ModelCaps) -> Result<(), String> {
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("模型名不能为空".into());
    }
    storage::get_provider(provider_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("服务商 #{provider_id} 不存在"))?;
    let json = serde_json::to_string(&caps).map_err(|e| e.to_string())?;
    storage::save_model_caps(provider_id, &model, &json).map_err(|e| e.to_string())
}

/// 批量保存模型能力：单事务写入，避免逐个调用中途失败留下半套配置。
#[tauri::command]
pub fn save_model_caps_batch(
    provider_id: i64,
    entries: HashMap<String, ModelCaps>,
) -> Result<(), String> {
    if entries.is_empty() {
        return Ok(());
    }
    storage::get_provider(provider_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("服务商 #{provider_id} 不存在"))?;
    let mut rows = Vec::with_capacity(entries.len());
    for (model, caps) in entries {
        let model = model.trim().to_string();
        if model.is_empty() {
            return Err("模型名不能为空".into());
        }
        let json = serde_json::to_string(&caps).map_err(|e| e.to_string())?;
        rows.push((model, json));
    }
    storage::save_model_caps_batch(provider_id, &rows).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heuristic_marks_openai_image_models_without_negative() {
        assert!(!heuristic_caps("dall-e-3").negative);
        assert!(!heuristic_caps("gpt-image-1").negative);
        assert!(heuristic_caps("flux-pro").negative);
        assert!(heuristic_caps("sdxl").negative);
    }

    #[test]
    fn unknown_models_keep_all_capabilities() {
        let caps = heuristic_caps("vendor-unknown-v9");
        assert_eq!(caps, ModelCaps::default());
        assert_eq!(caps.max_side, 1024);
        assert!(caps.multi_image, "缺省允许多参考图，与当前行为一致");
        assert!(!caps.gif, "未知模型不默认打开动图");
        assert_eq!(caps.gif_max_frames, 16);
    }

    /// gpt-image-2.6 两个型号默认开 GIF，其它 gpt-image 不开；上限固定 16
    #[test]
    fn heuristic_enables_gif_only_for_2_6() {
        let flare = heuristic_caps("gpt-image-2.6-flare");
        assert!(flare.gif);
        assert_eq!(flare.gif_max_frames, 16);
        assert!(heuristic_caps("gpt-image-2.6-sunburst").gif);
        assert!(!heuristic_caps("gpt-image-1").gif);
        assert!(!heuristic_caps("dall-e-3").gif);
    }

    /// 旧覆盖值缺字段时按默认补齐，不 panic、不收紧能力
    #[test]
    fn caps_json_tolerates_missing_fields() {
        let caps: ModelCaps = serde_json::from_str(r#"{"negative":false}"#).unwrap();
        assert!(!caps.negative);
        assert!(caps.edit);
        assert!(caps.transform);
        assert_eq!(caps.max_side, 1024);
        assert!(caps.multi_image);
    }
}
