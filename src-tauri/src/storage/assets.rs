use super::*;

use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// 提示词收藏与工作流预设的上限：与参考图上限保持一致，避免预设比一次生成能用的图还多。
pub const MAX_PRESET_REFS: usize = 4;
pub const MAX_FAVORITE_TAGS: usize = 8;
pub const MAX_PRESET_NAME_CHARS: usize = 80;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptFavorite {
    pub id: i64,
    pub text: String,
    pub tags: Vec<String>,
    pub created_at: String,
}

/// 预设里的参考图：只存文件路径，角色 / 强度随路径一起打包。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetRef {
    pub path: String,
    #[serde(default = "default_preset_role")]
    pub role: String,
    #[serde(default = "default_preset_strength")]
    pub strength: u32,
}

fn default_preset_role() -> String {
    "composition".to_string()
}

fn default_preset_strength() -> u32 {
    crate::reference::DEFAULT_STRENGTH
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowPreset {
    pub id: i64,
    pub name: String,
    pub prompt: String,
    pub negative_prompt: String,
    pub params_json: String,
    pub refs: Vec<PresetRef>,
    pub created_at: String,
    pub updated_at: String,
}

// ---------- 提示词资产（迁移 009） ----------

fn favorite_from_row(row: &rusqlite::Row) -> rusqlite::Result<PromptFavorite> {
    let tags_json: String = row.get(2)?;
    Ok(PromptFavorite {
        id: row.get(0)?,
        text: row.get(1)?,
        tags: parse_tags(&tags_json),
        created_at: row.get(3)?,
    })
}

fn parse_tags(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

pub(crate) fn normalize_tags(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tag in tags {
        let tag = tag.trim();
        if tag.is_empty() || out.iter().any(|t| t == tag) {
            continue;
        }
        out.push(tag.to_string());
        if out.len() >= MAX_FAVORITE_TAGS {
            break;
        }
    }
    out
}

pub fn list_favorites() -> AppResult<Vec<PromptFavorite>> {
    let c = conn()?;
    list_favorites_in(&c)
}

pub(crate) fn list_favorites_in(c: &Connection) -> AppResult<Vec<PromptFavorite>> {
    let mut stmt = c.prepare(
        "SELECT id, text, tags_json, created_at FROM prompt_favorites
         ORDER BY created_at DESC, id DESC",
    )?;
    let rows = stmt.query_map([], favorite_from_row)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

/// 同一段提示词重复收藏时只更新标签，不产生第二条记录。
pub fn upsert_favorite(text: &str, tags: &[String]) -> AppResult<PromptFavorite> {
    let c = conn()?;
    upsert_favorite_in(&c, text, tags)
}

pub(crate) fn upsert_favorite_in(
    c: &Connection,
    text: &str,
    tags: &[String],
) -> AppResult<PromptFavorite> {
    let text = text.trim();
    if text.is_empty() {
        return Err(AppError::Other("收藏的提示词不能为空".into()));
    }
    let tags = normalize_tags(tags);
    let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into());
    c.execute(
        "INSERT INTO prompt_favorites (text, tags_json, created_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(text) DO UPDATE SET tags_json = excluded.tags_json",
        params![text, tags_json, timestamp_millis()],
    )?;
    c.query_row(
        "SELECT id, text, tags_json, created_at FROM prompt_favorites WHERE text = ?1",
        params![text],
        favorite_from_row,
    )
    .map_err(AppError::from)
}

pub fn delete_favorite(id: i64) -> AppResult<bool> {
    let c = conn()?;
    delete_favorite_in(&c, id)
}

pub(crate) fn delete_favorite_in(c: &Connection, id: i64) -> AppResult<bool> {
    Ok(c.execute("DELETE FROM prompt_favorites WHERE id = ?1", params![id])? > 0)
}

fn preset_from_row(row: &rusqlite::Row) -> rusqlite::Result<WorkflowPreset> {
    let refs_json: String = row.get(5)?;
    Ok(WorkflowPreset {
        id: row.get(0)?,
        name: row.get(1)?,
        prompt: row.get(2)?,
        negative_prompt: row.get(3)?,
        params_json: row.get(4)?,
        refs: parse_preset_refs(&refs_json),
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn parse_preset_refs(raw: &str) -> Vec<PresetRef> {
    serde_json::from_str::<Vec<PresetRef>>(raw).unwrap_or_default()
}

fn validate_preset_refs(refs: &[PresetRef]) -> AppResult<()> {
    if refs.len() > MAX_PRESET_REFS {
        return Err(AppError::Other(format!(
            "预设最多保存 {MAX_PRESET_REFS} 张参考图"
        )));
    }
    for r in refs {
        if r.path.trim().is_empty() {
            return Err(AppError::Other("预设中的参考图路径不能为空".into()));
        }
        if !matches!(
            r.role.as_str(),
            "composition" | "style" | "face" | "element"
        ) {
            return Err(AppError::Other(format!("预设中的参考角色非法: {}", r.role)));
        }
        if r.strength > 100 {
            return Err(AppError::Other("预设中的参考强度必须在 0–100 之间".into()));
        }
    }
    Ok(())
}

pub fn list_presets() -> AppResult<Vec<WorkflowPreset>> {
    let c = conn()?;
    list_presets_in(&c)
}

pub(crate) fn list_presets_in(c: &Connection) -> AppResult<Vec<WorkflowPreset>> {
    let mut stmt = c.prepare(
        "SELECT id, name, prompt, negative_prompt, params_json, refs_json, created_at, updated_at
         FROM workflow_presets ORDER BY updated_at DESC, id DESC",
    )?;
    let rows = stmt.query_map([], preset_from_row)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

/// 保存预设：`id` 为空时新建，否则覆盖同名记录并刷新 `updated_at`。
pub fn save_preset(
    id: Option<i64>,
    name: &str,
    prompt: &str,
    negative_prompt: &str,
    params_json: &str,
    refs: &[PresetRef],
) -> AppResult<WorkflowPreset> {
    let c = conn()?;
    save_preset_in(&c, id, name, prompt, negative_prompt, params_json, refs)
}

pub(crate) fn save_preset_in(
    c: &Connection,
    id: Option<i64>,
    name: &str,
    prompt: &str,
    negative_prompt: &str,
    params_json: &str,
    refs: &[PresetRef],
) -> AppResult<WorkflowPreset> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Other("预设名称不能为空".into()));
    }
    if name.chars().count() > MAX_PRESET_NAME_CHARS {
        return Err(AppError::Other(format!(
            "预设名称不能超过 {MAX_PRESET_NAME_CHARS} 个字符"
        )));
    }
    if params_json.len() > 64 * 1024 {
        return Err(AppError::Other("预设参数过大".into()));
    }
    let params: serde_json::Value = serde_json::from_str(params_json)
        .map_err(|_| AppError::Other("预设参数不是合法 JSON".into()))?;
    if !params.is_object() {
        return Err(AppError::Other("预设参数必须是 JSON 对象".into()));
    }
    validate_preset_refs(refs)?;
    let refs_json = serde_json::to_string(refs).unwrap_or_else(|_| "[]".into());
    let now = timestamp_millis();
    let preset_id = match id {
        Some(id) => {
            let changed = c.execute(
                "UPDATE workflow_presets SET name = ?2, prompt = ?3, negative_prompt = ?4,
                 params_json = ?5, refs_json = ?6, updated_at = ?7 WHERE id = ?1",
                params![
                    id,
                    name,
                    prompt,
                    negative_prompt,
                    params_json,
                    refs_json,
                    now
                ],
            )?;
            if changed == 0 {
                return Err(AppError::Other("预设不存在或已被删除".into()));
            }
            id
        }
        None => {
            c.execute(
                "INSERT INTO workflow_presets
                 (name, prompt, negative_prompt, params_json, refs_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params![name, prompt, negative_prompt, params_json, refs_json, now],
            )?;
            c.last_insert_rowid()
        }
    };
    c.query_row(
        "SELECT id, name, prompt, negative_prompt, params_json, refs_json, created_at, updated_at
         FROM workflow_presets WHERE id = ?1",
        params![preset_id],
        preset_from_row,
    )
    .map_err(AppError::from)
}

pub fn delete_preset(id: i64) -> AppResult<bool> {
    let c = conn()?;
    delete_preset_in(&c, id)
}

pub(crate) fn delete_preset_in(c: &Connection, id: i64) -> AppResult<bool> {
    Ok(c.execute("DELETE FROM workflow_presets WHERE id = ?1", params![id])? > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::*;

    /// M9：收藏按文本去重，重复收藏只更新标签
    #[test]
    fn prompt_favorite_upsert_and_tags() {
        let c = mem_conn();
        let first = upsert_favorite_in(
            &c,
            "  cinematic portrait  ",
            &["人像".into(), " 人像 ".into(), "".into()],
        )
        .unwrap();
        assert_eq!(first.text, "cinematic portrait");
        assert_eq!(first.tags, vec!["人像".to_string()]);
        let again = upsert_favorite_in(&c, "cinematic portrait", &["人像".into(), "电影感".into()])
            .unwrap();
        assert_eq!(again.id, first.id, "同一文本不得产生第二条收藏");
        assert_eq!(again.tags, vec!["人像".to_string(), "电影感".to_string()]);
        assert_eq!(list_favorites_in(&c).unwrap().len(), 1);
        assert!(upsert_favorite_in(&c, "   ", &[]).is_err());
        assert!(delete_favorite_in(&c, first.id).unwrap());
        assert!(!delete_favorite_in(&c, first.id).unwrap());
    }

    /// M9：预设保存 / 更新 / 删除与参考图约束
    #[test]
    fn workflow_preset_roundtrip_and_validation() {
        let c = mem_conn();
        let refs = vec![
            PresetRef {
                path: r"C:\data\refs\a.png".into(),
                role: "composition".into(),
                strength: 60,
            },
            PresetRef {
                path: r"C:\data\refs\b.png".into(),
                role: "style".into(),
                strength: 80,
            },
        ];
        let saved = save_preset_in(
            &c,
            None,
            "  夜景人像  ",
            "neon portrait",
            "blurry",
            r#"{"ratio":"3:4","width":768,"height":1024}"#,
            &refs,
        )
        .unwrap();
        assert_eq!(saved.name, "夜景人像");
        assert_eq!(saved.refs, refs);
        assert_eq!(list_presets_in(&c).unwrap().len(), 1);

        let updated = save_preset_in(
            &c,
            Some(saved.id),
            "夜景人像 v2",
            saved.prompt.as_str(),
            "",
            saved.params_json.as_str(),
            &[],
        )
        .unwrap();
        assert_eq!(updated.name, "夜景人像 v2");
        assert!(updated.refs.is_empty());

        assert!(save_preset_in(&c, None, "", "p", "", "{}", &[]).is_err());
        assert!(save_preset_in(&c, None, "x", "p", "", "not-json", &[]).is_err());
        assert!(save_preset_in(&c, None, "x", "p", "", "[]", &[]).is_err());
        let too_many: Vec<PresetRef> = (0..=MAX_PRESET_REFS)
            .map(|i| PresetRef {
                path: format!("r{i}.png"),
                role: "composition".into(),
                strength: 60,
            })
            .collect();
        assert!(save_preset_in(&c, None, "x", "p", "", "{}", &too_many).is_err());
        let bad_role = vec![PresetRef {
            path: "r.png".into(),
            role: "unknown".into(),
            strength: 60,
        }];
        assert!(save_preset_in(&c, None, "x", "p", "", "{}", &bad_role).is_err());
        assert!(save_preset_in(&c, Some(9999), "x", "p", "", "{}", &[]).is_err());

        assert!(delete_preset_in(&c, saved.id).unwrap());
        assert!(list_presets_in(&c).unwrap().is_empty());
    }

    /// M9：迁移 009 的索引存在（版本号由通用迁移测试覆盖）
    #[test]
    fn prompt_assets_indexes_exist() {
        let c = mem_conn();
        assert!(index_exists(&c, "idx_prompt_favorites_created"));
        assert!(index_exists(&c, "idx_workflow_presets_updated"));
    }
}
