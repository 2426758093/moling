use crate::{image_store, storage};
use std::path::Path;

/// 批量缩略图单次上限：画布一次最多加载 500 个节点，但缩略图按需分批取，
/// 200 张已足够覆盖一屏并避免单次 IPC 体积失控。
const MAX_BATCH_THUMBS: usize = 200;

#[tauri::command]
pub fn list_canvas_boards() -> Result<Vec<storage::CanvasBoardMeta>, String> {
    storage::list_canvas_boards().map_err(Into::into)
}

#[tauri::command]
pub fn create_canvas_board(name: String) -> Result<storage::CanvasBoard, String> {
    storage::create_canvas_board(&name).map_err(Into::into)
}

#[tauri::command]
pub fn get_canvas_board(id: i64) -> Result<Option<storage::CanvasBoard>, String> {
    storage::get_canvas_board(id).map_err(Into::into)
}

#[tauri::command]
pub fn save_canvas_board(
    id: i64,
    name: String,
    data_json: String,
) -> Result<storage::CanvasBoard, String> {
    storage::save_canvas_board(id, &name, &data_json).map_err(Into::into)
}

#[tauri::command]
pub fn delete_canvas_board(id: i64) -> Result<bool, String> {
    storage::delete_canvas_board(id).map_err(Into::into)
}

/// 画布节点只存 historyId，缩略图按需批量读取；缺失文件直接跳过。
#[tauri::command]
pub async fn batch_history_thumbs(ids: Vec<i64>) -> Result<Vec<serde_json::Value>, String> {
    if ids.len() > MAX_BATCH_THUMBS {
        return Err(format!("一次最多读取 {MAX_BATCH_THUMBS} 张缩略图"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        thumbs_payload(
            ids,
            |id| storage::history_file_path(id).ok().flatten(),
            image_store::path_to_data_url,
        )
    })
    .await
    .map_err(|e| format!("读取缩略图失败: {e}"))
}

fn thumbs_payload<F, G>(ids: Vec<i64>, fetch: F, encode: G) -> Vec<serde_json::Value>
where
    F: Fn(i64) -> Option<String>,
    G: Fn(&str) -> Option<String>,
{
    let mut out = Vec::new();
    for id in ids {
        let Some(path) = fetch(id) else {
            continue;
        };
        // 缩略图可能还没回填：先补生成，再编码；仍失败才回退原图
        let source = Path::new(&path);
        let _ = image_store::ensure_thumb(source);
        let thumb = image_store::thumb_path_for(source);
        let Some(url) = encode(&thumb.to_string_lossy()).or_else(|| encode(&path)) else {
            continue;
        };
        out.push(serde_json::json!({ "historyId": id, "thumbUrl": url }));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 批量缩略图：缺失路径与读取失败都跳过，缩略图失败时回退原图
    #[test]
    fn thumbs_payload_skips_missing_and_falls_back_to_original() {
        let ids = vec![1, 2, 3, 4];
        let out = thumbs_payload(
            ids,
            |id| match id {
                1 => Some(r"C:\imgs\one.png".into()),
                3 => Some(r"C:\imgs\three.png".into()),
                4 => Some(r"C:\imgs\four.png".into()),
                _ => None,
            },
            |path| {
                if path.ends_with(r".thumb\one.jpg") {
                    Some("thumb-one".into())
                } else if path.ends_with(r"four.png") {
                    Some("orig-four".into())
                } else {
                    None
                }
            },
        );
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["historyId"], 1);
        assert_eq!(out[0]["thumbUrl"], "thumb-one");
        assert_eq!(out[1]["historyId"], 4);
        assert_eq!(out[1]["thumbUrl"], "orig-four");
    }

    /// 缩略图缺失时批量读取会先补生成，而不是直接回退原图
    #[test]
    fn thumbs_payload_generates_missing_thumbnail() {
        let dir = std::env::temp_dir().join(format!("moling_canvas_thumb_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("big.png");
        image::RgbImage::from_pixel(1024, 512, image::Rgb([1, 2, 3]))
            .save(&source)
            .unwrap();

        let out = thumbs_payload(
            vec![7],
            |_| Some(source.to_string_lossy().to_string()),
            image_store::path_to_data_url,
        );
        assert_eq!(out.len(), 1);
        let url = out[0]["thumbUrl"].as_str().unwrap();
        assert!(url.starts_with("data:image/jpeg;base64,"), "{url}");
        assert!(image_store::thumb_path_for(&source).exists());
        std::fs::remove_dir_all(&dir).ok();
    }
}
