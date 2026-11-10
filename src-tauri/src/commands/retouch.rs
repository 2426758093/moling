//! 修图命令：分析与应用。
//!
//! 全程本地运算，不联网、不计费、不经过 AttemptCtx；预览分支绝不落盘，
//! 只有提交分支才写图 + 缩略图 + 历史记录。

use crate::image_store;
use crate::retouch::{self, analysis, RetouchOp};
use crate::storage;
use base64::Engine;

/// 预览最长边的下限：再小就看不出磨皮 / 锐化差异
const PREVIEW_MIN_EDGE: u32 = 256;
/// 预览最长边的上限：前端画布放不下更大的预览，也没必要
const PREVIEW_MAX_EDGE: u32 = 2048;
/// 修图的像素上限（约 24MP）：超过这个量级本地运算与蒙版编辑都不再有意义
const MAX_RETOUCH_PIXELS: u64 = 24_000_000;

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetouchCommandInput {
    pub image_b64: String,
    #[serde(default)]
    pub parent_id: Option<i64>,
    pub ops: Vec<RetouchOp>,
    #[serde(default)]
    pub preview: Option<PreviewOptions>,
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewOptions {
    pub max_side: u32,
}

fn decode_input(image_b64: &str) -> Result<image::DynamicImage, String> {
    let raw = image_store::strip_data_url(image_b64);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&raw)
        .map_err(|e| format!("图片 base64 解码失败: {e}"))?;
    // 动图逐帧修图会丢掉其余帧，只能引导用户去动画面板
    if bytes.starts_with(b"GIF8") {
        return Err("动图暂不支持修图，请使用动画面板逐帧处理".to_string());
    }
    let img = crate::exif::decode_oriented(&bytes)?;
    ensure_retouch_budget(img.width(), img.height())?;
    Ok(img)
}

/// 修图台的像素预算：预览与提交共用，超限在解码后立刻拒绝。
/// 边界取开区间：正好 2400 万像素（如 6000×4000）也拒绝，超出就不再尝试。
fn ensure_retouch_budget(width: u32, height: u32) -> Result<(), String> {
    if u64::from(width) * u64::from(height) >= MAX_RETOUCH_PIXELS {
        return Err("图片超过 2400 万像素，修图台暂不支持，请先缩小后再试".to_string());
    }
    Ok(())
}

fn encode_png_data_url(img: &image::DynamicImage) -> Result<String, String> {
    let mut cursor = std::io::Cursor::new(Vec::new());
    img.write_to(&mut cursor, image::ImageFormat::Png)
        .map_err(|e| format!("图片编码失败: {e}"))?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(cursor.into_inner())
    ))
}

/// 预览先等比缩小再算：大图上跑磨皮/中值代价高，缩略图肉眼一致。
fn run_retouch(
    img: image::DynamicImage,
    ops: &[RetouchOp],
    preview_max_side: Option<u32>,
) -> Result<image::DynamicImage, String> {
    let mut img = img;
    if let Some(max_side) = preview_max_side {
        let max_side = max_side.clamp(PREVIEW_MIN_EDGE, PREVIEW_MAX_EDGE);
        let longest = img.width().max(img.height());
        if longest > max_side {
            // resize 保持长宽比「塞进」max_side×max_side，长边正好落在 max_side；
            // 自己算 scale 再 round 会让长边出现 255 这类偏差
            img = img.resize(max_side, max_side, image::imageops::FilterType::Triangle);
        }
    }
    retouch::apply_ops(img, ops, None)
}

#[tauri::command]
pub async fn retouch_analyze(
    image_b64: String,
) -> Result<crate::retouch::analysis::RetouchAnalysis, String> {
    let img = decode_input(&image_b64)?;
    Ok(analysis::analyze(&img))
}

#[tauri::command]
pub async fn apply_retouch(
    app: tauri::AppHandle,
    input: RetouchCommandInput,
) -> Result<serde_json::Value, String> {
    if input.ops.is_empty() {
        return Err("没有需要应用的修图操作".to_string());
    }
    let img = decode_input(&input.image_b64)?;
    let out = run_retouch(img, &input.ops, input.preview.map(|p| p.max_side))?;
    let (width, height) = (out.width(), out.height());
    let data_url = encode_png_data_url(&out)?;
    if input.preview.is_some() {
        return Ok(serde_json::json!({
            "dataUrl": data_url,
            "width": width,
            "height": height,
        }));
    }

    let parent = match input.parent_id {
        Some(pid) => storage::history_row(pid)?,
        None => None,
    };
    let now = storage::timestamp_millis();
    let name = image_store::unique_name("retouch_", &now, 0);
    let (path, saved_url) = image_store::save_b64_image(&app, &data_url, &name)?;
    crate::commands::image::ensure_thumb_async(path.clone()).await;
    let op = retouch::history_op(&input.ops);
    let row = local_history_row(
        parent.as_ref(),
        input.parent_id,
        width,
        height,
        path.clone(),
        op,
        now,
    );
    let id = storage::add_history(&row)?;
    Ok(serde_json::json!({
        "historyId": id,
        "dataUrl": saved_url,
        "filePath": path,
        "width": width,
        "height": height,
        "op": op,
        "parentId": input.parent_id,
    }))
}

/// 本地产物行的元数据：模型 / 风格留空、服务商写「本地修图」。
/// 借用父行的模型或服务商会让「按模型 / 风格筛选」混进这些本地行。
/// `prompt` 仍沿用父级（历史列表要靠它展示）；`negative_prompt` 同父级。
fn local_history_row(
    parent: Option<&storage::HistoryRow>,
    parent_id: Option<i64>,
    width: u32,
    height: u32,
    file_path: String,
    op: &str,
    created_at: String,
) -> storage::HistoryRow {
    storage::HistoryRow {
        id: 0,
        prompt: parent
            .map(|p| p.prompt.clone())
            .filter(|p| !p.trim().is_empty())
            .unwrap_or_else(|| "AI 修图".to_string()),
        negative_prompt: parent
            .map(|p| p.negative_prompt.clone())
            .unwrap_or_default(),
        model: String::new(),
        provider_name: "本地修图".to_string(),
        seed: None,
        width: width as i64,
        height: height as i64,
        guidance: 0.0,
        steps: 0,
        style: String::new(),
        file_path,
        favorite: false,
        created_at,
        parent_id,
        op: op.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::RgbImage;

    fn sample(w: u32, h: u32) -> image::DynamicImage {
        let mut img = RgbImage::new(w, h);
        for (x, y, px) in img.enumerate_pixels_mut() {
            *px = image::Rgb([(x % 200) as u8, (y % 200) as u8, 120]);
        }
        image::DynamicImage::ImageRgb8(img)
    }

    #[test]
    fn preview_scales_long_side() {
        let ops = [RetouchOp::AutoEnhance { strength: 0.5 }];
        let out = run_retouch(sample(400, 200), &ops, Some(256)).expect("预览应成功");
        assert_eq!(out.width().max(out.height()), 256);
        assert_eq!((out.width(), out.height()), (256, 128));
    }

    /// 非整数长宽比（1000×333）：长边必须正好是 max_side，
    /// 不能因为自己 round 短边而让长边落到 255。
    #[test]
    fn preview_long_side_is_exact_on_odd_aspect() {
        let ops = [RetouchOp::ToneCurve {
            contrast: 0.1,
            brightness: 0.0,
            saturation: 0.0,
        }];
        let out = run_retouch(sample(1000, 333), &ops, Some(256)).expect("预览应成功");
        assert_eq!(
            out.width().max(out.height()),
            256,
            "长边必须正好是 max_side: {}x{}",
            out.width(),
            out.height()
        );
        assert!(
            (84..=86).contains(&out.height()),
            "短边应按比例缩放: {}",
            out.height()
        );
    }

    #[test]
    fn preview_clamps_max_side() {
        // 低于 256 的请求按 256 处理，高于 2048 的按 2048 处理
        let ops = [RetouchOp::ToneCurve {
            contrast: 0.2,
            brightness: 0.0,
            saturation: 0.0,
        }];
        let small = run_retouch(sample(2000, 1000), &ops, Some(64)).expect("预览应成功");
        assert_eq!(small.width().max(small.height()), 256);
        let big = run_retouch(sample(4000, 2000), &ops, Some(9000)).expect("预览应成功");
        assert_eq!(big.width().max(big.height()), 2048);
    }

    #[test]
    fn full_run_keeps_dimensions() {
        let ops = [RetouchOp::SkinSmooth { amount: 0.6 }];
        let out = run_retouch(sample(120, 90), &ops, None).expect("全量应成功");
        assert_eq!((out.width(), out.height()), (120, 90));
    }

    /// 24MP 是硬上限：2400 万整通过，多一个像素就该拒绝
    #[test]
    fn retouch_pixel_budget_boundary() {
        assert!(ensure_retouch_budget(6000, 4000).is_err());
        assert!(ensure_retouch_budget(6000, 3999).is_ok());
        assert!(ensure_retouch_budget(1, 1).is_ok());
        let err = ensure_retouch_budget(9000, 9000).expect_err("超限必须报错");
        assert!(err.contains("2400 万像素"), "{err}");
    }

    fn parent_row() -> storage::HistoryRow {
        storage::HistoryRow {
            id: 42,
            prompt: "海边的猫".to_string(),
            negative_prompt: "blurry".to_string(),
            model: "gpt-image-1".to_string(),
            provider_name: "OpenAI".to_string(),
            seed: Some(7),
            width: 1024,
            height: 768,
            guidance: 7.5,
            steps: 30,
            style: "anime".to_string(),
            file_path: "C:/media/parent.png".to_string(),
            favorite: true,
            created_at: "0.000".to_string(),
            parent_id: None,
            op: "generate".to_string(),
        }
    }

    /// 本地产物行不能冒充父级的模型 / 服务商 / 风格
    #[test]
    fn local_row_does_not_inherit_model_provider_or_style() {
        let parent = parent_row();
        let row = local_history_row(
            Some(&parent),
            Some(parent.id),
            640,
            480,
            "C:/media/local.png".to_string(),
            "beauty",
            "1.000".to_string(),
        );
        assert_eq!(row.model, "");
        assert_eq!(row.provider_name, "本地修图");
        assert_eq!(row.style, "");
        // 展示需要的字段仍沿用父级
        assert_eq!(row.prompt, "海边的猫");
        assert_eq!(row.negative_prompt, "blurry");
        assert_eq!(row.parent_id, Some(42));
        assert_eq!((row.width, row.height), (640, 480));
        assert_eq!((row.seed, row.steps), (None, 0));
        assert_eq!(row.guidance, 0.0);
        assert_eq!(row.op, "beauty");
        assert!(!row.favorite);
    }

    /// 没有父行（直接拖入图片）时给兜底提示词，仍然不写模型
    #[test]
    fn local_row_without_parent_uses_fallback_prompt() {
        let row = local_history_row(
            None,
            None,
            10,
            10,
            "C:/media/new.png".to_string(),
            "auto-enhance",
            "1.000".to_string(),
        );
        assert_eq!(row.prompt, "AI 修图");
        assert_eq!(row.negative_prompt, "");
        assert_eq!(row.model, "");
        assert_eq!(row.provider_name, "本地修图");
        assert_eq!(row.style, "");
        assert_eq!(row.parent_id, None);
    }
}
