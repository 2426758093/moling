//! 智能蒙版命令层：一键主体 / 点选分割。
//!
//! 推理放在 `spawn_blocking` 里，8 秒兜底超时；失败一律返回可读原因，
//! 前端据此把入口置灰或退回手动涂抹，不影响生成 / 编辑主链路。

use std::path::PathBuf;
use std::time::Duration;

use image::GrayImage;
use tauri::Manager;

use crate::segment;

/// 单次推理的兜底上限：u2netp 在 320px 上通常 <200ms，8s 只防异常卡死。
const SEGMENT_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentMaskResult {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
    /// 蒙版覆盖比例（0–1），前端可提示「主体不明显」
    pub covered: f32,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentModelStatus {
    pub available: bool,
    pub loaded: bool,
    pub reason: Option<String>,
}

/// 随包资源的候选目录：打包后取 resource_dir，dev 下退回源码目录。
fn asset_roots(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        roots.push(dir.clone());
        // 部分打包布局会把 resources/ 原样保留
        roots.push(dir.join("resources"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.to_path_buf());
            roots.push(dir.join("resources"));
        }
    }
    // debug 构建（tauri dev）没有资源拷贝步骤，直接用仓库里的副本
    roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"));
    roots
}

fn locate(app: &tauri::AppHandle) -> (Option<PathBuf>, Option<PathBuf>) {
    let roots = asset_roots(app);
    let dll = segment::find_first(
        &roots
            .iter()
            .map(|r| r.join("onnxruntime.dll"))
            .collect::<Vec<_>>(),
    );
    let model = segment::find_first(
        &roots
            .iter()
            .map(|r| r.join("models").join("u2netp.onnx"))
            .collect::<Vec<_>>(),
    );
    (dll, model)
}

/// 启动时只登记路径，不加载 ORT（冷启动不受影响）；缺文件仅落日志。
pub fn init_assets(app: &tauri::AppHandle) {
    let (dll, model) = locate(app);
    match (dll, model) {
        (Some(dll), Some(model)) => {
            segment::configure(dll, model);
        }
        (dll, model) => {
            tracing::warn!(
                "智能蒙版资源缺失（dll={:?}, model={:?}），入口将置灰",
                dll,
                model
            );
        }
    }
}

#[tauri::command]
pub fn segment_model_status() -> SegmentModelStatus {
    match segment::availability() {
        Ok(()) => SegmentModelStatus {
            available: true,
            loaded: segment::is_loaded(),
            reason: None,
        },
        Err(reason) => SegmentModelStatus {
            available: false,
            loaded: false,
            reason: Some(reason),
        },
    }
}

async fn run_blocking<F>(f: F) -> Result<GrayImage, String>
where
    F: FnOnce() -> Result<GrayImage, String> + Send + 'static,
{
    let handle = tauri::async_runtime::spawn_blocking(f);
    match tokio::time::timeout(SEGMENT_TIMEOUT, handle).await {
        Ok(joined) => joined.map_err(|e| format!("智能分割任务失败: {e}"))?,
        Err(_) => Err("智能分割超时，请改用手动涂抹".into()),
    }
}

fn positive_size(img: &image::DynamicImage) -> Result<(u32, u32), String> {
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return Err("图片尺寸异常".into());
    }
    Ok((w, h))
}

#[tauri::command]
pub async fn segment_subject(image_b64: String, invert: bool) -> Result<SegmentMaskResult, String> {
    segment::availability()?;
    let img = segment::decode_data_url(&image_b64)?;
    let (w, h) = positive_size(&img)?;
    let mask = run_blocking(move || {
        let rgb = img.to_rgb8();
        let probs = segment::infer(&rgb)?;
        let mask = segment::subject_mask(&probs, w, h)
            .ok_or_else(|| "未识别到明显主体，请改用手动涂抹".to_string())?;
        Ok(if invert { segment::invert(&mask) } else { mask })
    })
    .await?;
    Ok(finish(mask))
}

#[tauri::command]
pub async fn segment_at_point(
    image_b64: String,
    x: u32,
    y: u32,
) -> Result<SegmentMaskResult, String> {
    segment::availability()?;
    let img = segment::decode_data_url(&image_b64)?;
    let (w, h) = positive_size(&img)?;
    if x >= w || y >= h {
        return Err("点击位置超出图片范围".into());
    }
    let mask = run_blocking(move || {
        let rgb = img.to_rgb8();
        let probs = segment::infer(&rgb)?;
        segment::point_mask(&probs, x, y, w, h, segment::PICK_MISS_PX)?
            .ok_or_else(|| "附近没有可识别的物体，请改用手动涂抹".to_string())
    })
    .await?;
    Ok(finish(mask))
}

fn finish(mask: GrayImage) -> SegmentMaskResult {
    let covered = segment::covered_ratio(&mask);
    SegmentMaskResult {
        width: mask.width(),
        height: mask.height(),
        covered,
        // 编码失败在上层已保证不会发生（内存 PNG），兜底为空串让前端跳过
        data_url: segment::mask_to_png_data_url(&mask).unwrap_or_default(),
    }
}
