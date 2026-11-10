use crate::compositor::{self, LayerInput};
use crate::image_store;
use crate::storage;
use base64::Engine;
use image::RgbaImage;
use serde::Deserialize;
use std::path::PathBuf;

/// 单节点图层上限与画布上限保持一致（24 层）
const MAX_COMPOSE_LAYERS: usize = 24;
const MAX_FEATHER: u32 = 128;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeLayerInput {
    #[serde(default)]
    pub history_id: Option<i64>,
    /// 蒙版层 / 外部资产路径（必须是媒体根内的文件）
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default = "default_visible")]
    pub visible: bool,
    #[serde(default = "default_opacity")]
    pub opacity: f64,
    /// alpha-hole 蒙版路径
    #[serde(default)]
    pub mask_path: Option<String>,
    #[serde(default)]
    pub feather: Option<u32>,
}

fn default_visible() -> bool {
    true
}

fn default_opacity() -> f64 {
    1.0
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeNodeInput {
    pub base_history_id: i64,
    pub layers: Vec<ComposeLayerInput>,
    /// 预览用最长边；缺省按原尺寸输出
    #[serde(default)]
    pub max_edge: Option<u32>,
}

/// 分区蒙版 / 图层资产落盘：只接受 PNG（必须保留透明通道）。
///
/// 资产不进 history（不是作品），但会写进画布 JSON，由 GC 引用集合保护。
#[tauri::command]
pub fn save_canvas_layer_asset(
    app: tauri::AppHandle,
    data_url: String,
) -> Result<serde_json::Value, String> {
    let payload = image_store::strip_data_url(&data_url);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&payload)
        .map_err(|e| format!("蒙版 base64 解码失败: {e}"))?;
    if image_store::sniff_image_mime(&bytes).0 != "png" {
        return Err("蒙版必须是 PNG（保留透明通道）".into());
    }
    let name = image_store::unique_name("layer_", &storage::timestamp_millis(), 0);
    let (path, _) = image_store::save_b64_image(&app, &data_url, &name)
        .map_err(|e| format!("蒙版落盘失败: {e}"))?;
    Ok(serde_json::json!({ "path": path }))
}

/// 读取媒体根内的图片资产为 data URL。
/// 路径来自画布 JSON，必须 canonicalize 后确认仍在媒体根内，否则就是任意文件读取。
#[tauri::command]
pub fn read_media_image(app: tauri::AppHandle, path: String) -> Result<serde_json::Value, String> {
    let target = resolve_media_path(&app, &path)?;
    let ext = target
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg"
    ) {
        return Err("只能读取图片资产".into());
    }
    let data_url = image_store::path_to_data_url(&target.to_string_lossy())
        .ok_or_else(|| format!("图片读取失败: {}", target.display()))?;
    Ok(serde_json::json!({ "dataUrl": data_url }))
}

/// 按图层栈合成节点预览（可选降采样），只回传 data URL，不落库。
#[tauri::command]
pub fn compose_canvas_node(
    app: tauri::AppHandle,
    input: ComposeNodeInput,
) -> Result<serde_json::Value, String> {
    let base = load_history_image(&app, input.base_history_id)?;
    let layers = build_layers(&app, input.base_history_id, &input.layers)?;
    let mut out = compositor::compose(&base, &layers);
    if let Some(max_edge) = input.max_edge {
        out = downscale(out, max_edge.max(16));
    }
    let (width, height) = out.dimensions();
    Ok(serde_json::json!({
        "dataUrl": encode_png_data_url(&out)?,
        "width": width,
        "height": height,
    }))
}

/// 合并图层：全尺寸合成入库为 `op="flatten"` 的派生图，节点基准图随之切换。
#[tauri::command]
pub async fn flatten_canvas_node(
    app: tauri::AppHandle,
    input: ComposeNodeInput,
) -> Result<serde_json::Value, String> {
    let parent = storage::history_row(input.base_history_id)
        .map_err(|e| format!("读取源作品失败: {e}"))?
        .ok_or_else(|| "源作品不存在".to_string())?;
    let base = load_history_image(&app, input.base_history_id)?;
    let layers = build_layers(&app, input.base_history_id, &input.layers)?;
    let out = compositor::compose(&base, &layers);
    let (width, height) = out.dimensions();

    let now = storage::timestamp_millis();
    let name = image_store::unique_name("flat_", &now, 0);
    let png = encode_png_data_url(&out)?;
    let (path, data_url) = image_store::save_b64_image(&app, &png, &name)
        .map_err(|e| format!("合成图落盘失败: {e}"))?;
    let thumb_path = path.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        image_store::ensure_thumb(std::path::Path::new(&thumb_path));
    })
    .await;

    let prompt = if parent.prompt.trim().is_empty() {
        "图层合成".to_string()
    } else {
        parent.prompt.clone()
    };
    let id = storage::add_history(&storage::HistoryRow {
        id: 0,
        prompt,
        negative_prompt: parent.negative_prompt.clone(),
        model: parent.model.clone(),
        provider_name: "本地合成".to_string(),
        seed: None,
        width: width as i64,
        height: height as i64,
        guidance: 0.0,
        steps: 0,
        style: parent.style.clone(),
        file_path: path.clone(),
        favorite: false,
        created_at: now,
        parent_id: Some(input.base_history_id),
        op: "flatten".to_string(),
    })
    .map_err(|e| format!("写入历史失败: {e}"))?;

    Ok(serde_json::json!({
        "historyId": id,
        "dataUrl": data_url,
        "filePath": path,
        "width": width,
        "height": height,
        "op": "flatten",
        "parentId": input.base_history_id,
    }))
}

fn load_history_image(app: &tauri::AppHandle, id: i64) -> Result<RgbaImage, String> {
    let _ = app;
    let row = storage::history_row(id)
        .map_err(|e| format!("读取历史失败: {e}"))?
        .ok_or_else(|| format!("作品 #{id} 不存在"))?;
    decode_file(&row.file_path)
}

fn load_media_image(app: &tauri::AppHandle, path: &str) -> Result<RgbaImage, String> {
    let target = resolve_media_path(app, path)?;
    decode_file(&target.to_string_lossy())
}

fn decode_file(path: &str) -> Result<RgbaImage, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读取图片失败: {e}"))?;
    Ok(image_store::decode_limited(&bytes)?.to_rgba8())
}

/// 媒体根约束：先分别 canonicalize，再按目录边界比较
fn resolve_media_path(app: &tauri::AppHandle, path: &str) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(crate::paths::media_root(app).map_err(|e| e.to_string())?)
        .map_err(|e| format!("媒体目录不可用: {e}"))?;
    let target = std::fs::canonicalize(path).map_err(|e| format!("图层文件不存在: {e}"))?;
    if !target.starts_with(&root) {
        return Err("图层文件不在媒体目录内".into());
    }
    Ok(target)
}

fn build_layers(
    app: &tauri::AppHandle,
    base_history_id: i64,
    layers: &[ComposeLayerInput],
) -> Result<Vec<LayerInput>, String> {
    if layers.len() > MAX_COMPOSE_LAYERS {
        return Err(format!("单个节点最多 {MAX_COMPOSE_LAYERS} 层"));
    }
    let mut out = Vec::new();
    for layer in layers {
        if !layer.visible || layer.opacity <= 0.0 {
            continue;
        }
        // 基准层已在 base 缓冲里，无蒙版时跳过整层
        if layer.history_id == Some(base_history_id) && layer.mask_path.is_none() {
            continue;
        }
        let image = match layer.history_id {
            Some(id) => load_history_image(app, id)?,
            None => match layer.path.as_deref() {
                Some(p) if !p.trim().is_empty() => load_media_image(app, p)?,
                _ => continue,
            },
        };
        let mask = match layer.mask_path.as_deref() {
            Some(p) if !p.trim().is_empty() => {
                let mask_img = load_media_image(app, p)?;
                Some(compositor::mask_from_alpha(&mask_img))
            }
            _ => None,
        };
        out.push(LayerInput {
            image,
            mask,
            feather: layer.feather.unwrap_or(0).min(MAX_FEATHER),
            opacity: layer.opacity.clamp(0.0, 1.0) as f32,
        });
    }
    Ok(out)
}

fn downscale(img: RgbaImage, max_edge: u32) -> RgbaImage {
    let (w, h) = img.dimensions();
    if w.max(h) <= max_edge {
        return img;
    }
    let scale = max_edge as f32 / w.max(h) as f32;
    let nw = ((w as f32 * scale).round() as u32).max(1);
    let nh = ((h as f32 * scale).round() as u32).max(1);
    image::imageops::resize(&img, nw, nh, image::imageops::FilterType::Lanczos3)
}

fn encode_png_data_url(img: &RgbaImage) -> Result<String, String> {
    use image::ImageFormat;
    let mut cursor = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(img.clone())
        .write_to(&mut cursor, ImageFormat::Png)
        .map_err(|e| format!("合成图编码失败: {e}"))?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(cursor.into_inner())
    ))
}

/// 单批分区上限：每个区域都是一次独立计费调用，再多就该分批确认。
const MAX_REGION_BATCH: usize = 4;
const MAX_REGION_FEATHER: u32 = 128;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionBatchItem {
    pub id: String,
    pub prompt: String,
    /// alpha-hole PNG（透明 = 要重绘的区域）
    pub mask_b64: String,
    #[serde(default)]
    pub feather: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionEditInput {
    pub provider_id: i64,
    pub model: String,
    #[serde(default)]
    pub negative_prompt: Option<String>,
    pub base_history_id: i64,
    /// 当前合成图（节点基准 + 已有图层），前端已取全尺寸 data URL
    pub base_b64: String,
    #[serde(default)]
    pub job_id: Option<String>,
    pub regions: Vec<RegionBatchItem>,
}

/// 错误 JSON 的外层键（AdapterError 的枚举名），用于识别必须立即停止的批次
fn region_error_code(err: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(err).ok()?;
    value.as_object()?.keys().next().cloned()
}

/// 分区重绘：逐区调用服务商编辑接口（全尺寸 alpha-hole 蒙版），
/// 每区成功立即落库并本地羽化合成，最后写一张 `op="region-edit"` 合成图。
///
/// 计费语义与单次编辑一致：每区独立请求流水与 param_hash，不自动重试；
/// 部分失败返回逐区状态，全失败才整体报错。
#[tauri::command]
pub async fn region_edit_batch(
    app: tauri::AppHandle,
    state: tauri::State<'_, super::image::GenerationRegistry>,
    input: RegionEditInput,
) -> Result<serde_json::Value, String> {
    use super::image::{
        billed_save_error, decoded_size, edit_fingerprint, ensure_thumb_async, is_cancelled,
        run_edit, CancelRegistration, EditJournal,
    };
    use crate::adapters::EditRequest;
    use crate::billing_journal;
    use tauri::Emitter;

    if input.regions.is_empty() {
        return Err("请至少添加一个区域".into());
    }
    if input.regions.len() > MAX_REGION_BATCH {
        return Err(format!("一批最多 {MAX_REGION_BATCH} 个区域"));
    }
    for region in &input.regions {
        if region.prompt.trim().is_empty() {
            return Err("区域提示词不能为空".into());
        }
    }
    let row = storage::get_provider(input.provider_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "服务商不存在".to_string())?;

    let base_raw = image_store::strip_data_url(&input.base_b64);
    let base_bytes = base64::engine::general_purpose::STANDARD
        .decode(&base_raw)
        .map_err(|e| format!("底图 base64 解码失败: {e}"))?;
    let base = image_store::decode_limited(&base_bytes)
        .map_err(|e| format!("底图解码失败: {e}"))?
        .to_rgba8();
    let (width, height) = base.dimensions();
    if width == 0 || height == 0 {
        return Err("底图尺寸无效".into());
    }

    let (_registration, cancel_token) = CancelRegistration::new(&state, input.job_id.as_ref());
    let now = storage::timestamp_millis();
    let group_id = format!("region-{now}");
    let total = input.regions.len();
    let mut composed = base;
    let mut results: Vec<serde_json::Value> = Vec::new();
    let mut any_ok = false;
    let mut cancelled = false;
    let mut first_error: Option<String> = None;

    for (index, region) in input.regions.iter().enumerate() {
        if is_cancelled(&cancel_token) {
            cancelled = true;
            break;
        }
        let mask_raw = image_store::strip_data_url(&region.mask_b64);
        let mask_bytes = match base64::engine::general_purpose::STANDARD.decode(&mask_raw) {
            Ok(v) => v,
            Err(e) => {
                results.push(serde_json::json!({
                    "id": region.id,
                    "ok": false,
                    "error": format!("蒙版 base64 解码失败: {e}"),
                }));
                continue;
            }
        };
        let mask_rgba = match image_store::decode_limited(&mask_bytes) {
            Ok(img) => img.to_rgba8(),
            Err(e) => {
                results.push(serde_json::json!({
                    "id": region.id,
                    "ok": false,
                    "error": format!("蒙版解码失败: {e}"),
                }));
                continue;
            }
        };
        let feather = region.feather.unwrap_or(0).min(MAX_REGION_FEATHER);

        let req = EditRequest {
            prompt: region.prompt.clone(),
            negative_prompt: input.negative_prompt.clone(),
            model: input.model.clone(),
            image_b64: base_raw.clone(),
            mask_b64: Some(mask_raw.clone()),
            width,
            height,
            // 内部位图提示：合成缓冲只接受栅格图，Mock 据此返回真实 PNG
            output_format: Some("png".into()),
            frame_count: None,
            frame_duration_ms: None,
            complexity: None,
        };
        let param_hash = edit_fingerprint(&[
            &input.provider_id.to_string(),
            &input.model,
            &region.prompt,
            input.negative_prompt.as_deref().unwrap_or(""),
            &base_raw,
            &mask_raw,
            &width.to_string(),
            &height.to_string(),
            "region",
        ]);

        match run_edit(
            input.provider_id,
            &req,
            &EditJournal {
                group_id: &group_id,
                entry: "edit",
                op: "region",
                param_hash: &param_hash,
                provider_name: &row.name,
                model: &input.model,
                prompt: &region.prompt,
            },
        )
        .await
        {
            Ok((ctx, b64)) => {
                let name = image_store::unique_name("region_", &now, index);
                let (path, data_url) =
                    match image_store::save_b64_image_with_retry(&app, &b64, &name) {
                        Ok(v) => v,
                        Err(e) => {
                            let err = billed_save_error(&ctx, &b64, e.to_string());
                            first_error.get_or_insert_with(|| err.clone());
                            results.push(serde_json::json!({
                                "id": region.id,
                                "ok": false,
                                "error": err,
                            }));
                            let _ = app.emit(
                                "image:region-progress",
                                serde_json::json!({
                                    "groupId": group_id,
                                    "index": index,
                                    "done": index + 1,
                                    "total": total,
                                    "regionId": region.id,
                                    "ok": false,
                                }),
                            );
                            continue;
                        }
                    };
                ensure_thumb_async(path.clone()).await;
                let (decoded_w, decoded_h) = decoded_size(&b64);
                let record_w = if decoded_w > 0 { decoded_w } else { width };
                let record_h = if decoded_h > 0 { decoded_h } else { height };
                let id = match storage::add_history(&storage::HistoryRow {
                    id: 0,
                    prompt: region.prompt.clone(),
                    negative_prompt: input.negative_prompt.clone().unwrap_or_default(),
                    model: input.model.clone(),
                    provider_name: row.name.clone(),
                    seed: None,
                    width: record_w as i64,
                    height: record_h as i64,
                    guidance: 0.0,
                    steps: 0,
                    style: String::new(),
                    file_path: path.clone(),
                    favorite: false,
                    created_at: now.clone(),
                    parent_id: Some(input.base_history_id),
                    op: "region".to_string(),
                }) {
                    Ok(id) => id,
                    Err(e) => {
                        let err = billed_save_error(&ctx, &b64, e.to_string());
                        first_error.get_or_insert_with(|| err.clone());
                        results.push(serde_json::json!({
                            "id": region.id,
                            "ok": false,
                            "error": err,
                        }));
                        continue;
                    }
                };
                ctx.finish(
                    billing_journal::STATE_SUCCEEDED,
                    None,
                    std::slice::from_ref(&path),
                );
                ctx.discard_raw();

                // 本地羽化合成：蒙版外保持原像素，结果图尺寸不一致时 Lanczos3 缩放
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD
                    .decode(image_store::strip_data_url(&b64))
                {
                    if let Ok(img) = image_store::decode_limited(&bytes) {
                        composed = compositor::compose(
                            &composed,
                            &[LayerInput {
                                image: img.to_rgba8(),
                                mask: Some(compositor::mask_from_alpha(&mask_rgba)),
                                feather,
                                opacity: 1.0,
                            }],
                        );
                    }
                }
                any_ok = true;
                results.push(serde_json::json!({
                    "id": region.id,
                    "ok": true,
                    "historyId": id,
                    "dataUrl": data_url,
                    "filePath": path,
                }));
                let _ = app.emit(
                    "image:region-progress",
                    serde_json::json!({
                        "groupId": group_id,
                        "index": index,
                        "done": index + 1,
                        "total": total,
                        "regionId": region.id,
                        "ok": true,
                        "historyId": id,
                    }),
                );
            }
            Err(e) => {
                let stop = matches!(
                    region_error_code(&e).as_deref(),
                    Some("QuotaExceeded") | Some("AuthInvalid")
                );
                first_error.get_or_insert_with(|| e.clone());
                results.push(serde_json::json!({
                    "id": region.id,
                    "ok": false,
                    "error": e,
                }));
                let _ = app.emit(
                    "image:region-progress",
                    serde_json::json!({
                        "groupId": group_id,
                        "index": index,
                        "done": index + 1,
                        "total": total,
                        "regionId": region.id,
                        "ok": false,
                    }),
                );
                if stop {
                    break;
                }
            }
        }
    }

    if !any_ok && !cancelled {
        return Err(first_error.unwrap_or_else(|| "分区重绘失败".into()));
    }

    let mut composed_history_id: Option<i64> = None;
    let mut composed_data_url: Option<String> = None;
    if any_ok {
        let (cw, ch) = composed.dimensions();
        let png = encode_png_data_url(&composed)?;
        let cname = image_store::unique_name("region_edit_", &now, 0);
        let (cpath, curl) = image_store::save_b64_image_with_retry(&app, &png, &cname)
            .map_err(|e| format!("合成图落盘失败: {e}"))?;
        ensure_thumb_async(cpath.clone()).await;
        let cid = storage::add_history(&storage::HistoryRow {
            id: 0,
            prompt: "分区重绘".to_string(),
            negative_prompt: input.negative_prompt.clone().unwrap_or_default(),
            model: input.model.clone(),
            provider_name: row.name.clone(),
            seed: None,
            width: cw as i64,
            height: ch as i64,
            guidance: 0.0,
            steps: 0,
            style: String::new(),
            file_path: cpath,
            favorite: false,
            created_at: now,
            parent_id: Some(input.base_history_id),
            op: "region-edit".to_string(),
        })
        .map_err(|e| format!("合成图入库失败: {e}"))?;
        composed_history_id = Some(cid);
        composed_data_url = Some(curl);
    }

    Ok(serde_json::json!({
        "groupId": group_id,
        "results": results,
        "cancelled": cancelled,
        "anySucceeded": any_ok,
        "historyId": composed_history_id,
        "dataUrl": composed_data_url,
    }))
}
