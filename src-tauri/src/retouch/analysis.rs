//! 修图分析：在缩略图上一趟算完曝光 / 白平衡 / 对比 / 饱和 / 锐度 / 肤色 / 剪切。
//!
//! 只用固定公式，不训练、不联网、不随机：同一张图永远得到同一份结果，
//! 前端据此显示的「建议」与后端实际应用的增强必须对得上。

use crate::retouch::{is_skin, luma};
use image::RgbaImage;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Suggestion {
    Exposure,
    WhiteBalance,
    Contrast,
    Saturation,
    Skin,
    Clipping,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetouchAnalysis {
    /// -2..=2，建议曝光补偿（>0 需要提亮）
    pub exposure_ev: f32,
    /// -1..=1，>0 偏暖（红多），建议降温
    pub wb_cast: f32,
    /// 亮度标准差 / 64，0..~2
    pub contrast: f32,
    /// 平均彩度 / 128，0..~2
    pub saturation: f32,
    /// Sobel 均值 / 32，0..~2
    pub sharpness: f32,
    /// 0..=1
    pub skin_ratio: f32,
    /// 0..=1，亮度 <=2 的占比
    pub clip_low: f32,
    /// 0..=1，亮度 >=253 的占比
    pub clip_high: f32,
    /// 0..=255，未 clamp，增强 LUT 需要
    pub mean_luma: f32,
    pub suggestions: Vec<Suggestion>,
}

/// 分析用的缩略图最长边：足够统计稳定，又能把 O(n) 遍历压到几万像素
const ANALYSIS_EDGE: u32 = 256;

/// 低于该 alpha 视为全透明背景：它的 RGB 没有意义（通常还是 0,0,0），
/// 计入统计会把曝光 / 剪切整体拉向「纯黑」。
const MIN_OPAQUE_ALPHA: u8 = 128;

fn luma_at(img: &RgbaImage, x: u32, y: u32) -> f32 {
    let p = img.get_pixel(x.min(img.width() - 1), y.min(img.height() - 1));
    luma(p[0] as f32, p[1] as f32, p[2] as f32)
}

/// 缩放目标尺寸：最长边不超过 ANALYSIS_EDGE，且不放大小图
fn thumb_size(w: u32, h: u32) -> (u32, u32) {
    let longest = w.max(h);
    if longest <= ANALYSIS_EDGE {
        return (w, h);
    }
    let scale = ANALYSIS_EDGE as f64 / longest as f64;
    (
        ((w as f64 * scale).round() as u32).clamp(1, w),
        ((h as f64 * scale).round() as u32).clamp(1, h),
    )
}

/// 空图兜底：统计口径需要至少一个像素
fn empty_analysis() -> RetouchAnalysis {
    RetouchAnalysis {
        exposure_ev: 0.0,
        wb_cast: 0.0,
        contrast: 0.0,
        saturation: 0.0,
        sharpness: 0.0,
        skin_ratio: 0.0,
        clip_low: 0.0,
        clip_high: 0.0,
        mean_luma: 0.0,
        suggestions: Vec::new(),
    }
}

/// 在最长边 <=256 的缩略图上一次遍历完成全部分析。
pub fn analyze(img: &image::DynamicImage) -> RetouchAnalysis {
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return empty_analysis();
    }
    let (tw, th) = thumb_size(w, h);
    // 先在原始像素格式上做面积平均缩小，再转 RGBA：
    // 直接 to_rgba8() 会为 12MP 原图白拿一份 48MB 的临时缓冲，而这里只用缩略图统计
    let thumb = image::imageops::thumbnail(img, tw, th);
    let (tw, th) = thumb.dimensions();
    if tw == 0 || th == 0 {
        return empty_analysis();
    }

    let (mut sum_r, mut sum_b) = (0f64, 0f64);
    let (mut sum_y, mut sum_y2, mut sum_chroma) = (0f64, 0f64, 0f64);
    let mut sobel_sum = 0f64;
    let mut sobel_count = 0u64;
    let (mut skin, mut clip_low, mut clip_high) = (0u64, 0u64, 0u64);
    let mut opaque = 0u64;

    for y in 0..th {
        for x in 0..tw {
            let px = thumb.get_pixel(x, y);
            // 透明背景不是「黑」：整像素跳过，分母只算不透明像素
            if px[3] < MIN_OPAQUE_ALPHA {
                continue;
            }
            opaque += 1;
            let (r, g, b) = (px[0] as f32, px[1] as f32, px[2] as f32);
            sum_r += f64::from(r);
            sum_b += f64::from(b);
            let yv = luma(r, g, b);
            sum_y += f64::from(yv);
            sum_y2 += f64::from(yv) * f64::from(yv);
            sum_chroma += f64::from(r.max(g).max(b) - r.min(g).min(b));
            if yv <= 2.0 {
                clip_low += 1;
            }
            if yv >= 253.0 {
                clip_high += 1;
            }
            // BT.601 色度：肤色集中在 Cb 77..127 / Cr 133..173
            if is_skin(r, g, b) {
                skin += 1;
            }
            // Sobel 需要 8 邻域，边界像素跳过
            if x > 0 && y > 0 && x + 1 < tw && y + 1 < th {
                let l = |dx: i64, dy: i64| {
                    luma_at(&thumb, (x as i64 + dx) as u32, (y as i64 + dy) as u32)
                };
                // 邻域里有透明像素时不算梯度：透明边缘会被误判成高频细节
                let mut touches_hole = false;
                for dy in -1i64..=1 {
                    for dx in -1i64..=1 {
                        let nx = (x as i64 + dx) as u32;
                        let ny = (y as i64 + dy) as u32;
                        if thumb.get_pixel(nx, ny)[3] < MIN_OPAQUE_ALPHA {
                            touches_hole = true;
                        }
                    }
                }
                if !touches_hole {
                    let gx =
                        -l(-1, -1) + l(1, -1) - 2.0 * l(-1, 0) + 2.0 * l(1, 0) - l(-1, 1) + l(1, 1);
                    let gy =
                        -l(-1, -1) - 2.0 * l(0, -1) - l(1, -1) + l(-1, 1) + 2.0 * l(0, 1) + l(1, 1);
                    sobel_sum += f64::from((gx * gx + gy * gy).sqrt());
                    sobel_count += 1;
                }
            }
        }
    }

    // 整张全透明：没有任何可统计的像素，交给空图兜底
    if opaque == 0 {
        return empty_analysis();
    }
    let total = opaque as f64;

    let mean_luma = (sum_y / total) as f32;
    let mean_r = sum_r / total;
    let mean_b = sum_b / total;
    let variance = (sum_y2 / total - (sum_y / total).powi(2)).max(0.0);
    // 均值先夹到 8..247：纯黑图 log2(128/0) 会直接变 inf
    let exposure_ev = (128.0f32 / mean_luma.clamp(8.0, 247.0))
        .log2()
        .clamp(-1.5, 1.5);
    let wb_cast = ((mean_r - mean_b) / (mean_r + mean_b).max(1.0)).clamp(-1.0, 1.0) as f32;
    let contrast = (variance.sqrt() / 64.0) as f32;
    let saturation = (sum_chroma / total / 128.0) as f32;
    let sharpness = if sobel_count > 0 {
        (sobel_sum / sobel_count as f64 / 32.0) as f32
    } else {
        0.0
    };
    let skin_ratio = (skin as f64 / total) as f32;
    let clip_low = (clip_low as f64 / total) as f32;
    let clip_high = (clip_high as f64 / total) as f32;

    let mut suggestions = Vec::new();
    if exposure_ev.abs() > 0.15 {
        suggestions.push(Suggestion::Exposure);
    }
    if wb_cast.abs() > 0.04 {
        suggestions.push(Suggestion::WhiteBalance);
    }
    if contrast < 0.35 {
        suggestions.push(Suggestion::Contrast);
    }
    if saturation < 0.25 {
        suggestions.push(Suggestion::Saturation);
    }
    if skin_ratio > 0.06 {
        suggestions.push(Suggestion::Skin);
    }
    if clip_low > 0.02 || clip_high > 0.02 {
        suggestions.push(Suggestion::Clipping);
    }

    RetouchAnalysis {
        exposure_ev,
        wb_cast,
        contrast,
        saturation,
        sharpness,
        skin_ratio,
        clip_low,
        clip_high,
        mean_luma,
        suggestions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, Rgb, RgbImage};

    fn solid(w: u32, h: u32, color: [u8; 3]) -> DynamicImage {
        DynamicImage::ImageRgb8(RgbImage::from_pixel(w, h, Rgb(color)))
    }

    #[test]
    fn neutral_gray_has_no_cast() {
        let a = analyze(&solid(32, 32, [128, 128, 128]));
        assert!(a.exposure_ev.abs() < 0.06, "灰 128 不应需要曝光补偿: {a:?}");
        assert!(a.wb_cast.abs() < 0.01, "灰 128 无偏色: {a:?}");
        assert!(a.saturation < 0.01, "灰 128 无彩度: {a:?}");
    }

    #[test]
    fn warm_patch_reports_warm_cast() {
        let a = analyze(&solid(32, 32, [180, 128, 100]));
        assert!(a.wb_cast > 0.05, "暖色块应判为偏暖: {a:?}");
    }

    #[test]
    fn dark_image_needs_positive_ev() {
        let a = analyze(&solid(32, 32, [40, 40, 40]));
        assert!(a.exposure_ev > 0.5, "暗图应建议提亮: {a:?}");
    }

    #[test]
    fn clipping_on_both_ends_is_flagged() {
        let mut img = RgbImage::new(64, 64);
        for (x, _y, px) in img.enumerate_pixels_mut() {
            // 左半死黑、右半死白
            *px = if x < 32 {
                Rgb([0, 0, 0])
            } else {
                Rgb([255, 255, 255])
            };
        }
        let a = analyze(&DynamicImage::ImageRgb8(img));
        assert!(
            a.clip_low > 0.3 && a.clip_high > 0.3,
            "两端应各自溢出: {a:?}"
        );
        assert!(
            a.suggestions.contains(&Suggestion::Clipping),
            "溢出必须给出提示: {a:?}"
        );
    }

    #[test]
    fn skin_patch_is_detected() {
        let a = analyze(&solid(32, 32, [200, 160, 140]));
        assert!(a.skin_ratio > 0.5, "肤色块应判为肤色: {a:?}");
    }

    /// 左半全透明、右半中灰：透明区域的 RGB 是 0（纯黑），
    /// 若计入统计会把曝光拉高、把 clip_low 拉出一堆假溢出。
    #[test]
    fn transparent_half_is_ignored() {
        let mut img = image::RgbaImage::new(64, 32);
        for (x, _y, px) in img.enumerate_pixels_mut() {
            *px = if x < 32 {
                image::Rgba([0, 0, 0, 0])
            } else {
                image::Rgba([128, 128, 128, 255])
            };
        }
        let rgba = analyze(&DynamicImage::ImageRgba8(img));
        let gray = analyze(&solid(32, 32, [128, 128, 128]));
        assert!(
            (rgba.exposure_ev - gray.exposure_ev).abs() < 0.02,
            "透明区不应拉高曝光: {:?} vs {:?}",
            rgba,
            gray
        );
        assert!(
            (rgba.mean_luma - gray.mean_luma).abs() < 1.0,
            "透明区不应拉低均值: {:?} vs {:?}",
            rgba,
            gray
        );
        assert!(rgba.clip_low < 0.01, "透明区不该算成死黑: {rgba:?}");
        assert!(
            (rgba.saturation - gray.saturation).abs() < 0.01,
            "透明区不应影响彩度: {:?} vs {:?}",
            rgba,
            gray
        );
        // 透明边缘不参与 Sobel：结果应与纯灰一致（都是 0），而不是把边缘算成锐度
        assert!(rgba.sharpness < 0.01, "透明边缘不该算锐度: {rgba:?}");
    }

    /// 全透明图没有可统计的像素，返回空分析而不是「纯黑」
    #[test]
    fn fully_transparent_returns_empty_analysis() {
        let img = image::RgbaImage::from_pixel(16, 16, image::Rgba([0, 0, 0, 0]));
        let a = analyze(&DynamicImage::ImageRgba8(img));
        assert_eq!(a, empty_analysis());
    }
}
