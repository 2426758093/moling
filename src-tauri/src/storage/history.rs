use super::*;

use crate::error::{AppError, AppResult};
use base64::Engine;
use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRow {
    pub id: i64,
    pub prompt: String,
    pub negative_prompt: String,
    pub model: String,
    pub provider_name: String,
    pub seed: Option<i64>,
    pub width: i64,
    pub height: i64,
    pub guidance: f64,
    pub steps: i64,
    pub style: String,
    pub file_path: String,
    pub favorite: bool,
    pub created_at: String,
    /// 派生图的父记录（放大 / 风格 / 编辑 / 画布导出）；原创为 None
    #[serde(default)]
    pub parent_id: Option<i64>,
    /// generate | edit | erase | outpaint | upscale | style | background | basic-edit | canvas | paste
    /// | retouch | beauty | auto-enhance（后三者来自本地修图，见 `retouch::history_op`）
    #[serde(default = "default_op")]
    pub op: String,
}

fn default_op() -> String {
    "generate".to_string()
}

/// 原图字节数；文件缺失 / 不可读时填 0，列表按「—」展示。
/// 只在写库时 stat 一次，读路径（列表）不再逐个读盘。
fn file_size_of(path: &str) -> i64 {
    std::fs::metadata(path).map(|m| m.len() as i64).unwrap_or(0)
}

pub fn add_history(h: &HistoryRow) -> AppResult<i64> {
    let c = conn()?;
    add_history_in(&c, h)
}

pub(crate) fn add_history_in(c: &Connection, h: &HistoryRow) -> AppResult<i64> {
    // 落库即记录文件大小：派生图（放大 / 风格 / 编辑 / 画布）也走这里，统一覆盖
    let file_size = file_size_of(&h.file_path);
    c.execute(
        "INSERT INTO history (prompt, negative_prompt, model, provider_name, seed, width,
         height, guidance, steps, style, file_path, favorite, created_at, parent_id, op, file_size)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
        params![
            h.prompt,
            h.negative_prompt,
            h.model,
            h.provider_name,
            h.seed,
            h.width,
            h.height,
            h.guidance,
            h.steps,
            h.style,
            h.file_path,
            h.favorite as i64,
            h.created_at,
            h.parent_id,
            h.op,
            file_size
        ],
    )?;
    Ok(c.last_insert_rowid())
}

/// 旧版分页接口：保留给设置导入测试与 before_id 兼容调用；作品页走 list_history_page。
#[allow(dead_code)]
pub fn list_history(
    limit: i64,
    offset: i64,
    before_id: Option<i64>,
    model_filter: &str,
    style_filter: &str,
    favorite_only: bool,
) -> AppResult<Vec<HistoryRow>> {
    let c = conn()?;
    list_history_in(
        &c,
        limit,
        offset,
        before_id,
        model_filter,
        style_filter,
        favorite_only,
    )
}

#[allow(dead_code)]
pub(crate) fn list_history_in(
    c: &Connection,
    limit: i64,
    offset: i64,
    before_id: Option<i64>,
    model_filter: &str,
    style_filter: &str,
    favorite_only: bool,
) -> AppResult<Vec<HistoryRow>> {
    // 分页参数钳制（F-015）：SQLite 里 LIMIT -1 等于不限，负 offset 会被当成 0，
    // 直接绑定调用方传来的值等于把「一次拉全库」的能力暴露给 IPC。
    let limit = limit.clamp(1, 200);
    let offset = offset.max(0);
    let before_id = before_id.filter(|id| *id > 0);
    let mut conditions = Vec::new();
    if before_id.is_some() {
        conditions.push("id < ?");
    }
    if !model_filter.is_empty() {
        conditions.push("model = ?");
    }
    if !style_filter.is_empty() {
        conditions.push("style = ?");
    }
    if favorite_only {
        conditions.push("favorite = 1");
    }
    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };
    let sql = format!(
        "SELECT id, prompt, negative_prompt, model, provider_name, seed, width, height,
         guidance, steps, style, file_path, favorite, created_at, parent_id, op
         FROM history{where_clause} ORDER BY id DESC LIMIT ? OFFSET ?"
    );
    let mut stmt = c.prepare(&sql)?;
    let mut values: Vec<&dyn rusqlite::ToSql> = Vec::new();
    if let Some(before_id) = before_id.as_ref() {
        values.push(before_id);
    }
    if !model_filter.is_empty() {
        values.push(&model_filter);
    }
    if !style_filter.is_empty() {
        values.push(&style_filter);
    }
    values.push(&limit);
    values.push(&offset);
    let rows = stmt.query_map(values.as_slice(), history_from_row)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

/// 作品页查询：游标分页 + 筛选 + 全局排序 + 模糊查询。
/// 字段由命令层从 IPC 参数填充，存储层只认这个结构。
#[derive(Debug, Clone, Default)]
pub struct HistoryQuery {
    pub limit: i64,
    pub offset: i64,
    pub before_id: Option<i64>,
    pub cursor: Option<String>,
    pub model: String,
    pub style: String,
    pub favorite_only: bool,
    pub query: String,
    pub sort: String,
    pub order: String,
}

/// 列表项：HistoryRow + 文件大小。`flatten` 让前端继续拿到 `history.fileSize`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryListItem {
    #[serde(flatten)]
    pub row: HistoryRow,
    pub file_size: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub items: Vec<HistoryListItem>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CursorPayload {
    sort: String,
    order: String,
    key: String,
    id: i64,
}

fn canonical_sort(sort: &str) -> &'static str {
    match sort {
        "name" => "name",
        "type" => "type",
        "model" => "model",
        "style" => "style",
        "size" => "size",
        "dimensions" => "dimensions",
        "favorite" => "favorite",
        _ => "date",
    }
}

fn sort_expr(sort: &str) -> &'static str {
    match sort {
        "name" => "prompt",
        "type" => {
            "CASE WHEN lower(file_path) LIKE '%.gif' THEN 'gif' \
             WHEN lower(file_path) LIKE '%.jpg' OR lower(file_path) LIKE '%.jpeg' THEN 'jpeg' \
             WHEN lower(file_path) LIKE '%.webp' THEN 'webp' ELSE 'png' END"
        }
        "model" => "model",
        "style" => "style",
        "size" => "file_size",
        "dimensions" => "(width * height)",
        "favorite" => "favorite",
        _ => "created_at",
    }
}

/// 与 sort_expr 的类型 CASE 保持同口径，避免游标边界与排序键不一致
fn type_key(path: &str) -> String {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".gif") {
        "gif".into()
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "jpeg".into()
    } else if lower.ends_with(".webp") {
        "webp".into()
    } else {
        "png".into()
    }
}

fn is_numeric_sort(sort: &str) -> bool {
    matches!(sort, "size" | "dimensions" | "favorite")
}

fn cursor_key(item: &HistoryListItem, sort: &str) -> String {
    match sort {
        "name" => item.row.prompt.clone(),
        "type" => type_key(&item.row.file_path),
        "model" => item.row.model.clone(),
        "style" => item.row.style.clone(),
        "size" => item.file_size.to_string(),
        "dimensions" => (item.row.width * item.row.height).to_string(),
        "favorite" => (item.row.favorite as i64).to_string(),
        _ => item.row.created_at.clone(),
    }
}

fn encode_cursor(sort: &str, order: &str, key: String, id: i64) -> String {
    let payload = CursorPayload {
        sort: sort.to_string(),
        order: order.to_string(),
        key,
        id,
    };
    let bytes = serde_json::to_vec(&payload).unwrap_or_default();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn decode_cursor(raw: &str, sort: &str, order: &str) -> Option<(Value, i64)> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(raw).ok()?;
    let payload: CursorPayload = serde_json::from_slice(&bytes).ok()?;
    if payload.sort != sort || payload.order != order {
        return None;
    }
    let key = if is_numeric_sort(sort) {
        Value::Integer(payload.key.parse::<i64>().ok()?)
    } else {
        Value::Text(payload.key)
    };
    Some((key, payload.id))
}

fn escape_like(raw: &str) -> String {
    raw.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn history_item_from_row(row: &rusqlite::Row) -> rusqlite::Result<HistoryListItem> {
    Ok(HistoryListItem {
        row: history_from_row(row)?,
        file_size: row.get(16)?,
    })
}

/// 作品页查询：服务端完成筛选/查询/全局排序，游标保证翻页不重不漏。
pub fn list_history_page(q: &HistoryQuery) -> AppResult<HistoryPage> {
    let c = conn()?;
    list_history_page_in(&c, q)
}

pub(crate) fn list_history_page_in(c: &Connection, q: &HistoryQuery) -> AppResult<HistoryPage> {
    let limit = q.limit.clamp(1, 200);
    let offset = q.offset.max(0);
    let sort = canonical_sort(&q.sort);
    let order = if q.order == "asc" { "ASC" } else { "DESC" };
    let order_l = order.to_ascii_lowercase();
    let key_expr = sort_expr(sort);
    // 旧 before_id 调用必须保持 id DESC；新作品页一律走游标。
    let legacy = q.cursor.as_deref().filter(|s| !s.is_empty()).is_none() && q.before_id.is_some();

    let mut conditions: Vec<String> = Vec::new();
    let mut values: Vec<Value> = Vec::new();

    // 游标优先；给了游标但解析失败时按首页处理，不回退 before_id（避免跳到错误位置）。
    if let Some(raw) = q.cursor.as_deref().filter(|s| !s.is_empty()) {
        if let Some((key, id)) = decode_cursor(raw, sort, &order_l) {
            let op = if order == "ASC" { ">" } else { "<" };
            conditions.push(format!(
                "({key_expr} {op} ? OR ({key_expr} = ? AND id {op} ?))"
            ));
            values.push(key.clone());
            values.push(key);
            values.push(Value::Integer(id));
        }
    } else if let Some(before_id) = q.before_id.filter(|id| *id > 0) {
        conditions.push("id < ?".into());
        values.push(Value::Integer(before_id));
    }

    if !q.model.is_empty() {
        conditions.push("model = ?".into());
        values.push(Value::Text(q.model.clone()));
    }
    if !q.style.is_empty() {
        conditions.push("style = ?".into());
        values.push(Value::Text(q.style.clone()));
    }
    if q.favorite_only {
        conditions.push("favorite = 1".into());
    }
    let query = q.query.trim();
    if !query.is_empty() {
        let pattern = format!("%{}%", escape_like(query));
        conditions.push("(prompt LIKE ? ESCAPE '\\' OR model LIKE ? ESCAPE '\\')".into());
        values.push(Value::Text(pattern.clone()));
        values.push(Value::Text(pattern));
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };
    let order_clause = if legacy {
        "id DESC".to_string()
    } else {
        format!("{key_expr} {order}, id {order}")
    };
    let sql = format!(
        "SELECT id, prompt, negative_prompt, model, provider_name, seed, width, height,
         guidance, steps, style, file_path, favorite, created_at, parent_id, op, file_size
         FROM history{where_clause} ORDER BY {order_clause} LIMIT ? OFFSET ?"
    );

    values.push(Value::Integer(limit + 1));
    values.push(Value::Integer(offset));

    let mut stmt = c.prepare(&sql)?;
    let mut rows = stmt.query(params_from_iter(values))?;
    let mut items: Vec<HistoryListItem> = Vec::new();
    while let Some(row) = rows.next()? {
        items.push(history_item_from_row(row)?);
    }
    let has_more = items.len() as i64 > limit;
    if has_more {
        items.truncate(limit as usize);
    }
    let next_cursor = if has_more && !legacy {
        items
            .last()
            .map(|item| encode_cursor(sort, &order_l, cursor_key(item, sort), item.row.id))
    } else {
        None
    };
    Ok(HistoryPage {
        items,
        has_more,
        next_cursor,
    })
}

/// 启动后台回填文件大小：只处理 file_size = 0 的行；文件缺失写 -1 作为「已检查」。
pub fn backfill_file_sizes() -> AppResult<usize> {
    let c = conn()?;
    backfill_file_sizes_in(&c)
}

pub(crate) fn backfill_file_sizes_in(c: &Connection) -> AppResult<usize> {
    let mut total = 0usize;
    for _ in 0..100 {
        let rows: Vec<(i64, String)> = {
            let mut stmt =
                c.prepare("SELECT id, file_path FROM history WHERE file_size = 0 LIMIT 200")?;
            let mapped = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            let mut out = Vec::new();
            for row in mapped {
                out.push(row?);
            }
            out
        };
        if rows.is_empty() {
            break;
        }
        for (id, path) in &rows {
            let size = file_size_of(path);
            let value = if size > 0 { size } else { -1 };
            c.execute(
                "UPDATE history SET file_size = ?1 WHERE id = ?2 AND file_size = 0",
                params![value, id],
            )?;
        }
        total += rows.len();
        if rows.len() < 200 {
            break;
        }
    }
    Ok(total)
}

/// 画廊记录的原图路径（get_history_image 用）；记录不存在返回 None
pub fn history_file_path(id: i64) -> AppResult<Option<String>> {
    let c = conn()?;
    let mut stmt = c.prepare("SELECT file_path FROM history WHERE id = ?1")?;
    let mut rows = stmt.query_map(params![id], |r| r.get(0))?;
    Ok(rows.next().transpose()?)
}

fn history_from_row(row: &rusqlite::Row) -> rusqlite::Result<HistoryRow> {
    Ok(HistoryRow {
        id: row.get(0)?,
        prompt: row.get(1)?,
        negative_prompt: row.get(2)?,
        model: row.get(3)?,
        provider_name: row.get(4)?,
        seed: row.get(5)?,
        width: row.get(6)?,
        height: row.get(7)?,
        guidance: row.get(8)?,
        steps: row.get(9)?,
        style: row.get(10)?,
        file_path: row.get(11)?,
        favorite: row.get::<_, i64>(12)? != 0,
        created_at: row.get(13)?,
        parent_id: row.get(14)?,
        op: row.get(15)?,
    })
}

/// 按 id 取一条历史记录（transform_image 需要父图的尺寸与提示词）
pub fn history_row(id: i64) -> AppResult<Option<HistoryRow>> {
    let c = conn()?;
    history_row_in(&c, id)
}

pub(crate) fn history_row_in(c: &Connection, id: i64) -> AppResult<Option<HistoryRow>> {
    let mut stmt = c.prepare(
        "SELECT id, prompt, negative_prompt, model, provider_name, seed, width, height,
         guidance, steps, style, file_path, favorite, created_at, parent_id, op
         FROM history WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], history_from_row)?;
    Ok(rows.next().transpose()?)
}

/// 同族图片：沿 parent_id 上溯到根，再返回「根 + 它的直接派生」。
/// 上溯最多 32 跳，防止脏数据成环时死循环。
pub fn list_derived(id: i64) -> AppResult<Vec<HistoryRow>> {
    let Some(mut row) = history_row(id)? else {
        return Ok(Vec::new());
    };
    let mut root = row.id;
    for _ in 0..32 {
        match row.parent_id {
            Some(p) if p != root => match history_row(p)? {
                Some(parent) => {
                    root = parent.id;
                    row = parent;
                }
                None => break,
            },
            _ => break,
        }
    }
    let c = conn()?;
    let mut stmt = c.prepare(
        "SELECT id, prompt, negative_prompt, model, provider_name, seed, width, height,
         guidance, steps, style, file_path, favorite, created_at, parent_id, op
         FROM history WHERE id = ?1 OR parent_id = ?1 ORDER BY id ASC",
    )?;
    let rows = stmt.query_map(params![root], history_from_row)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

/// 步骤链：从当前记录沿 parent_id 上溯到根，返回 root→current 有序列表。
/// 最多 32 跳防环；记录不存在返回空。
pub fn history_lineage(id: i64) -> AppResult<Vec<HistoryRow>> {
    let c = conn()?;
    history_lineage_in(&c, id)
}

pub(crate) fn history_lineage_in(c: &Connection, id: i64) -> AppResult<Vec<HistoryRow>> {
    // 先按 current→root 逆序收集，再 reverse 成 root→current
    let mut chain = Vec::new();
    let mut cursor = Some(id);
    while let Some(current) = cursor {
        if chain.len() >= 32 {
            break;
        }
        let Some(row) = history_row_in(c, current)? else {
            break;
        };
        cursor = row.parent_id;
        chain.push(row);
    }
    chain.reverse();
    Ok(chain)
}

pub fn set_favorite(id: i64, favorite: bool) -> AppResult<()> {
    conn()?.execute(
        "UPDATE history SET favorite = ?2 WHERE id = ?1",
        params![id, favorite as i64],
    )?;
    Ok(())
}
/// 文件删除决策：调用方据此决定是否回收磁盘文件。
pub struct HistoryDeletion {
    pub file_path: Option<String>,
    /// true = 仍有 messages 或其它 history 行引用该文件，**不得删除文件**
    pub still_referenced: bool,
}

pub fn delete_history(id: i64) -> AppResult<HistoryDeletion> {
    let c = conn()?;
    delete_history_in(&c, id)
}

/// 先删行、再取引用集合：被删的那一行不能为文件"自我担保"，
/// 否则任何删除都会被判定为"仍被引用"。整个过程在一个事务内，
/// 避免与并发的消息写入交错导致漏判。
pub(crate) fn delete_history_in(c: &Connection, id: i64) -> AppResult<HistoryDeletion> {
    let tx = c.unchecked_transaction()?;
    let path: Option<String> = tx
        .query_row(
            "SELECT file_path FROM history WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .ok();
    tx.execute("DELETE FROM history WHERE id = ?1", params![id])?;
    let still_referenced = match path.as_deref() {
        Some(p) if !p.is_empty() => {
            collect_referenced_paths_in(&tx)?.contains(&normalize_path_key(p))
        }
        _ => false,
    };
    tx.commit()?;
    Ok(HistoryDeletion {
        file_path: path,
        still_referenced,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::*;

    /// 删除判定：被消息引用必须保留；无引用才允许回收；删行不影响判定自身的引用
    #[test]
    fn delete_history_keeps_file_when_still_referenced() {
        let c = mem_conn();
        let shared = insert_history_row(&c, r"C:\data\images\shared.png");
        let msg = insert_message(&c, 1, "ref");
        set_message_images(
            &c,
            msg,
            r#"[{"historyId":1,"path":"C:\\data\\images\\shared.png"}]"#,
        );

        let plan = delete_history_in(&c, shared).expect("delete shared");
        assert!(plan.still_referenced, "消息仍引用时必须保留文件");
        assert_eq!(count_history_rows(&c), 0, "画廊行本身仍应删掉");

        let solo = insert_history_row(&c, r"C:\data\images\solo.png");
        let plan = delete_history_in(&c, solo).expect("delete solo");
        assert!(!plan.still_referenced, "无其它引用时应允许回收文件");
        assert_eq!(
            plan.file_path.as_deref(),
            Some(r"C:\data\images\solo.png"),
            "返回值必须是原始路径，不能被归一化改写"
        );
    }

    /// M10：收藏过滤走 SQL，与模型/风格过滤组合后分页顺序不变
    #[test]
    fn list_history_filters_favorites_with_filters_and_order() {
        let c = mem_conn();
        for (i, (model, style, favorite)) in [
            ("m-a", "anime", false),
            ("m-a", "anime", true),
            ("m-b", "anime", true),
            ("m-a", "oil", true),
            ("m-b", "oil", false),
        ]
        .into_iter()
        .enumerate()
        {
            c.execute(
                "INSERT INTO history (prompt, model, provider_name, style, file_path, favorite, created_at, op)
                 VALUES (?1, ?2, 'P', ?3, ?4, ?5, ?6, 'generate')",
                params![
                    format!("p{i}"),
                    model,
                    style,
                    format!("/tmp/{i}.png"),
                    favorite as i64,
                    i.to_string()
                ],
            )
            .unwrap();
        }

        let ids = |rows: Vec<HistoryRow>| rows.iter().map(|r| r.id).collect::<Vec<_>>();
        // id 1..5 对应插入顺序；favorite_only 按 id DESC 返回收藏项
        assert_eq!(
            ids(list_history_in(&c, 10, 0, None, "", "", true).unwrap()),
            vec![4, 3, 2]
        );
        // 与模型过滤组合
        assert_eq!(
            ids(list_history_in(&c, 10, 0, None, "m-a", "", true).unwrap()),
            vec![4, 2]
        );
        // 与风格过滤组合
        assert_eq!(
            ids(list_history_in(&c, 10, 0, None, "", "anime", true).unwrap()),
            vec![3, 2]
        );
        // 分页顺序不变：收藏 4、3 之后是 2
        assert_eq!(
            ids(list_history_in(&c, 2, 0, None, "", "", true).unwrap()),
            vec![4, 3]
        );
        assert_eq!(
            ids(list_history_in(&c, 2, 2, None, "", "", true).unwrap()),
            vec![2]
        );
        // favorite_only=false 不改变全量列表
        assert_eq!(
            ids(list_history_in(&c, 10, 0, None, "", "", false).unwrap()),
            vec![5, 4, 3, 2, 1]
        );
    }

    /// F-015：分页参数在存储层钳制，负 limit 不再等于「一次拉全库」
    #[test]
    fn list_history_clamps_paging_params() {
        let c = mem_conn();
        for i in 0..3 {
            c.execute(
                "INSERT INTO history (prompt, model, provider_name, style, file_path, favorite, created_at, op)
                 VALUES (?1, 'm', 'P', 's', ?2, 0, ?3, 'generate')",
                params![format!("p{i}"), format!("/tmp/{i}.png"), i.to_string()],
            )
            .unwrap();
        }
        // SQLite 原生 LIMIT -1 表示不限；钳制后按 1 条返回
        assert_eq!(
            list_history_in(&c, -1, 0, None, "", "", false)
                .unwrap()
                .len(),
            1
        );
        // LIMIT 0 原本返回空页，钳制后至少 1 条，避免前端把空页当成「已到底」
        assert_eq!(
            list_history_in(&c, 0, 0, None, "", "", false)
                .unwrap()
                .len(),
            1
        );
        // 负数 offset 与 0 等价
        assert_eq!(
            list_history_in(&c, 10, -5, None, "", "", false)
                .unwrap()
                .len(),
            3
        );
    }

    /// E2：画廊用游标翻页，删除首页记录后继续加载不跳项
    #[test]
    fn list_history_cursor_pagination_survives_deletes() {
        let c = mem_conn();
        for i in 0..5 {
            c.execute(
                "INSERT INTO history (prompt, model, provider_name, style, file_path, favorite, created_at, op)
                 VALUES (?1, 'm', 'P', 's', ?2, 0, ?3, 'generate')",
                params![format!("p{i}"), format!("/tmp/{i}.png"), i.to_string()],
            )
            .unwrap();
        }
        let ids = |rows: Vec<HistoryRow>| rows.iter().map(|r| r.id).collect::<Vec<_>>();
        let first = ids(list_history_in(&c, 2, 0, None, "", "", false).unwrap());
        assert_eq!(first, vec![5, 4]);
        // 删掉已展示的记录，offset 会跳项；游标（id < 最后一条）不会
        c.execute("DELETE FROM history WHERE id = 4", []).unwrap();
        let next = ids(list_history_in(&c, 2, 0, Some(4), "", "", false).unwrap());
        assert_eq!(next, vec![3, 2]);
        let tail = ids(list_history_in(&c, 2, 0, Some(2), "", "", false).unwrap());
        assert_eq!(tail, vec![1]);
        // 新增记录不会插进已翻过的游标之后
        c.execute(
            "INSERT INTO history (prompt, model, provider_name, style, file_path, favorite, created_at, op)
             VALUES ('new', 'm', 'P', 's', '/tmp/new.png', 0, '9', 'generate')",
            [],
        )
        .unwrap();
        let after = ids(list_history_in(&c, 2, 0, Some(2), "", "", false).unwrap());
        assert_eq!(after, vec![1]);
    }

    /// 步骤链：root→current 有序，记录不存在返回空，脏数据成环时最多 32 跳
    #[test]
    fn history_lineage_walks_to_root_in_order() {
        let c = mem_conn();
        let insert = |prompt: &str, parent: Option<i64>| -> i64 {
            c.execute(
                "INSERT INTO history (prompt, model, provider_name, style, file_path, favorite,
                 created_at, op, parent_id)
                 VALUES (?1, 'm', 'P', '', ?2, 0, '0', 'retouch', ?3)",
                params![prompt, format!("/tmp/{prompt}.png"), parent],
            )
            .unwrap();
            c.last_insert_rowid()
        };
        let a = insert("a", None);
        let b = insert("b", Some(a));
        let cc = insert("c", Some(b));

        let ids = |rows: Vec<HistoryRow>| rows.iter().map(|r| r.id).collect::<Vec<_>>();
        assert_eq!(ids(history_lineage_in(&c, cc).unwrap()), vec![a, b, cc]);
        assert_eq!(ids(history_lineage_in(&c, b).unwrap()), vec![a, b]);
        assert_eq!(ids(history_lineage_in(&c, a).unwrap()), vec![a]);
        assert!(history_lineage_in(&c, 999_999).unwrap().is_empty());

        // 成环：a 指回 c，不能死循环，链长被 32 跳上限截断
        c.execute(
            "UPDATE history SET parent_id = ?1 WHERE id = ?2",
            params![cc, a],
        )
        .unwrap();
        assert_eq!(history_lineage_in(&c, cc).unwrap().len(), 32);
    }

    /// 作品页：名称升序游标翻页、大小降序、模糊查询与 before_id 兼容
    #[test]
    fn list_history_page_sorts_paginates_and_queries() {
        let c = mem_conn();
        let insert = |prompt: &str, size: i64, created: &str| {
            c.execute(
                "INSERT INTO history (prompt, model, provider_name, style, file_path,
                 favorite, created_at, op, file_size)
                 VALUES (?1, 'm', 'P', 's', ?2, 0, ?3, 'generate', ?4)",
                params![prompt, format!("/tmp/{prompt}.png"), created, size],
            )
            .unwrap();
        };
        insert("d", 40, "1");
        insert("b", 10, "2");
        insert("a", 30, "3");
        insert("c", 20, "4");

        let page = list_history_page_in(
            &c,
            &HistoryQuery {
                limit: 2,
                sort: "name".into(),
                order: "asc".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            page.items
                .iter()
                .map(|i| i.row.prompt.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        assert!(page.has_more);

        let page2 = list_history_page_in(
            &c,
            &HistoryQuery {
                limit: 2,
                cursor: page.next_cursor,
                sort: "name".into(),
                order: "asc".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            page2
                .items
                .iter()
                .map(|i| i.row.prompt.as_str())
                .collect::<Vec<_>>(),
            vec!["c", "d"]
        );
        assert!(!page2.has_more);
        assert!(page2.next_cursor.is_none());

        let by_size = list_history_page_in(
            &c,
            &HistoryQuery {
                limit: 4,
                sort: "size".into(),
                order: "desc".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            by_size
                .items
                .iter()
                .map(|i| i.row.prompt.as_str())
                .collect::<Vec<_>>(),
            vec!["d", "a", "c", "b"]
        );

        let filtered = list_history_page_in(
            &c,
            &HistoryQuery {
                limit: 10,
                query: "a".into(),
                sort: "name".into(),
                order: "asc".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            filtered
                .items
                .iter()
                .map(|i| i.row.prompt.as_str())
                .collect::<Vec<_>>(),
            vec!["a"]
        );

        let legacy = list_history_page_in(
            &c,
            &HistoryQuery {
                limit: 2,
                before_id: Some(3),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            legacy.items.iter().map(|i| i.row.id).collect::<Vec<_>>(),
            vec![2, 1]
        );
    }

    /// 类型排序 + 前端契约：HistoryListItem 必须序列化出 fileSize（camelCase）
    #[test]
    fn list_history_page_sorts_by_type_and_serializes_file_size() {
        let c = mem_conn();
        for (prompt, path, style) in [
            ("a", "/tmp/a.png", "oil"),
            ("b", "/tmp/b.gif", "anime"),
            ("c", "/tmp/c.jpg", "oil"),
        ] {
            c.execute(
                "INSERT INTO history (prompt, model, provider_name, style, file_path,
                 favorite, created_at, op, file_size, width, height)
                 VALUES (?1, 'm', 'P', ?2, ?3, 0, '1', 'generate', 10, 100, 100)",
                params![prompt, style, path],
            )
            .unwrap();
        }
        let page = list_history_page_in(
            &c,
            &HistoryQuery {
                limit: 10,
                sort: "type".into(),
                order: "asc".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            page.items
                .iter()
                .map(|i| i.row.prompt.as_str())
                .collect::<Vec<_>>(),
            vec!["b", "c", "a"]
        );
        let value = serde_json::to_value(&page.items[0]).unwrap();
        assert!(value.get("fileSize").is_some(), "前端需要 fileSize");
        assert!(value.get("file_path").is_none(), "必须序列化为 camelCase");
    }

    /// 启动回填：真实文件写实际大小，缺失文件写 -1 防止无限重试
    #[test]
    fn backfill_file_sizes_sets_size_and_marks_missing() {
        let c = mem_conn();
        let file = std::env::temp_dir().join(format!(
            "moling-history-size-{}-{}.png",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&file, b"12345").unwrap();
        c.execute(
            "INSERT INTO history (prompt, file_path, op) VALUES ('with-file', ?1, 'generate')",
            params![file.to_string_lossy().to_string()],
        )
        .unwrap();
        c.execute(
            "INSERT INTO history (prompt, file_path, op) VALUES ('missing', 'Z:/definitely/missing.png', 'generate')",
            [],
        )
        .unwrap();

        let n = backfill_file_sizes_in(&c).unwrap();
        assert_eq!(n, 2);
        let with_file: i64 = c
            .query_row(
                "SELECT file_size FROM history WHERE prompt = 'with-file'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(with_file, 5);
        let missing: i64 = c
            .query_row(
                "SELECT file_size FROM history WHERE prompt = 'missing'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(missing, -1);
        let _ = std::fs::remove_file(file);
    }
}
