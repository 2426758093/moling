use super::*;

use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection};
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
pub fn add_history(h: &HistoryRow) -> AppResult<i64> {
    let c = conn()?;
    c.execute(
        "INSERT INTO history (prompt, negative_prompt, model, provider_name, seed, width,
         height, guidance, steps, style, file_path, favorite, created_at, parent_id, op)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
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
            h.op
        ],
    )?;
    Ok(c.last_insert_rowid())
}

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
}
