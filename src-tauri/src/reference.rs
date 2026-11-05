//! 参考图分角色 + 强度。
//!
//! 主流绘图接口没有「逐图权重」参数，角色与强度只能以提示词级措辞近似：
//! 为每张参考图追加一行 `Reference i (role, strength): <短语>`，
//! 模板接口另提供 `{{ref_roles}}` JSON 供自定义接口自行消费。
//! 这是近似，不是模型原生权重——文档与界面都按这个口径说明。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReferenceRole {
    Composition,
    Style,
    Face,
    Element,
    /// 对话上下文：上一轮生成结果，仅由聊天追问自动带入
    Previous,
}

impl ReferenceRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Composition => "composition",
            Self::Style => "style",
            Self::Face => "face",
            Self::Element => "element",
            Self::Previous => "previous",
        }
    }

    fn phrase(self) -> &'static str {
        match self {
            Self::Composition => "follow this image's composition and framing",
            Self::Style => "match this image's visual style and palette",
            Self::Face => "preserve the face identity from this image",
            Self::Element => "include the key elements from this image",
            Self::Previous => "use this image as the current result to continue from",
        }
    }
}

/// 与 `images` 按位置一一对应；缺省强度按 moderate 处理
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceSpec {
    pub role: ReferenceRole,
    #[serde(default)]
    pub strength: Option<u32>,
}

pub const DEFAULT_STRENGTH: u32 = 60;

/// 0–33 subtle / 34–66 moderate / 67–100 strong；越界一律夹到 100
pub fn strength_word(strength: Option<u32>) -> &'static str {
    match strength.unwrap_or(DEFAULT_STRENGTH).min(100) {
        0..=33 => "subtle",
        34..=66 => "moderate",
        _ => "strong",
    }
}

/// 在提示词尾部追加逐图说明；没有参考图时原样返回（不产生空行）
pub fn append_reference_guidance(prompt: &str, refs: &[ReferenceSpec]) -> String {
    if refs.is_empty() {
        return prompt.to_string();
    }
    let mut out = prompt.trim_end().to_string();
    for (i, r) in refs.iter().enumerate() {
        out.push_str(&format!(
            "\nReference {} ({}, {}): {}.",
            i + 1,
            r.role.as_str(),
            strength_word(r.strength),
            r.role.phrase()
        ));
    }
    out
}

/// 模板接口的 `{{ref_roles}}`：带 1 基序号，便于模板按顺序取用
pub fn roles_json(refs: &[ReferenceSpec]) -> String {
    let items: Vec<serde_json::Value> = refs
        .iter()
        .enumerate()
        .map(|(i, r)| {
            serde_json::json!({
                "index": i + 1,
                "role": r.role.as_str(),
                "strength": r.strength.unwrap_or(DEFAULT_STRENGTH),
            })
        })
        .collect();
    serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(role: ReferenceRole, strength: Option<u32>) -> ReferenceSpec {
        ReferenceSpec { role, strength }
    }

    #[test]
    fn strength_buckets_cover_the_whole_range() {
        assert_eq!(strength_word(None), "moderate");
        assert_eq!(strength_word(Some(0)), "subtle");
        assert_eq!(strength_word(Some(33)), "subtle");
        assert_eq!(strength_word(Some(34)), "moderate");
        assert_eq!(strength_word(Some(66)), "moderate");
        assert_eq!(strength_word(Some(67)), "strong");
        assert_eq!(strength_word(Some(100)), "strong");
        assert_eq!(strength_word(Some(999)), "strong");
    }

    #[test]
    fn guidance_appends_one_line_per_reference_in_order() {
        let refs = vec![
            spec(ReferenceRole::Composition, Some(20)),
            spec(ReferenceRole::Face, None),
        ];
        let out = append_reference_guidance("a cat", &refs);
        assert!(out.starts_with("a cat\n"));
        assert!(out.contains("Reference 1 (composition, subtle)"));
        assert!(out.contains("Reference 2 (face, moderate)"));
        let first = out.find("Reference 1").unwrap();
        let second = out.find("Reference 2").unwrap();
        assert!(first < second);
    }

    #[test]
    fn guidance_is_a_noop_without_references() {
        assert_eq!(append_reference_guidance("a cat", &[]), "a cat");
    }

    /// 对话追问自动带入的上一轮画面：独立角色，措辞明确是「继续修改当前结果」
    #[test]
    fn previous_role_is_serializable_and_carries_continuation_guidance() {
        let spec: ReferenceSpec =
            serde_json::from_str(r#"{"role":"previous","strength":60}"#).unwrap();
        assert_eq!(spec.role, ReferenceRole::Previous);

        let out = append_reference_guidance("把背景换成蓝色", &[spec]);
        assert!(out.contains("Reference 1 (previous, moderate)"));
        assert!(out.contains("current result to continue from"));
    }

    #[test]
    fn roles_json_carries_index_role_and_effective_strength() {
        let refs = vec![
            spec(ReferenceRole::Style, Some(80)),
            spec(ReferenceRole::Element, None),
        ];
        let json = roles_json(&refs);
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed[0]["index"], 1);
        assert_eq!(parsed[0]["role"], "style");
        assert_eq!(parsed[0]["strength"], 80);
        assert_eq!(parsed[1]["index"], 2);
        assert_eq!(parsed[1]["role"], "element");
        assert_eq!(parsed[1]["strength"], DEFAULT_STRENGTH);
    }

    #[test]
    fn spec_deserializes_from_camel_case_payload() {
        let spec: ReferenceSpec = serde_json::from_str(r#"{"role":"face","strength":40}"#).unwrap();
        assert_eq!(spec.role, ReferenceRole::Face);
        assert_eq!(spec.strength, Some(40));
        let missing: ReferenceSpec = serde_json::from_str(r#"{"role":"style"}"#).unwrap();
        assert_eq!(missing.strength, None);
    }
}
