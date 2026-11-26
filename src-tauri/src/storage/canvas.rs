use super::*;

use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// 画布上限：JSON 8MB / 500 节点，避免一次保存把 SQLite 与 IPC 拖垮。
pub const MAX_CANVAS_NODES: usize = 500;
pub const MAX_CANVAS_JSON_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_CANVAS_NAME_CHARS: usize = 80;
pub const MAX_CANVAS_LAYERS_PER_NODE: usize = 24;
pub const MAX_CANVAS_LAYERS: usize = 3000;
pub const MAX_CANVAS_REGIONS_PER_NODE: usize = 8;
pub const MAX_CANVAS_REGION_FEATHER: f64 = 128.0;
pub const MAX_CANVAS_LAYER_PATH: usize = 1024;
pub const MAX_CANVAS_REGION_PROMPT: usize = 2000;
pub const MAX_CANVAS_LAYER_NAME: usize = 80;

pub const CANVAS_DEFAULT_DATA: &str =
    r#"{"version":1,"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}"#;

/// 画布列表只带元信息，避免把所有画布的节点数据一起读出来。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasBoardMeta {
    pub id: i64,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasBoard {
    pub id: i64,
    pub name: String,
    pub data_json: String,
    pub created_at: String,
    pub updated_at: String,
}
fn canvas_meta_from_row(row: &rusqlite::Row) -> rusqlite::Result<CanvasBoardMeta> {
    Ok(CanvasBoardMeta {
        id: row.get(0)?,
        name: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
    })
}

fn canvas_board_from_row(row: &rusqlite::Row) -> rusqlite::Result<CanvasBoard> {
    Ok(CanvasBoard {
        id: row.get(0)?,
        name: row.get(1)?,
        data_json: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

fn validate_canvas_name(name: &str) -> AppResult<&str> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Other("画布名称不能为空".into()));
    }
    if name.chars().count() > MAX_CANVAS_NAME_CHARS {
        return Err(AppError::Other(format!(
            "画布名称不能超过 {MAX_CANVAS_NAME_CHARS} 个字符"
        )));
    }
    Ok(name)
}

/// 画布数据校验：节点 id 唯一、边只引用已存在的节点、视口数值有限；
/// v2 额外约束图层/区域形状与上限。宽进严出：宁可拒绝一次保存，也不把
/// 坏数据写成下次启动打不开的画布。
fn validate_canvas_data(raw: &str) -> AppResult<()> {
    if raw.len() > MAX_CANVAS_JSON_BYTES {
        return Err(AppError::Other("画布数据过大（上限 8MB）".into()));
    }
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| AppError::Other("画布数据不是合法 JSON".into()))?;
    let obj = value
        .as_object()
        .ok_or_else(|| AppError::Other("画布数据必须是 JSON 对象".into()))?;

    if let Some(version) = obj.get("version") {
        let version = version
            .as_i64()
            .ok_or_else(|| AppError::Other("画布版本号必须是整数".into()))?;
        if version != 1 && version != 2 {
            return Err(AppError::Other(format!("不支持的画布版本 {version}")));
        }
    }

    let nodes = obj
        .get("nodes")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| AppError::Other("画布数据缺少节点数组".into()))?;
    if nodes.len() > MAX_CANVAS_NODES {
        return Err(AppError::Other(format!(
            "画布节点不能超过 {MAX_CANVAS_NODES} 个"
        )));
    }
    let mut ids = HashSet::new();
    let mut total_layers = 0usize;
    for node in nodes {
        let node = node
            .as_object()
            .ok_or_else(|| AppError::Other("画布节点必须是对象".into()))?;
        let id = match node.get("id") {
            Some(serde_json::Value::String(s)) if !s.trim().is_empty() => s.clone(),
            Some(serde_json::Value::Number(n)) => n.to_string(),
            _ => return Err(AppError::Other("画布节点缺少有效 id".into())),
        };
        if !ids.insert(id) {
            return Err(AppError::Other("画布节点 id 不能重复".into()));
        }
        total_layers += validate_canvas_layers(node)?;
        if total_layers > MAX_CANVAS_LAYERS {
            return Err(AppError::Other(format!(
                "画布图层总数不能超过 {MAX_CANVAS_LAYERS}"
            )));
        }
        validate_canvas_regions(node)?;
    }

    let edges = obj
        .get("edges")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| AppError::Other("画布数据缺少连线数组".into()))?;
    for edge in edges {
        let edge = edge
            .as_object()
            .ok_or_else(|| AppError::Other("画布连线必须是对象".into()))?;
        let from = edge
            .get("from")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| AppError::Other("画布连线缺少起点".into()))?;
        let to = edge
            .get("to")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| AppError::Other("画布连线缺少终点".into()))?;
        if !ids.contains(from) || !ids.contains(to) {
            return Err(AppError::Other("画布连线引用了不存在的节点".into()));
        }
    }

    let viewport = obj
        .get("viewport")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| AppError::Other("画布数据缺少视口".into()))?;
    for key in ["x", "y", "zoom"] {
        let value = viewport
            .get(key)
            .and_then(serde_json::Value::as_f64)
            .ok_or_else(|| AppError::Other(format!("画布视口缺少数值 {key}")))?;
        if !value.is_finite() {
            return Err(AppError::Other(format!("画布视口 {key} 必须是有限数值")));
        }
    }
    Ok(())
}

/// 校验节点图层，返回该节点层数（用于画布总数上限）
fn validate_canvas_layers(node: &serde_json::Map<String, serde_json::Value>) -> AppResult<usize> {
    let Some(layers) = node.get("layers") else {
        return Ok(0);
    };
    let layers = layers
        .as_array()
        .ok_or_else(|| AppError::Other("图层必须是数组".into()))?;
    if layers.len() > MAX_CANVAS_LAYERS_PER_NODE {
        return Err(AppError::Other(format!(
            "每个节点的图层不能超过 {MAX_CANVAS_LAYERS_PER_NODE} 层"
        )));
    }
    for layer in layers {
        let layer = layer
            .as_object()
            .ok_or_else(|| AppError::Other("图层必须是对象".into()))?;
        let id = layer.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if id.trim().is_empty() {
            return Err(AppError::Other("图层缺少有效 id".into()));
        }
        let kind = layer.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        if kind != "image" && kind != "mask" {
            return Err(AppError::Other("图层 kind 必须是 image 或 mask".into()));
        }
        if kind == "mask" {
            let path = layer.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let path = path.trim();
            if path.is_empty() || path.chars().count() > MAX_CANVAS_LAYER_PATH {
                return Err(AppError::Other("蒙版层缺少有效路径".into()));
            }
        } else {
            match layer.get("historyId").and_then(|v| v.as_i64()) {
                Some(id) if id > 0 => {}
                _ => return Err(AppError::Other("图像层缺少有效 historyId".into())),
            }
        }
        if let Some(opacity) = layer.get("opacity") {
            let opacity = opacity
                .as_f64()
                .ok_or_else(|| AppError::Other("图层不透明度必须是数值".into()))?;
            if !(0.0..=1.0).contains(&opacity) {
                return Err(AppError::Other("图层不透明度必须在 0 到 1 之间".into()));
            }
        }
        if let Some(name) = layer.get("name").and_then(|v| v.as_str()) {
            if name.chars().count() > MAX_CANVAS_LAYER_NAME {
                return Err(AppError::Other("图层名称过长".into()));
            }
        }
    }
    Ok(layers.len())
}

/// 校验节点的分区列表（提示词、蒙版路径、羽化范围）
fn validate_canvas_regions(node: &serde_json::Map<String, serde_json::Value>) -> AppResult<()> {
    let Some(regions) = node.get("regions") else {
        return Ok(());
    };
    let regions = regions
        .as_array()
        .ok_or_else(|| AppError::Other("分区必须是数组".into()))?;
    if regions.len() > MAX_CANVAS_REGIONS_PER_NODE {
        return Err(AppError::Other(format!(
            "每个节点最多 {MAX_CANVAS_REGIONS_PER_NODE} 个分区"
        )));
    }
    for region in regions {
        let region = region
            .as_object()
            .ok_or_else(|| AppError::Other("分区必须是对象".into()))?;
        let id = region.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if id.trim().is_empty() {
            return Err(AppError::Other("分区缺少有效 id".into()));
        }
        let mask_path = region
            .get("maskPath")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let mask_path = mask_path.trim();
        if mask_path.is_empty() || mask_path.chars().count() > MAX_CANVAS_LAYER_PATH {
            return Err(AppError::Other("分区缺少有效蒙版路径".into()));
        }
        if let Some(prompt) = region.get("prompt").and_then(|v| v.as_str()) {
            if prompt.chars().count() > MAX_CANVAS_REGION_PROMPT {
                return Err(AppError::Other("分区提示词过长".into()));
            }
        }
        if let Some(feather) = region.get("feather") {
            let feather = feather
                .as_f64()
                .ok_or_else(|| AppError::Other("分区羽化必须是数值".into()))?;
            if !(0.0..=MAX_CANVAS_REGION_FEATHER).contains(&feather) {
                return Err(AppError::Other(format!(
                    "分区羽化必须在 0 到 {MAX_CANVAS_REGION_FEATHER} 之间"
                )));
            }
        }
    }
    Ok(())
}

pub fn list_canvas_boards() -> AppResult<Vec<CanvasBoardMeta>> {
    let c = conn()?;
    list_canvas_boards_in(&c)
}

pub(crate) fn list_canvas_boards_in(c: &Connection) -> AppResult<Vec<CanvasBoardMeta>> {
    let mut stmt = c.prepare(
        "SELECT id, name, created_at, updated_at FROM canvas_boards
         ORDER BY updated_at DESC, id DESC",
    )?;
    let rows = stmt.query_map([], canvas_meta_from_row)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

fn get_canvas_board_in(c: &Connection, id: i64) -> AppResult<Option<CanvasBoard>> {
    c.query_row(
        "SELECT id, name, data_json, created_at, updated_at FROM canvas_boards WHERE id = ?1",
        params![id],
        canvas_board_from_row,
    )
    .optional()
    .map_err(AppError::from)
}

pub fn create_canvas_board(name: &str) -> AppResult<CanvasBoard> {
    let c = conn()?;
    create_canvas_board_in(&c, name)
}

pub(crate) fn create_canvas_board_in(c: &Connection, name: &str) -> AppResult<CanvasBoard> {
    let name = validate_canvas_name(name)?;
    let now = timestamp_millis();
    c.execute(
        "INSERT INTO canvas_boards (name, data_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![name, CANVAS_DEFAULT_DATA, now, now],
    )?;
    let id = c.last_insert_rowid();
    get_canvas_board_in(c, id)?.ok_or_else(|| AppError::Other("新建画布后读取失败".into()))
}

pub fn get_canvas_board(id: i64) -> AppResult<Option<CanvasBoard>> {
    let c = conn()?;
    get_canvas_board_in(&c, id)
}

pub fn save_canvas_board(id: i64, name: &str, data_json: &str) -> AppResult<CanvasBoard> {
    let c = conn()?;
    save_canvas_board_in(&c, id, name, data_json)
}

pub(crate) fn save_canvas_board_in(
    c: &Connection,
    id: i64,
    name: &str,
    data_json: &str,
) -> AppResult<CanvasBoard> {
    let name = validate_canvas_name(name)?;
    validate_canvas_data(data_json)?;
    // 首次用 v2 覆盖 v1 文档前留一份快照（只留一次，后续保存不覆盖）
    let changed = c.execute(
        "UPDATE canvas_boards
            SET name = ?2, data_json = ?3, updated_at = ?4,
                data_json_prev = CASE
                    WHEN data_json_prev = ''
                     AND NOT (
                        json_valid(data_json)
                        AND json_extract(data_json, '$.version') = 2
                     )
                    THEN data_json
                    ELSE data_json_prev
                END
          WHERE id = ?1",
        params![id, name, data_json, timestamp_millis()],
    )?;
    if changed == 0 {
        return Err(AppError::Other(format!("画布 #{id} 不存在")));
    }
    get_canvas_board_in(c, id)?.ok_or_else(|| AppError::Other(format!("画布 #{id} 保存后读取失败")))
}

pub fn delete_canvas_board(id: i64) -> AppResult<bool> {
    let c = conn()?;
    delete_canvas_board_in(&c, id)
}

pub(crate) fn delete_canvas_board_in(c: &Connection, id: i64) -> AppResult<bool> {
    Ok(c.execute("DELETE FROM canvas_boards WHERE id = ?1", params![id])? > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::*;

    /// v1→v2 首次覆盖前只留一次 data_json_prev，后续保存不再覆盖
    #[test]
    fn canvas_prev_snapshot_is_written_once() {
        let c = mem_conn();
        let board = create_canvas_board_in(&c, "快照").unwrap();
        let prev_of = |c: &Connection| -> String {
            c.query_row(
                "SELECT data_json_prev FROM canvas_boards WHERE id = ?1",
                params![board.id],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert!(prev_of(&c).is_empty());

        let v1 = r#"{"version":1,"nodes":[{"id":"n1","historyId":3,"x":0,"y":0,"width":220}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}"#;
        save_canvas_board_in(&c, board.id, "v1", v1).unwrap();
        assert_eq!(prev_of(&c), CANVAS_DEFAULT_DATA, "首次保存留下旧文档");

        let v2 = r#"{"version":2,"nodes":[{"id":"n1","historyId":3,"x":0,"y":0,"width":220,"layers":[{"id":"l1","kind":"image","historyId":4,"visible":true,"opacity":1,"locked":false}]}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}"#;
        save_canvas_board_in(&c, board.id, "v2", v2).unwrap();
        assert_eq!(prev_of(&c), CANVAS_DEFAULT_DATA, "v2 保存不覆盖快照");

        save_canvas_board_in(&c, board.id, "again", v1).unwrap();
        assert_eq!(prev_of(&c), CANVAS_DEFAULT_DATA, "快照只留一次");
    }

    /// v2 图层/分区的边界校验：版本、层数、蒙版路径、不透明度、羽化、分区数
    #[test]
    fn canvas_v2_validation_boundaries() {
        let c = mem_conn();
        let board = create_canvas_board_in(&c, "v2 校验").unwrap();
        let wrap = |nodes: &str| {
            format!(
                r#"{{"version":2,"nodes":[{nodes}],"edges":[],"viewport":{{"x":0,"y":0,"zoom":1}}}}"#
            )
        };
        let save = |doc: &str| save_canvas_board_in(&c, board.id, "x", doc);

        assert!(save(&wrap(
            r#"{"id":"n1","historyId":1,"x":0,"y":0,"width":220,"layers":[{"id":"l1","kind":"image","historyId":2}]}"#
        ))
        .is_ok());

        let bad_version =
            r#"{"version":3,"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}"#;
        assert!(save(bad_version).is_err());

        let bad_kind = wrap(
            r#"{"id":"n1","historyId":1,"x":0,"y":0,"width":220,"layers":[{"id":"l1","kind":"text"}]}"#,
        );
        assert!(save(&bad_kind).is_err());

        let no_history = wrap(
            r#"{"id":"n1","historyId":1,"x":0,"y":0,"width":220,"layers":[{"id":"l1","kind":"image"}]}"#,
        );
        assert!(save(&no_history).is_err());

        let no_mask_path = wrap(
            r#"{"id":"n1","historyId":1,"x":0,"y":0,"width":220,"layers":[{"id":"m1","kind":"mask"}]}"#,
        );
        assert!(save(&no_mask_path).is_err());

        let bad_opacity = wrap(
            r#"{"id":"n1","historyId":1,"x":0,"y":0,"width":220,"layers":[{"id":"l1","kind":"image","historyId":2,"opacity":1.5}]}"#,
        );
        assert!(save(&bad_opacity).is_err());

        let too_many_layers: Vec<String> = (0..=MAX_CANVAS_LAYERS_PER_NODE)
            .map(|i| format!(r#"{{"id":"l{i}","kind":"image","historyId":{}}}"#, i + 2))
            .collect();
        let too_many_layers = wrap(&format!(
            r#"{{"id":"n1","historyId":1,"x":0,"y":0,"width":220,"layers":[{}]}}"#,
            too_many_layers.join(",")
        ));
        assert!(save(&too_many_layers).is_err());

        let too_many_regions: Vec<String> = (0..=MAX_CANVAS_REGIONS_PER_NODE)
            .map(|i| {
                format!(r#"{{"id":"r{i}","prompt":"p","maskPath":"C:/m/{i}.png","feather":24}}"#)
            })
            .collect();
        let too_many_regions = wrap(&format!(
            r#"{{"id":"n1","historyId":1,"x":0,"y":0,"width":220,"regions":[{}]}}"#,
            too_many_regions.join(",")
        ));
        assert!(save(&too_many_regions).is_err());

        let bad_feather = wrap(
            r#"{"id":"n1","historyId":1,"x":0,"y":0,"width":220,"regions":[{"id":"r1","prompt":"p","maskPath":"C:/m/1.png","feather":200}]}"#,
        );
        assert!(save(&bad_feather).is_err());
    }

    /// M12：画布 CRUD 往返，默认数据与更新时间正确
    #[test]
    fn canvas_board_crud_roundtrip() {
        let c = mem_conn();
        let created = create_canvas_board_in(&c, " 第一块画布 ").unwrap();
        assert_eq!(created.name, "第一块画布");
        assert_eq!(created.data_json, CANVAS_DEFAULT_DATA);
        assert!(!created.created_at.is_empty());

        let listed = list_canvas_boards_in(&c).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, created.id);

        let doc = r#"{"version":1,"nodes":[{"id":"n1","historyId":3,"x":10,"y":20,"width":240}],"edges":[],"viewport":{"x":12,"y":8,"zoom":1.5}}"#;
        let saved = save_canvas_board_in(&c, created.id, "改名", doc).unwrap();
        assert_eq!(saved.name, "改名");
        assert_eq!(saved.data_json, doc);
        assert_eq!(
            get_canvas_board_in(&c, created.id).unwrap().unwrap().name,
            "改名"
        );

        assert!(delete_canvas_board_in(&c, created.id).unwrap());
        assert!(get_canvas_board_in(&c, created.id).unwrap().is_none());
        assert!(!delete_canvas_board_in(&c, created.id).unwrap());
        assert!(save_canvas_board_in(&c, created.id, "x", doc).is_err());
    }

    /// M12：画布数据拒绝悬空边、重复 id、超量节点与超大 JSON
    #[test]
    fn canvas_save_rejects_invalid_documents() {
        let c = mem_conn();
        let board = create_canvas_board_in(&c, "校验").unwrap();

        let dangling = r#"{"version":1,"nodes":[],"edges":[{"id":"e1","from":"a","to":"b"}],"viewport":{"x":0,"y":0,"zoom":1}}"#;
        assert!(save_canvas_board_in(&c, board.id, "x", dangling).is_err());

        let duplicate = r#"{"version":1,"nodes":[{"id":"n1"},{"id":"n1"}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}"#;
        assert!(save_canvas_board_in(&c, board.id, "x", duplicate).is_err());

        let nodes: Vec<String> = (0..=MAX_CANVAS_NODES)
            .map(|i| format!(r#"{{"id":"n{i}"}}"#))
            .collect();
        let too_many = format!(
            r#"{{"version":1,"nodes":[{}],"edges":[],"viewport":{{"x":0,"y":0,"zoom":1}}}}"#,
            nodes.join(",")
        );
        assert!(save_canvas_board_in(&c, board.id, "x", &too_many).is_err());

        let huge = format!(
            r#"{{"version":1,"nodes":[],"edges":[],"viewport":{{"x":0,"y":0,"zoom":1}},"pad":"{}"}}"#,
            "x".repeat(MAX_CANVAS_JSON_BYTES)
        );
        assert!(save_canvas_board_in(&c, board.id, "x", &huge).is_err());

        let bad_viewport =
            r#"{"version":1,"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":"1"}}"#;
        assert!(save_canvas_board_in(&c, board.id, "x", bad_viewport).is_err());
        assert!(create_canvas_board_in(&c, "   ").is_err());
    }
}
