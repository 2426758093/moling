//! LUT 型调色：自动增强、白平衡、亮度/对比度/饱和度。
//!
//! 全部先用 256 项查找表把逐像素运算压成一次查表，再逐像素 O(1) 应用；
//! 输出只取决于输入像素与分析结果，同图两次调用逐字节一致。

use crate::retouch::analysis::RetouchAnalysis;
use crate::retouch::{clamp01, clamp_unit, luma, round_u8};
use image::{DynamicImage, RgbaImage};

/// 保亮度的饱和度缩放
fn with_saturation(c: [f32; 3], gain: f32) -> [f32; 3] {
    let l = luma(c[0], c[1], c[2]);
    [
        (l + (c[0] - l) * gain).clamp(0.0, 255.0),
        (l + (c[1] - l) * gain).clamp(0.0, 255.0),
        (l + (c[2] - l) * gain).clamp(0.0, 255.0),
    ]
}

/// 按通道增益建表并应用；alpha 原样
fn apply_gain(img: DynamicImage, gains: [f32; 3]) -> DynamicImage {
    if gains.iter().all(|g| (*g - 1.0).abs() < f32::EPSILON) {
        return img;
    }
    let mut tables = [[0u8; 256]; 3];
    for (c, table) in tables.iter_mut().enumerate() {
        for (v, slot) in table.iter_mut().enumerate() {
            *slot = round_u8(v as f32 * gains[c]);
        }
    }
    let mut rgba = img.to_rgba8();
    for px in rgba.pixels_mut() {
        px[0] = tables[0][px[0] as usize];
        px[1] = tables[1][px[1] as usize];
        px[2] = tables[2][px[2] as usize];
    }
    DynamicImage::ImageRgba8(rgba)
}

/// 一次遍历、256 项 LUT、确定性。strength=0 必须逐字节等于输入。
pub fn auto_enhance(img: DynamicImage, a: &RetouchAnalysis, strength: f32) -> DynamicImage {
    let strength = clamp01(strength);
    if strength <= 0.0 {
        return img;
    }
    let mean = (a.mean_luma / 255.0).clamp(0.02, 0.98);
    // 用「均值推到中灰」求 gamma；EV 与 gamma 同向，不能再乘回去抵消
    let gamma = (0.5f32.ln() / mean.ln()) / (1.0 + a.exposure_ev * 0.35);
    let gamma = gamma.clamp(0.4, 2.2);
    // 曝光明显偏离中灰时先修曝光，不再用 S 曲线压暗阴影
    let post_mean = mean.powf(gamma);
    let k = (((0.30 - a.contrast) * 2.0).clamp(0.0, 0.6)
        * (1.0 - (post_mean - 0.5).abs() * 2.0).clamp(0.0, 1.0))
    .clamp(0.0, 0.6);
    let gains = [
        (1.0 - 0.10 * a.wb_cast).clamp(0.88, 1.12),
        1.0,
        (1.0 + 0.10 * a.wb_cast).clamp(0.88, 1.12),
    ];
    let sat_gain = 1.0 + (0.30 - a.saturation).clamp(0.0, 0.3) * 0.6;

    let mut tables = [[0u8; 256]; 3];
    for (c, table) in tables.iter_mut().enumerate() {
        for (v, slot) in table.iter_mut().enumerate() {
            let mut x = (v as f32 / 255.0).powf(gamma);
            let s = x * x * (3.0 - 2.0 * x);
            x += (s - x) * k;
            *slot = round_u8(x * gains[c] * 255.0);
        }
    }

    let mut rgba = img.to_rgba8();
    for px in rgba.pixels_mut() {
        let orig = [px[0], px[1], px[2]];
        let lut = [
            tables[0][orig[0] as usize] as f32,
            tables[1][orig[1] as usize] as f32,
            tables[2][orig[2] as usize] as f32,
        ];
        let enhanced = with_saturation(lut, sat_gain);
        for (c, e) in enhanced.iter().enumerate() {
            // 强度混合：strength=1 全用增强结果，=0 原像素（已提前返回）
            px[c] = round_u8(orig[c] as f32 + (e - orig[c] as f32) * strength);
        }
    }
    DynamicImage::ImageRgba8(rgba)
}

/// temp>0 加暖（增红减蓝），tint>0 加洋红（减绿）。±1 对应通道增益 ±12%。
pub fn white_balance(img: DynamicImage, temp: f32, tint: f32) -> DynamicImage {
    let temp = clamp_unit(temp);
    let tint = clamp_unit(tint);
    let gains = [
        (1.0 + temp * 0.12).clamp(0.88, 1.12),
        (1.0 - tint * 0.12).clamp(0.88, 1.12),
        (1.0 - temp * 0.12).clamp(0.88, 1.12),
    ];
    apply_gain(img, gains)
}

/// 亮度/对比度/饱和度，-1..=1；用 LUT + 保亮度饱和度计算。
pub fn tone_curve(
    img: DynamicImage,
    contrast: f32,
    brightness: f32,
    saturation: f32,
) -> DynamicImage {
    let contrast = clamp_unit(contrast);
    let brightness = clamp_unit(brightness);
    let saturation = clamp_unit(saturation);
    if contrast == 0.0 && brightness == 0.0 && saturation == 0.0 {
        return img;
    }
    let mut table = [0u8; 256];
    for (v, slot) in table.iter_mut().enumerate() {
        let mut x = v as f32 / 255.0 + brightness * 0.25;
        x = (x.clamp(0.0, 1.0) - 0.5) * (1.0 + contrast) + 0.5;
        *slot = round_u8(x * 255.0);
    }
    let gain = 1.0 + saturation;
    let mut rgba: RgbaImage = img.to_rgba8();
    for px in rgba.pixels_mut() {
        let c = [
            table[px[0] as usize] as f32,
            table[px[1] as usize] as f32,
            table[px[2] as usize] as f32,
        ];
        let out = with_saturation(c, gain);
        px[0] = round_u8(out[0]);
        px[1] = round_u8(out[1]);
        px[2] = round_u8(out[2]);
    }
    DynamicImage::ImageRgba8(rgba)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::retouch::analysis;
    use image::{DynamicImage, Rgb, RgbImage};

    fn solid(w: u32, h: u32, c: [u8; 3]) -> DynamicImage {
        DynamicImage::ImageRgb8(RgbImage::from_pixel(w, h, Rgb(c)))
    }

    fn mean_luma(img: &DynamicImage) -> f32 {
        let rgba = img.to_rgba8();
        let n = (rgba.width() * rgba.height()) as f32;
        rgba.pixels()
            .map(|p| luma(p[0] as f32, p[1] as f32, p[2] as f32))
            .sum::<f32>()
            / n
    }

    #[test]
    fn auto_enhance_is_deterministic() {
        let img = solid(9, 7, [90, 120, 150]);
        let a = analysis::analyze(&img);
        let once = auto_enhance(img.clone(), &a, 0.8).to_rgba8().into_raw();
        let twice = auto_enhance(img, &a, 0.8).to_rgba8().into_raw();
        assert_eq!(once, twice, "同输入两次调用必须逐字节一致");
    }

    #[test]
    fn auto_enhance_zero_strength_is_identity() {
        let img = solid(5, 5, [37, 88, 201]);
        let before = img.to_rgba8().into_raw();
        let a = analysis::analyze(&img);
        let out = auto_enhance(img, &a, 0.0);
        assert_eq!(out.to_rgba8().into_raw(), before);
    }

    #[test]
    fn single_pixel_images_do_not_panic() {
        let img = solid(1, 1, [12, 200, 64]);
        let a = analysis::analyze(&img);
        let _ = auto_enhance(img.clone(), &a, 1.0);
        let _ = white_balance(img.clone(), 1.0, -1.0);
        let _ = tone_curve(img, 1.0, -1.0, 1.0);
    }

    #[test]
    fn white_balance_identity_at_zero() {
        let img = solid(4, 4, [11, 143, 250]);
        let before = img.to_rgba8().into_raw();
        let out = white_balance(img, 0.0, 0.0);
        assert_eq!(out.to_rgba8().into_raw(), before);
    }

    #[test]
    fn white_balance_warms_and_cools() {
        let img = solid(4, 4, [100, 100, 100]);
        let warm = white_balance(img.clone(), 1.0, 0.0).to_rgba8();
        assert!(warm.get_pixel(0, 0)[0] > 100 && warm.get_pixel(0, 0)[2] < 100);
        let cool = white_balance(img, -1.0, 0.0).to_rgba8();
        assert!(cool.get_pixel(0, 0)[0] < 100 && cool.get_pixel(0, 0)[2] > 100);
    }

    /// 纯色暗图（无任何层次）也必须被提亮：这是 auto_enhance 的主诉，
    /// 不能靠「暗但有层次」的棋盘格绕过去。
    #[test]
    fn auto_enhance_brightens_flat_dark_image() {
        let img = solid(64, 64, [40, 40, 40]);
        let a = analysis::analyze(&img);
        assert!(a.exposure_ev > 0.5, "构造的图应是暗图: {a:?}");
        assert!((a.mean_luma - 40.0).abs() < 0.5, "均值应约为 40: {a:?}");
        let after = mean_luma(&auto_enhance(img, &a, 1.0));
        assert!(
            after > 55.0,
            "纯色暗图增强后均值必须明显上升: 40 -> {after}"
        );
    }

    #[test]
    fn tone_curve_zero_changes_nothing() {
        let img = solid(4, 4, [70, 80, 90]);
        let before = img.to_rgba8().into_raw();
        let out = tone_curve(img, 0.0, 0.0, 0.0);
        assert_eq!(out.to_rgba8().into_raw(), before);
    }
}
