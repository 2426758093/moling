use super::*;

use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection};
use std::collections::HashSet;
use std::path::Path;

/// 路径比较键：分隔符统一为 `\`、忽略大小写。
///
/// Windows 上同一文件可能写成 `C:/a/b.png` 或 `c:\A\B.PNG`，直接字符串比较
/// 会漏判"仍被引用"，进而误删聊天里正在显示的图。
pub(crate) fn normalize_path_key(p: &str) -> String {
    p.trim().replace('/', "\\").to_lowercase()
}

/// 引用集合 = `history.file_path` ∪ `messages.images_json[].path`
/// ∪ `jobs.images_json[].path` ∪ `jobs.input_json.referencePaths`
/// ∪ `workflow_presets.refs_json[].path`
/// ∪ 画布 JSON 的 `nodes[].layers[].path` 与 `nodes[].regions[].maskPath`。
///
/// 用 JSON 结构化解析而不是 LIKE：JSON 里的 Windows 路径是转义双反斜杠，
/// LIKE 匹配不上；子串匹配还会让 `a.png` 命中 `xa.png`。
/// `CASE + json_valid` 是必需的：`json_each` 遇到坏 JSON 会让整条查询报错，
/// 一行脏数据就能让回收链路全线失效。
pub(crate) fn collect_referenced_paths_in(c: &Connection) -> AppResult<HashSet<String>> {
    const SQL: &str = "
        SELECT file_path FROM history WHERE file_path <> ''
        UNION
        SELECT json_extract(j.value, '$.path')
        FROM messages m
        JOIN json_each(CASE WHEN json_valid(m.images_json)
                            THEN m.images_json ELSE '[]' END) AS j
        WHERE j.type = 'object' AND json_type(j.value, '$.path') = 'text'
        UNION
        SELECT json_extract(j.value, '$.path')
        FROM jobs q
        JOIN json_each(CASE WHEN json_valid(q.images_json)
                            THEN q.images_json ELSE '[]' END) AS j
        WHERE j.type = 'object' AND json_type(j.value, '$.path') = 'text'
        UNION
        SELECT rp.value
        FROM jobs q
        JOIN json_each(CASE WHEN json_valid(q.input_json)
                            THEN q.input_json ELSE '{}' END, '$.referencePaths') AS rp
        WHERE rp.type = 'text'
        UNION
        SELECT json_extract(r.value, '$.path')
        FROM workflow_presets p
        JOIN json_each(CASE WHEN json_valid(p.refs_json)
                            THEN p.refs_json ELSE '[]' END) AS r
        WHERE r.type = 'object' AND json_type(r.value, '$.path') = 'text'
        UNION
        SELECT json_extract(l.value, '$.path')
        FROM canvas_boards b
        JOIN json_each(CASE WHEN json_valid(b.data_json)
                            THEN b.data_json ELSE '{}' END, '$.nodes') AS n
        JOIN json_each(CASE WHEN json_type(n.value, '$.layers') = 'array'
                            THEN json_extract(n.value, '$.layers') ELSE '[]' END) AS l
        WHERE l.type = 'object' AND json_type(l.value, '$.path') = 'text'
        UNION
        SELECT json_extract(g.value, '$.maskPath')
        FROM canvas_boards b
        JOIN json_each(CASE WHEN json_valid(b.data_json)
                            THEN b.data_json ELSE '{}' END, '$.nodes') AS n
        JOIN json_each(CASE WHEN json_type(n.value, '$.regions') = 'array'
                            THEN json_extract(n.value, '$.regions') ELSE '[]' END) AS g
        WHERE g.type = 'object' AND json_type(g.value, '$.maskPath') = 'text'
    ";
    let mut stmt = c.prepare(SQL)?;
    let rows = stmt.query_map([], |r| r.get::<_, Option<String>>(0))?;
    let mut out = HashSet::new();
    for row in rows {
        if let Some(p) = row? {
            let key = normalize_path_key(&p);
            if !key.is_empty() {
                out.insert(key);
            }
        }
    }
    Ok(out)
}

/// 供启动扫描使用的快照入口：内部短暂持锁，返回后即释放，
/// 扫描线程不在遍历磁盘期间占用数据库锁。
pub(crate) fn referenced_image_paths_snapshot() -> AppResult<HashSet<String>> {
    let c = conn()?;
    collect_referenced_paths_in(&c)
}

/// 媒体根归一化键：分隔符统一、忽略大小写、去掉尾部分隔符。
fn media_root_key(p: &Path) -> String {
    normalize_path_key(&p.to_string_lossy())
        .trim_end_matches('\\')
        .to_string()
}

/// 单条路径改写：只有落在旧根之下的路径才改写，其余原样不动。
fn rewrite_path(p: &str, old_key: &str, new_root: &str) -> Option<String> {
    let orig = p.trim();
    let key = normalize_path_key(orig);
    let prefix = format!("{old_key}\\");
    if !key.starts_with(&prefix) {
        return None;
    }
    // 保留原路径的相对部分与大小写；非 ASCII 大小写折叠可能改变字节长度，
    // 切不出原串时退回归一化尾段（Windows 下大小写不敏感，仍可解析）。
    let tail = orig
        .get(old_key.len()..)
        .map(|t| t.replace('/', "\\"))
        .unwrap_or_else(|| key[old_key.len()..].to_string());
    Some(format!("{new_root}{tail}"))
}

/// 改写 `[{path}]` 形态的 JSON 列（messages / jobs 的 images_json、预设 refs_json）
fn rewrite_json_path_array(
    tx: &Connection,
    table: &str,
    column: &str,
    old_key: &str,
    new_root: &str,
) -> AppResult<usize> {
    let rows: Vec<(i64, String)> = {
        let sql = format!("SELECT id, \"{column}\" FROM \"{table}\" WHERE \"{column}\" <> ''");
        let mut stmt = tx.prepare(&sql)?;
        let mapped = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        mapped.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut changed = 0usize;
    for (id, raw) in rows {
        let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let Some(items) = value.as_array_mut() else {
            continue;
        };
        let mut touched = 0usize;
        for item in items {
            let Some(path) = item.get("path").and_then(|v| v.as_str()) else {
                continue;
            };
            if let Some(next) = rewrite_path(path, old_key, new_root) {
                if let Some(obj) = item.as_object_mut() {
                    obj.insert("path".into(), next.into());
                    touched += 1;
                }
            }
        }
        if touched == 0 {
            continue;
        }
        let sql = format!("UPDATE \"{table}\" SET \"{column}\" = ?1 WHERE id = ?2");
        tx.execute(&sql, params![json_string(&value)?, id])?;
        changed += touched;
    }
    Ok(changed)
}

/// 改写后的 JSON 序列化（`AppError` 没有 serde_json 转换，就地映射）
fn json_string(value: &serde_json::Value) -> AppResult<String> {
    serde_json::to_string(value).map_err(|e| AppError::Other(format!("序列化 JSON 失败: {e}")))
}

/// 改写 `jobs.input_json.referencePaths`（队列参考图路径数组）
fn rewrite_job_inputs(tx: &Connection, old_key: &str, new_root: &str) -> AppResult<usize> {
    let rows: Vec<(i64, String)> = {
        let mut stmt = tx.prepare("SELECT id, input_json FROM jobs WHERE input_json <> ''")?;
        let mapped = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        mapped.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut changed = 0usize;
    for (id, raw) in rows {
        let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let Some(paths) = value
            .get_mut("referencePaths")
            .and_then(|v| v.as_array_mut())
        else {
            continue;
        };
        let mut touched = 0usize;
        for item in paths.iter_mut() {
            let Some(path) = item.as_str() else { continue };
            if let Some(next) = rewrite_path(path, old_key, new_root) {
                *item = serde_json::Value::String(next);
                touched += 1;
            }
        }
        if touched == 0 {
            continue;
        }
        tx.execute(
            "UPDATE jobs SET input_json = ?1 WHERE id = ?2",
            params![json_string(&value)?, id],
        )?;
        changed += touched;
    }
    Ok(changed)
}

/// 改写 `canvas_boards.data_json` 里图层蒙版与分区蒙版路径（第 6 处引用）
fn rewrite_canvas_media_paths(tx: &Connection, old_key: &str, new_root: &str) -> AppResult<usize> {
    let rows: Vec<(i64, String)> = {
        let mut stmt =
            tx.prepare("SELECT id, data_json FROM canvas_boards WHERE data_json <> ''")?;
        let mapped = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        mapped.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut changed = 0usize;
    for (id, raw) in rows {
        let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let Some(nodes) = value.get_mut("nodes").and_then(|v| v.as_array_mut()) else {
            continue;
        };
        let mut touched = 0usize;
        for node in nodes.iter_mut() {
            for (field, key) in [("layers", "path"), ("regions", "maskPath")] {
                let Some(items) = node.get_mut(field).and_then(|v| v.as_array_mut()) else {
                    continue;
                };
                for item in items.iter_mut() {
                    let Some(path) = item.get(key).and_then(|v| v.as_str()) else {
                        continue;
                    };
                    if let Some(next) = rewrite_path(path, old_key, new_root) {
                        if let Some(obj) = item.as_object_mut() {
                            obj.insert(key.into(), next.into());
                            touched += 1;
                        }
                    }
                }
            }
        }
        if touched == 0 {
            continue;
        }
        tx.execute(
            "UPDATE canvas_boards SET data_json = ?1 WHERE id = ?2",
            params![json_string(&value)?, id],
        )?;
        changed += touched;
    }
    Ok(changed)
}

/// 媒体根搬家后的路径改写：覆盖库中全部 6 处引用，单事务提交。
///
/// 只改写落在旧根下的路径（前缀按目录边界比较，`images2` 不会被 `images` 命中）；
/// 对已经是新根的库再次调用不会产生任何变更，可安全重试。
pub fn rewrite_media_root(old: &Path, new: &Path) -> AppResult<usize> {
    let c = conn()?;
    rewrite_media_root_in(&c, old, new)
}

pub(crate) fn rewrite_media_root_in(c: &Connection, old: &Path, new: &Path) -> AppResult<usize> {
    let old_key = media_root_key(old);
    let new_root = new
        .to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_string();
    if old_key.is_empty() || new_root.is_empty() {
        return Err(AppError::Other("媒体目录路径为空，无法改写".into()));
    }
    let tx = c.unchecked_transaction()?;
    let mut changed = 0usize;

    // 1) history.file_path
    let history_rows: Vec<(i64, String)> = {
        let mut stmt = tx.prepare("SELECT id, file_path FROM history WHERE file_path <> ''")?;
        let mapped = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        mapped.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (id, path) in history_rows {
        if let Some(next) = rewrite_path(&path, &old_key, &new_root) {
            tx.execute(
                "UPDATE history SET file_path = ?1 WHERE id = ?2",
                params![next, id],
            )?;
            changed += 1;
        }
    }

    // 2) messages.images_json、3) jobs.images_json、5) workflow_presets.refs_json
    changed += rewrite_json_path_array(&tx, "messages", "images_json", &old_key, &new_root)?;
    changed += rewrite_json_path_array(&tx, "jobs", "images_json", &old_key, &new_root)?;
    changed += rewrite_json_path_array(&tx, "workflow_presets", "refs_json", &old_key, &new_root)?;

    // 4) jobs.input_json.referencePaths
    changed += rewrite_job_inputs(&tx, &old_key, &new_root)?;

    // 6) canvas_boards.data_json 图层与分区蒙版
    changed += rewrite_canvas_media_paths(&tx, &old_key, &new_root)?;

    tx.commit()?;
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::*;

    /// 路径归一化：分隔符与大小写差异不得影响"是否仍被引用"的判定
    #[test]
    fn normalize_path_key_unifies_separators_and_case() {
        assert_eq!(
            normalize_path_key("C:/Users/A/b.PNG"),
            normalize_path_key(r"C:\users\a\B.png")
        );
        assert_eq!(normalize_path_key("  x  "), "x");
    }

    /// 引用集合必须覆盖 history.file_path 与 messages 里的两种 path 形态
    /// （生成图 `{historyId,path}`、附件 `{id,name,path}`）
    #[test]
    fn referenced_paths_cover_history_and_messages() {
        let c = mem_conn();
        insert_history_row(&c, r"C:\data\images\a.png");
        let generated = insert_message(&c, 1, "hi");
        set_message_images(
            &c,
            generated,
            r#"[{"historyId":1,"path":"C:\\data\\images\\b.png"}]"#,
        );
        let attachment = insert_message(&c, 1, "ref");
        set_message_images(
            &c,
            attachment,
            r#"[{"id":"x","name":"n","path":"C:\\data\\images\\c.png"}]"#,
        );
        let set = collect_referenced_paths_in(&c).expect("collect");
        for p in [
            r"C:\data\images\a.png",
            r"C:\data\images\b.png",
            r"C:\data\images\c.png",
        ] {
            assert!(set.contains(&normalize_path_key(p)), "缺少引用: {p}");
        }
        assert_eq!(set.len(), 3, "同路径重复出现应去重");
    }

    /// 坏 JSON 不能拖垮整条查询：一行脏数据就会让回收链路全线失效
    #[test]
    fn referenced_paths_survive_corrupt_images_json() {
        let c = mem_conn();
        insert_history_row(&c, "/tmp/keep.png");
        let bad = insert_message(&c, 1, "bad");
        set_message_images(&c, bad, "not-json");
        let set = collect_referenced_paths_in(&c).expect("坏 JSON 不应导致查询失败");
        assert_eq!(set.len(), 1);
        assert!(set.contains(&normalize_path_key("/tmp/keep.png")));
    }

    /// 引用集合还要覆盖队列参考图与工作流预设参考图：
    /// 漏掉任何一处，清理缓存都会把仍在排队/预设里的参考图当孤儿移走
    #[test]
    fn referenced_paths_include_jobs_and_presets() {
        let c = mem_conn();
        insert_history_row(&c, r"C:\media\images\h.png");
        c.execute(
            "INSERT INTO jobs (provider_id, created_at, images_json, input_json)
             VALUES (1, '0', ?1, ?2)",
            params![
                r#"[{"historyId":1,"path":"C:\\media\\images\\job.png"}]"#,
                r#"{"referencePaths":["C:\\media\\refs\\queue.png"],"references":[]}"#
            ],
        )
        .unwrap();
        save_preset_in(
            &c,
            None,
            "夜景",
            "",
            "",
            "{}",
            &[PresetRef {
                path: r"C:\media\refs\preset.png".into(),
                role: "style".into(),
                strength: 60,
            }],
        )
        .expect("save preset");

        let set = collect_referenced_paths_in(&c).expect("collect");
        for p in [
            r"C:\media\images\h.png",
            r"C:\media\images\job.png",
            r"C:\media\refs\queue.png",
            r"C:\media\refs\preset.png",
        ] {
            assert!(set.contains(&normalize_path_key(p)), "缺少引用: {p}");
        }
        assert_eq!(set.len(), 4);
    }

    /// 队列 input_json / 预设 refs_json 损坏时不得让整条引用查询失败
    #[test]
    fn referenced_paths_survive_corrupt_job_and_preset_json() {
        let c = mem_conn();
        c.execute(
            "INSERT INTO jobs (provider_id, created_at, images_json, input_json)
             VALUES (1, '0', 'not-json', 'not-json')",
            [],
        )
        .unwrap();
        let preset = save_preset_in(&c, None, "p", "", "", "{}", &[]).expect("save preset");
        c.execute(
            "UPDATE workflow_presets SET refs_json = 'oops' WHERE id = ?1",
            params![preset.id],
        )
        .unwrap();
        let set = collect_referenced_paths_in(&c).expect("坏 JSON 不应导致查询失败");
        assert!(set.is_empty());
    }

    /// 媒体根改写必须覆盖全部 5 处引用、保留大小写、不动旧根之外的路径，且幂等
    #[test]
    fn rewrite_media_root_updates_all_references_and_is_idempotent() {
        let c = mem_conn();
        let old = Path::new(r"E:\old root");
        let new = Path::new(r"D:\new\media");

        let history_id = insert_history_row(&c, r"E:\old root\images\a.PNG");
        let message_id = insert_message(&c, 1, "hi");
        set_message_images(
            &c,
            message_id,
            r#"[{"historyId":1,"path":"E:\\old root\\images\\b.png"},{"path":"E:\\other\\keep.png"}]"#,
        );
        c.execute(
            "INSERT INTO jobs (provider_id, created_at, images_json, input_json)
             VALUES (1, '0', ?1, ?2)",
            params![
                r#"[{"historyId":1,"path":"E:\\old root\\images\\c.png"}]"#,
                r#"{"referencePaths":["E:\\old root\\refs\\q.png","E:\\other\\r2.png"],"references":[]}"#
            ],
        )
        .unwrap();
        let preset = save_preset_in(
            &c,
            None,
            "p",
            "",
            "",
            "{}",
            &[PresetRef {
                path: r"E:\old root\refs\preset.png".into(),
                role: "style".into(),
                strength: 80,
            }],
        )
        .expect("save preset");
        // 旧根的「兄弟目录」不能被前缀误改
        insert_history_row(&c, r"E:\old root2\images\sibling.png");

        let changed = rewrite_media_root_in(&c, old, new).expect("rewrite");
        assert_eq!(
            changed, 5,
            "history/message/job 图/队列参考图/预设参考图各一处"
        );

        let file_path: String = c
            .query_row(
                "SELECT file_path FROM history WHERE id = ?1",
                params![history_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(file_path, r"D:\new\media\images\a.PNG");

        let images_json: String = c
            .query_row(
                "SELECT images_json FROM messages WHERE id = ?1",
                params![message_id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(images_json.contains(r"D:\\new\\media\\images\\b.png"));
        assert!(
            images_json.contains(r"E:\\other\\keep.png"),
            "旧根外路径不动"
        );

        let (job_images, job_input): (String, String) = c
            .query_row(
                "SELECT images_json, input_json FROM jobs LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(job_images.contains(r"D:\\new\\media\\images\\c.png"));
        assert!(job_input.contains(r"D:\\new\\media\\refs\\q.png"));
        assert!(job_input.contains(r"E:\\other\\r2.png"), "旧根外路径不动");

        let refs_json: String = c
            .query_row(
                "SELECT refs_json FROM workflow_presets WHERE id = ?1",
                params![preset.id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(refs_json.contains(r"D:\\new\\media\\refs\\preset.png"));

        let sibling: String = c
            .query_row(
                "SELECT file_path FROM history WHERE file_path LIKE '%sibling.png'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(sibling, r"E:\old root2\images\sibling.png");

        // 幂等：再跑一次不应有任何变更
        assert_eq!(rewrite_media_root_in(&c, old, new).unwrap(), 0);
    }

    /// 画布蒙版路径必须进入引用集合，否则清理缓存会把仍在使用的蒙版移走
    #[test]
    fn referenced_paths_include_canvas_masks() {
        let c = mem_conn();
        let board = create_canvas_board_in(&c, "蒙版").unwrap();
        let doc = r#"{"version":2,"nodes":[{"id":"n1","historyId":1,"x":0,"y":0,"width":220,"layers":[{"id":"m1","kind":"mask","path":"C:\\media\\images\\mask.png","visible":true,"opacity":1,"locked":false}],"regions":[{"id":"r1","prompt":"p","maskPath":"C:\\media\\images\\region.png","feather":24}]}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}"#;
        save_canvas_board_in(&c, board.id, "蒙版", doc).unwrap();

        let set = collect_referenced_paths_in(&c).expect("collect");
        assert!(set.contains(&normalize_path_key(r"C:\media\images\mask.png")));
        assert!(set.contains(&normalize_path_key(r"C:\media\images\region.png")));
        assert_eq!(set.len(), 2);

        // 坏画布 JSON 不能让整条引用查询失败
        c.execute(
            "UPDATE canvas_boards SET data_json = 'not-json' WHERE id = ?1",
            params![board.id],
        )
        .unwrap();
        collect_referenced_paths_in(&c).expect("坏 JSON 不应导致查询失败");
    }

    /// 媒体根改写覆盖画布图层/分区蒙版（第 6 处），且幂等
    #[test]
    fn rewrite_media_root_updates_canvas_masks() {
        let c = mem_conn();
        let old = Path::new(r"E:\old root");
        let new = Path::new(r"D:\new\media");
        let board = create_canvas_board_in(&c, "搬家").unwrap();
        let doc = r#"{"version":2,"nodes":[{"id":"n1","historyId":1,"x":0,"y":0,"width":220,"layers":[{"id":"m1","kind":"mask","path":"E:\\old root\\images\\mask.png"}],"regions":[{"id":"r1","prompt":"p","maskPath":"E:\\old root\\images\\region.png","feather":24},{"id":"r2","prompt":"q","maskPath":"E:\\other\\keep.png","feather":24}]}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}"#;
        save_canvas_board_in(&c, board.id, "搬家", doc).unwrap();

        let changed = rewrite_media_root_in(&c, old, new).expect("rewrite");
        assert_eq!(changed, 2, "图层与分区蒙版各一处");

        let data_json: String = c
            .query_row(
                "SELECT data_json FROM canvas_boards WHERE id = ?1",
                params![board.id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(data_json.contains(r"D:\\new\\media\\images\\mask.png"));
        assert!(data_json.contains(r"D:\\new\\media\\images\\region.png"));
        assert!(data_json.contains(r"E:\\other\\keep.png"), "旧根外路径不动");

        assert_eq!(rewrite_media_root_in(&c, old, new).unwrap(), 0, "幂等");
    }
}
