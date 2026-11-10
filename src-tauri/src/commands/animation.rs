//! GIF 动图的命令层：读元数据、抽帧、优化、单帧替换与导出。
//!
//! 生成与编辑仍在 `commands::image`；这里只处理「已经落盘的动图」，
//! 所有 CPU 密集操作放进 `spawn_blocking`，产物统一落成新的画廊记录
//! （`op="anim-*"`，`parent_id` 记来源），与静图的血缘规则保持一致。

use crate::animation::{self, AnimationInfo};
use crate::{image_store, storage};
use base64::Engine;
use serde::Serialize;

const DEFAULT_PREVIEW_EDGE: u32 = 160;
const MIN_PREVIEW_EDGE: u32 = 16;
const MAX_PREVIEW_EDGE: u32 = 512;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FramePreview {
    pub index: u32,
    pub delay_ms: u32,
    pub data_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameImage {
    pub index: u32,
    pub width: u32,
    pub height: u32,
    pub delay_ms: u32,
    pub data_url: String,
}

fn load_source(history_id: i64) -> Result<(storage::HistoryRow, Vec<u8>), String> {
    let row = storage::history_row(history_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("画廊记录 #{history_id} 不存在"))?;
    if row.file_path.trim().is_empty() {
        return Err(format!("画廊记录 #{history_id} 没有图片"));
    }
    let bytes = std::fs::read(&row.file_path).map_err(|e| format!("读取动图失败: {e}"))?;
    Ok((row, bytes))
}

fn png_bytes(frame: &image::RgbaImage) -> Result<Vec<u8>, String> {
    let mut cursor = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(frame.clone())
        .write_to(&mut cursor, image::ImageFormat::Png)
        .map_err(|e| format!("帧编码失败: {e}"))?;
    Ok(cursor.into_inner())
}

fn png_data_url(frame: &image::RgbaImage) -> Result<String, String> {
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png_bytes(frame)?)
    ))
}

/// 派生记录：新文件 + 新 history，尺寸由调用方给出（动图取容器尺寸，静图取帧尺寸）。
fn save_derived_bytes(
    app: &tauri::AppHandle,
    source: &storage::HistoryRow,
    op: &str,
    bytes: &[u8],
    width: u32,
    height: u32,
) -> Result<(i64, String, String), String> {
    let now = storage::timestamp_millis();
    let name = image_store::unique_name("anim_", &now, 0);
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    let (path, data_url) = image_store::save_b64_image_with_retry(app, &b64, &name)
        .map_err(|e| format!("保存动图失败: {e}"))?;
    let id = storage::add_history(&storage::HistoryRow {
        id: 0,
        prompt: source.prompt.clone(),
        negative_prompt: source.negative_prompt.clone(),
        model: source.model.clone(),
        provider_name: source.provider_name.clone(),
        seed: None,
        width: i64::from(width),
        height: i64::from(height),
        guidance: 0.0,
        steps: 0,
        style: String::new(),
        file_path: path.clone(),
        favorite: false,
        created_at: now,
        parent_id: Some(source.id),
        op: op.to_string(),
    })
    .map_err(|e| e.to_string())?;
    Ok((id, path, data_url))
}

fn save_derived(
    app: &tauri::AppHandle,
    source: &storage::HistoryRow,
    op: &str,
    bytes: &[u8],
    info: &AnimationInfo,
) -> Result<(i64, String, String), String> {
    save_derived_bytes(app, source, op, bytes, info.width, info.height)
}

/// 读取动图元数据：帧数、逐帧时长、循环次数与体积，不解码像素。
#[tauri::command]
pub async fn get_animation_info(history_id: i64) -> Result<AnimationInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_, bytes) = load_source(history_id)?;
        animation::probe(&bytes)
    })
    .await
    .map_err(|e| format!("读取动图信息失败: {e}"))?
}

/// 时间轴缩略图：按 `max_edge` 降采样后逐帧转 PNG data URL。
#[tauri::command]
pub async fn get_animation_frames(
    history_id: i64,
    max_edge: Option<u32>,
) -> Result<Vec<FramePreview>, String> {
    let edge = max_edge
        .unwrap_or(DEFAULT_PREVIEW_EDGE)
        .clamp(MIN_PREVIEW_EDGE, MAX_PREVIEW_EDGE);
    tauri::async_runtime::spawn_blocking(move || {
        let (_, bytes) = load_source(history_id)?;
        let info = animation::probe(&bytes)?;
        let frames = animation::decode_frames(&bytes, edge)?;
        frames
            .iter()
            .enumerate()
            .map(|(index, frame)| {
                Ok(FramePreview {
                    index: index as u32,
                    delay_ms: info.durations_ms.get(index).copied().unwrap_or(100),
                    data_url: png_data_url(frame)?,
                })
            })
            .collect()
    })
    .await
    .map_err(|e| format!("读取动图帧失败: {e}"))?
}

/// 全尺寸单帧（单帧修复的底图）。
#[tauri::command]
pub async fn get_animation_frame(history_id: i64, index: u32) -> Result<FrameImage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_, bytes) = load_source(history_id)?;
        let info = animation::probe(&bytes)?;
        if index >= info.frames {
            return Err(format!("帧序号 {index} 超出范围（共 {} 帧）", info.frames));
        }
        let frames = animation::decode_frames(&bytes, 0)?;
        let frame = &frames[index as usize];
        Ok(FrameImage {
            index,
            width: frame.width(),
            height: frame.height(),
            delay_ms: info
                .durations_ms
                .get(index as usize)
                .copied()
                .unwrap_or(100),
            data_url: png_data_url(frame)?,
        })
    })
    .await
    .map_err(|e| format!("读取动图帧失败: {e}"))?
}

/// 体积优化：降量化 / 缩放 / 减帧最多 6 轮，达不到目标时保留最小的一份。
#[tauri::command]
pub async fn optimize_animation(
    app: tauri::AppHandle,
    history_id: i64,
    target_bytes: usize,
) -> Result<serde_json::Value, String> {
    let target = target_bytes.clamp(64 * 1024, animation::MAX_BYTES);
    tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let (row, bytes) = load_source(history_id)?;
        let out = animation::optimize(&bytes, target)?;
        let info = animation::probe(&out)?;
        let (id, path, data_url) = save_derived(&app, &row, "anim-optimize", &out, &info)?;
        Ok(serde_json::json!({
            "historyId": id,
            "dataUrl": data_url,
            "filePath": path,
            "animation": info,
            "targetBytes": target,
            "reached": out.len() <= target,
        }))
    })
    .await
    .map_err(|e| format!("优化动图失败: {e}"))?
}

/// 单帧替换：帧数、其余帧像素与逐帧时长保持不变。
#[tauri::command]
pub async fn replace_animation_frame(
    app: tauri::AppHandle,
    history_id: i64,
    index: u32,
    data_url: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let (row, bytes) = load_source(history_id)?;
        let raw = base64::engine::general_purpose::STANDARD
            .decode(image_store::strip_data_url(&data_url).trim())
            .map_err(|e| format!("帧内容解码失败: {e}"))?;
        let frame = image_store::decode_limited(&raw)?.to_rgba8();
        let out = animation::replace_frame(&bytes, index as usize, &frame)?;
        let info = animation::probe(&out)?;
        let (id, path, url) = save_derived(&app, &row, "anim-frame", &out, &info)?;
        Ok(serde_json::json!({
            "historyId": id,
            "dataUrl": url,
            "filePath": path,
            "animation": info,
            "index": index,
        }))
    })
    .await
    .map_err(|e| format!("替换动图帧失败: {e}"))?
}

fn write_zip_entry(
    zip: &mut zip::ZipWriter<std::fs::File>,
    name: &str,
    bytes: &[u8],
    stored: bool,
) -> Result<(), String> {
    let method = if stored {
        zip::CompressionMethod::Stored
    } else {
        zip::CompressionMethod::Deflated
    };
    let options = zip::write::SimpleFileOptions::default().compression_method(method);
    zip.start_file(name, options)
        .map_err(|e| format!("写入压缩包失败: {e}"))?;
    std::io::Write::write_all(zip, bytes).map_err(|e| format!("写入压缩包失败: {e}"))
}

/// 导出 zip：`gif` 模式含动图与封面 PNG，`png-sequence` 模式逐帧 PNG。
#[tauri::command]
pub async fn export_animation_zip(
    history_id: i64,
    mode: String,
    dest: String,
) -> Result<serde_json::Value, String> {
    if mode != "gif" && mode != "png-sequence" {
        return Err(format!("未知的导出模式: {mode}"));
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let (_, bytes) = load_source(history_id)?;
        let info = animation::probe(&bytes)?;
        let dest = super::files::prepare_dest(&dest)?;
        let file = std::fs::File::create(&dest).map_err(|e| format!("创建压缩包失败: {e}"))?;
        let mut zip = zip::ZipWriter::new(file);
        let mut files = Vec::new();
        if mode == "gif" {
            write_zip_entry(&mut zip, "animation.gif", &bytes, true)?;
            files.push("animation.gif".to_string());
            let cover = animation::first_frame_png(&bytes)?;
            write_zip_entry(&mut zip, "preview.png", &cover, false)?;
            files.push("preview.png".to_string());
        } else {
            let frames = animation::decode_frames(&bytes, 0)?;
            for (index, frame) in frames.iter().enumerate() {
                let name = format!("frame_{:03}.png", index + 1);
                write_zip_entry(&mut zip, &name, &png_bytes(frame)?, false)?;
                files.push(name);
            }
        }
        let meta = serde_json::json!({
            "width": info.width,
            "height": info.height,
            "frames": info.frames,
            "loopCount": info.loop_count,
            "playOnce": info.play_once,
            "totalMs": info.total_ms,
            "durationsMs": info.durations_ms,
            "bytes": info.bytes,
        });
        let meta_bytes =
            serde_json::to_vec_pretty(&meta).map_err(|e| format!("生成动图清单失败: {e}"))?;
        write_zip_entry(&mut zip, "meta.json", &meta_bytes, false)?;
        files.push("meta.json".to_string());
        zip.finish().map_err(|e| format!("完成压缩包失败: {e}"))?;
        Ok(serde_json::json!({
            "files": files,
            "path": dest.to_string_lossy(),
            "animation": info,
        }))
    })
    .await
    .map_err(|e| format!("导出动图失败: {e}"))?
}

/// 本地重编码：按 `order` 重排 / 删帧 / 复制帧，套用逐帧时长与循环开关。
/// 帧数据不出 Rust 侧，避免把十几张全尺寸 PNG 走一遍 IPC。
#[tauri::command]
pub async fn compose_animation(
    app: tauri::AppHandle,
    history_id: i64,
    order: Vec<u32>,
    delays_ms: Vec<u32>,
    loop_play: bool,
) -> Result<serde_json::Value, String> {
    if order.is_empty() {
        return Err("至少保留一帧".into());
    }
    if order.len() != delays_ms.len() {
        return Err("帧顺序与帧时长数量不一致".into());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let (row, bytes) = load_source(history_id)?;
        let info = animation::probe(&bytes)?;
        if order
            .iter()
            .any(|index| *index as usize >= info.frames as usize)
        {
            return Err(format!("帧序号超出范围（共 {} 帧）", info.frames));
        }
        let frames = animation::decode_frames(&bytes, 0)?;
        let picked: Vec<image::RgbaImage> = order
            .iter()
            .map(|index| frames[*index as usize].clone())
            .collect();
        let delays: Vec<u32> = delays_ms
            .iter()
            .map(|ms| ((*ms).clamp(20, 2000) + 5) / 10 * 10)
            .collect();
        let repeat = if loop_play {
            gif::Repeat::Infinite
        } else {
            // Finite(0) 不写 Netscape 扩展：浏览器只播一次
            gif::Repeat::Finite(0)
        };
        let out = animation::encode(&picked, &delays, repeat)?;
        let out_info = animation::probe(&out)?;
        let (id, path, data_url) = save_derived(&app, &row, "anim-edit", &out, &out_info)?;
        Ok(serde_json::json!({
            "historyId": id,
            "dataUrl": data_url,
            "filePath": path,
            "animation": out_info,
        }))
    })
    .await
    .map_err(|e| format!("保存动图失败: {e}"))?
}

/// 转静图：把首帧另存为 PNG，供 GIF 节点上被置灰的静图编辑入口使用。
#[tauri::command]
pub async fn convert_animation_to_static(
    app: tauri::AppHandle,
    history_id: i64,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let (row, bytes) = load_source(history_id)?;
        let info = animation::probe(&bytes)?;
        let png = animation::first_frame_png(&bytes)?;
        let (id, path, data_url) =
            save_derived_bytes(&app, &row, "anim-static", &png, info.width, info.height)?;
        Ok(serde_json::json!({
            "historyId": id,
            "dataUrl": data_url,
            "filePath": path,
            "width": info.width,
            "height": info.height,
        }))
    })
    .await
    .map_err(|e| format!("转换静态图失败: {e}"))?
}

/// 表情包导出：方形化 + 重设帧数与帧时长 + 无限循环，GIF 落成新记录，封面单独返回。
#[tauri::command]
pub async fn export_sticker(
    app: tauri::AppHandle,
    history_id: i64,
    preset: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let preset = animation::sticker_preset(&preset)?;
        let (row, bytes) = load_source(history_id)?;
        let out = animation::render_sticker(&bytes, preset)?;
        let info = animation::probe(&out)?;
        let cover = animation::first_frame_png(&out)?;
        let cover_url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&cover)
        );
        let (id, path, data_url) = save_derived(&app, &row, "anim-sticker", &out, &info)?;
        Ok(serde_json::json!({
            "historyId": id,
            "dataUrl": data_url,
            "filePath": path,
            "coverDataUrl": cover_url,
            "preset": preset.name,
            "maxBytes": preset.max_bytes,
            "withinLimit": out.len() <= preset.max_bytes,
            "animation": info,
        }))
    })
    .await
    .map_err(|e| format!("导出表情包失败: {e}"))?
}
