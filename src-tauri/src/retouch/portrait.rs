//! 人像处理：肤色蒙版磨皮、锐化、降噪。
//!
//! 磨皮只在肤色区生效并受边缘梯度抑制，避免把五官轮廓和背景一起糊掉；
//! 所有运算都是固定窗口的确定性卷积，不依赖随机数。

use crate::retouch::{clamp01, is_skin, luma, round_u8};
use image::{DynamicImage, GrayImage, Luma, Rgba, RgbaImage};

/// 边缘抑制门槛：Sobel 梯度到 120 就完全不做平滑（模糊与中值两步共用）
const EDGE_LIMIT: f32 = 120.0;

/// 与 analysis 同口径的肤色判定（BT.601 Cb/Cr/Y，谓词在 `retouch::is_skin` 里只有一份）
fn is_skin_px(px: &Rgba<u8>) -> bool {
    is_skin(px[0] as f32, px[1] as f32, px[2] as f32)
}

fn skin_mask(img: &RgbaImage) -> GrayImage {
    let mut mask = GrayImage::new(img.width(), img.height());
    for (x, y, px) in img.enumerate_pixels() {
        mask.put_pixel(x, y, Luma([if is_skin_px(px) { 255 } else { 0 }]));
    }
    mask
}

/// 硬掩膜包围盒（含端点）；整幅没有肤色像素时返回 None，中值步骤可整段跳过
fn skin_bbox(mask: &GrayImage) -> Option<(u32, u32, u32, u32)> {
    let mut found = false;
    let (mut x0, mut y0, mut x1, mut y1) = (mask.width(), mask.height(), 0u32, 0u32);
    for (x, y, px) in mask.enumerate_pixels() {
        if px[0] == 0 {
            continue;
        }
        found = true;
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x);
        y1 = y1.max(y);
    }
    found.then_some((x0, y0, x1, y1))
}

/// 3×3 均值模糊：把硬掩膜变成 0..255 软掩膜，边界处磨皮自然过渡
fn soften_mask(mask: &GrayImage) -> GrayImage {
    let (w, h) = mask.dimensions();
    let mut out = GrayImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let mut sum = 0u32;
            for dy in -1i64..=1 {
                for dx in -1i64..=1 {
                    let sx = (x as i64 + dx).clamp(0, w as i64 - 1) as u32;
                    let sy = (y as i64 + dy).clamp(0, h as i64 - 1) as u32;
                    sum += u32::from(mask.get_pixel(sx, sy)[0]);
                }
            }
            out.put_pixel(x, y, Luma([(sum / 9) as u8]));
        }
    }
    out
}

fn luma_plane(img: &RgbaImage) -> Vec<f32> {
    img.pixels()
        .map(|p| luma(p[0] as f32, p[1] as f32, p[2] as f32))
        .collect()
}

/// Sobel 梯度幅值（边界按夹取取样，1×1 图返回 0）
fn sobel_at(plane: &[f32], w: u32, h: u32, x: u32, y: u32) -> f32 {
    if w < 3 || h < 3 {
        return 0.0;
    }
    let at = |dx: i64, dy: i64| -> f32 {
        let sx = (x as i64 + dx).clamp(0, w as i64 - 1) as u32;
        let sy = (y as i64 + dy).clamp(0, h as i64 - 1) as u32;
        plane[(sy * w + sx) as usize]
    };
    let gx = -at(-1, -1) + at(1, -1) - 2.0 * at(-1, 0) + 2.0 * at(1, 0) - at(-1, 1) + at(1, 1);
    let gy = -at(-1, -1) - 2.0 * at(0, -1) - at(1, -1) + at(-1, 1) + 2.0 * at(0, 1) + at(1, 1);
    (gx * gx + gy * gy).sqrt()
}

fn sample(img: &RgbaImage, x: i64, y: i64) -> Rgba<u8> {
    let w = img.width() as i64;
    let h = img.height() as i64;
    *img.get_pixel(x.clamp(0, w - 1) as u32, y.clamp(0, h - 1) as u32)
}

/// 把一行像素拷进行缓冲（行缓冲代替整幅 clone 做 3×3 中值）
fn copy_row(img: &RgbaImage, y: u32, buf: &mut [u8]) {
    let stride = img.width() as usize * 4;
    let start = y as usize * stride;
    buf.copy_from_slice(&img.as_raw()[start..start + stride]);
}

/// 肤色区 3×3 逐通道中值，顺带祛斑 / 去孤立噪点。
///
/// 放行条件有两条：本像素自己满足 Cb/Cr/Y 硬掩膜（软化掩膜会把「贴着肤色
/// 的一像素宽背景」也算进来，邻域中值再把它拉成肤色），且本像素不在强边缘上
/// （否则窗口里过半的邻居来自另一侧，中值会把边界那一条拉向对侧，
/// 第一步辛苦保住的轮廓又被抹掉）。纹理级噪点的梯度远低于门槛，祛斑不受影响。
/// 为了不额外 clone 整幅「第一步结果」，用三行滚动快照读取写回前的邻域原值。
fn median_stage(out: &mut RgbaImage, hard: &GrayImage, plane: &[f32], amount: f32) {
    let Some((x0, y0, x1, y1)) = skin_bbox(hard) else {
        return;
    };
    let (w, h) = out.dimensions();
    let stride = w as usize * 4;
    let clamp_y = |y: i64| y.clamp(0, h as i64 - 1) as u32;
    let mut prev = vec![0u8; stride];
    let mut cur = vec![0u8; stride];
    let mut next = vec![0u8; stride];
    copy_row(out, clamp_y(i64::from(y0) - 1), &mut prev);
    copy_row(out, y0, &mut cur);
    copy_row(out, clamp_y(i64::from(y0) + 1), &mut next);

    for y in y0..=y1 {
        // 整行没有肤色像素就跳过；行快照仍要滚动，否则下一行读到的邻域会错位
        if (x0..=x1).any(|x| hard.get_pixel(x, y)[0] > 0) {
            for x in x0..=x1 {
                if hard.get_pixel(x, y)[0] == 0 {
                    continue;
                }
                let keep = 1.0 - (sobel_at(plane, w, h, x, y) / EDGE_LIMIT).clamp(0.0, 1.0);
                let blend = amount * 0.6 * keep;
                if blend <= 0.0 {
                    continue;
                }
                let mut med = [0u8; 3];
                for (c, slot) in med.iter_mut().enumerate() {
                    let mut vals = [0u8; 9];
                    let mut i = 0;
                    for row in [&prev, &cur, &next] {
                        for dx in [-1i64, 0, 1] {
                            let sx = (x as i64 + dx).clamp(0, w as i64 - 1) as usize;
                            vals[i] = row[sx * 4 + c];
                            i += 1;
                        }
                    }
                    vals.sort_unstable();
                    *slot = vals[4];
                }
                let px = out.get_pixel_mut(x, y);
                for (c, m) in med.iter().enumerate() {
                    px[c] = round_u8(f32::from(px[c]) + (f32::from(*m) - f32::from(px[c])) * blend);
                }
            }
        }
        // prev / cur / next 依次右移；next 取到的行还没被写过，仍是第一步的原值
        std::mem::swap(&mut prev, &mut cur);
        std::mem::swap(&mut cur, &mut next);
        copy_row(out, clamp_y(i64::from(y) + 2), &mut next);
    }
}

pub fn skin_smooth(img: DynamicImage, amount: f32) -> DynamicImage {
    let amount = clamp01(amount);
    if amount <= 0.0 {
        return img;
    }
    let src = img.to_rgba8();
    let (w, h) = src.dimensions();
    let hard = skin_mask(&src);
    let mask = soften_mask(&hard);
    let smooth = image::imageops::blur(&src, 1.2 + amount * 2.0);
    let plane = luma_plane(&src);
    // 先算好平滑层与梯度面，再把原像素缓冲直接当输出：两步都就地改写，
    // 不再为「第一步结果」留一份整幅 RGBA 副本
    let mut out = src;

    // 第一步：按「蒙版 × 边缘保留」权重把像素拉向平滑层
    for y in 0..h {
        for x in 0..w {
            let m = f32::from(mask.get_pixel(x, y)[0]) / 255.0;
            if m <= 0.0 {
                continue;
            }
            let gradient = sobel_at(&plane, w, h, x, y);
            let weight = m * (1.0 - (gradient / EDGE_LIMIT).clamp(0.0, 1.0)) * amount * 0.85;
            if weight <= 0.0 {
                continue;
            }
            let sp = *smooth.get_pixel(x, y);
            let px = out.get_pixel_mut(x, y);
            for c in 0..3 {
                px[c] = round_u8(f32::from(px[c]) + (f32::from(sp[c]) - f32::from(px[c])) * weight);
            }
        }
    }

    // 第二步：只在硬掩膜内做中值混合，压掉斑点但保留大结构
    median_stage(&mut out, &hard, &plane, amount);
    DynamicImage::ImageRgba8(out)
}

pub fn sharpen(img: DynamicImage, amount: f32) -> DynamicImage {
    let amount = clamp01(amount);
    if amount <= 0.0 {
        return img;
    }
    // 锐化层按 RGBA 算，混合时只回写 RGB，alpha 保持原样
    let sharp = image::imageops::unsharpen(&img.to_rgba8(), 1.2, 4);
    let mut out = img.to_rgba8();
    for (px, sp) in out.pixels_mut().zip(sharp.pixels()) {
        for c in 0..3 {
            px[c] = round_u8(f32::from(px[c]) + (f32::from(sp[c]) - f32::from(px[c])) * amount);
        }
    }
    DynamicImage::ImageRgba8(out)
}

/// 与四邻域均值比较的保守降噪：差异越大越少动，避免抹平纹理
pub fn denoise(img: DynamicImage, amount: f32) -> DynamicImage {
    let amount = clamp01(amount);
    if amount <= 0.0 {
        return img;
    }
    let src = img.to_rgba8();
    let (w, h) = src.dimensions();
    let mut out = src.clone();
    for y in 0..h {
        for x in 0..w {
            let (xi, yi) = (x as i64, y as i64);
            let center = *src.get_pixel(x, y);
            let neighbors = [
                sample(&src, xi, yi - 1),
                sample(&src, xi, yi + 1),
                sample(&src, xi - 1, yi),
                sample(&src, xi + 1, yi),
            ];
            let mut px = center;
            for (c, slot) in px.0.iter_mut().take(3).enumerate() {
                let mean = (f32::from(neighbors[0][c])
                    + f32::from(neighbors[1][c])
                    + f32::from(neighbors[2][c])
                    + f32::from(neighbors[3][c]))
                    / 4.0;
                let v = f32::from(center[c]);
                let d = (v - mean).abs();
                let weight = amount * 0.5 * (d / (d + 24.0));
                *slot = round_u8(v + (mean - v) * weight);
            }
            out.put_pixel(x, y, px);
        }
    }
    DynamicImage::ImageRgba8(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::RgbImage;

    fn variance(img: &RgbaImage, x0: u32, y0: u32, x1: u32, y1: u32) -> f32 {
        let vals: Vec<f32> = (y0..y1)
            .flat_map(|y| (x0..x1).map(move |x| (x, y)))
            .map(|(x, y)| {
                let p = img.get_pixel(x, y);
                luma(p[0] as f32, p[1] as f32, p[2] as f32)
            })
            .collect();
        let n = vals.len() as f32;
        let mean = vals.iter().sum::<f32>() / n;
        vals.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / n
    }

    /// 肤色块 + 固定噪声：磨皮后内部方差必须下降
    #[test]
    fn skin_smooth_reduces_variance_inside_skin() {
        let mut img = RgbImage::new(40, 40);
        for (x, y, px) in img.enumerate_pixels_mut() {
            let noise = (x as i32 * 37 + y as i32 * 71) % 11 - 5;
            let mix = |base: i32| (base + noise).clamp(0, 255) as u8;
            *px = image::Rgb([mix(200), mix(160), mix(140)]);
        }
        let before = variance(
            &DynamicImage::ImageRgb8(img.clone()).to_rgba8(),
            6,
            6,
            34,
            34,
        );
        let out = skin_smooth(DynamicImage::ImageRgb8(img), 1.0).to_rgba8();
        let after = variance(&out, 6, 6, 34, 34);
        assert!(
            after < before * 0.8,
            "肤色区方差应明显下降: {before} -> {after}"
        );
    }

    /// 肤色 / 深色硬边界：两侧亮度差至少保留 80%
    #[test]
    fn skin_smooth_keeps_skin_edge() {
        let mut img = RgbImage::new(40, 20);
        for (x, _y, px) in img.enumerate_pixels_mut() {
            *px = if x < 20 {
                image::Rgb([200, 160, 140])
            } else {
                image::Rgb([40, 40, 40])
            };
        }
        let before = DynamicImage::ImageRgb8(img.clone()).to_rgba8();
        let diff_before = (luma(200.0, 160.0, 140.0) - luma(40.0, 40.0, 40.0)).abs();
        let out = skin_smooth(DynamicImage::ImageRgb8(img), 1.0).to_rgba8();
        let left = out.get_pixel(19, 10);
        let right = out.get_pixel(20, 10);
        let diff_after = (luma(left[0] as f32, left[1] as f32, left[2] as f32)
            - luma(right[0] as f32, right[1] as f32, right[2] as f32))
        .abs();
        assert!(
            diff_after >= diff_before * 0.8,
            "边缘对比必须保留: {diff_before} -> {diff_after}"
        );
        // 深色块不在肤色蒙版内，必须完全不动
        assert_eq!(before.get_pixel(20, 10), right);
    }

    /// 中等梯度边界：左半肤色 (200,160,140)、右半同族略暗肤色 (150,120,105)
    /// （两侧都满足 Cb/Cr/Y 谓词，蒙版处处为 1，保边只能靠梯度项），中间用
    /// 4 像素线性斜坡过渡而不是硬阶跃。斜坡上每像素亮度落差约 10.4，
    /// 中心的 Sobel 梯度约 84，`keep = 1 - 梯度/EDGE_LIMIT` 约为 0.3——
    /// 严格落在 (0,1) 内：既不是被完全冻结的边缘，也真的会被平滑层抬动。
    /// 断言的是斜坡两侧各 4 像素宽条带（各 12 行）的平均亮度差仍保留 80%，
    /// 并断言这个边缘因子在中心确实是有限正值。旧用例是硬阶跃，
    /// 梯度顶满使 keep 恒为 0、两步平滑在测量列上全是 no-op，
    /// 「保留 80%」只是同义反复；现在 keep 有限，把因子删掉（keep 写死 1）
    /// 会让斜坡连同两侧肩部一起被抹平，保留率掉到 0.77，断言立刻失败。
    #[test]
    fn skin_smooth_keeps_moderate_gradient_edge() {
        const W: u32 = 40;
        const H: u32 = 20;
        /// 斜坡起点（含）与宽度：x=18..21 这 4 个像素线性插值
        const RAMP_X: u32 = 18;
        const RAMP_W: u32 = 4;
        /// 斜坡中心列：x=19 与 x=20 之间，取右侧那列做梯度测量
        const CENTER: u32 = RAMP_X + RAMP_W / 2;

        let left = [200i32, 160, 140];
        let right = [150i32, 120, 105];
        let mut img = RgbImage::new(W, H);
        for (x, y, px) in img.enumerate_pixels_mut() {
            // 4 个过渡像素各取所在子区间的中点，两端直接接平台，等距线性
            let t = if x < RAMP_X {
                0.0
            } else if x < RAMP_X + RAMP_W {
                ((x - RAMP_X) * 2 + 1) as f32 / (2 * RAMP_W) as f32
            } else {
                1.0
            };
            let noise = (x as i32 * 37 + y as i32 * 71) % 7 - 3;
            let lerp = |a: i32, b: i32| (a as f32 + (b - a) as f32 * t).round() as i32 + noise;
            *px = image::Rgb([
                lerp(left[0], right[0]).clamp(0, 255) as u8,
                lerp(left[1], right[1]).clamp(0, 255) as u8,
                lerp(left[2], right[2]).clamp(0, 255) as u8,
            ]);
        }
        let base = DynamicImage::ImageRgb8(img);
        let before = base.to_rgba8();
        assert!(
            is_skin(200.0, 160.0, 140.0) && is_skin(150.0, 120.0, 105.0),
            "两侧颜色都必须落在肤色谓词内，保边只能靠梯度项"
        );
        let plane = luma_plane(&before);

        // 斜坡左右各取 4 像素宽的条带（紧贴斜坡，两侧对称），
        // 跨 12 行求均值以抵掉 ±3 噪声
        const LEFT_BAND: u32 = RAMP_X - 4;
        const RIGHT_BAND: u32 = RAMP_X + RAMP_W;
        let band = |img: &RgbaImage, x0: u32| -> f32 {
            let mut sum = 0.0;
            let mut n = 0.0;
            for y in 4..16 {
                for x in x0..x0 + 4 {
                    let p = img.get_pixel(x, y);
                    sum += luma(p[0] as f32, p[1] as f32, p[2] as f32);
                    n += 1.0;
                }
            }
            sum / n
        };
        let step_before = (band(&before, LEFT_BAND) - band(&before, RIGHT_BAND)).abs();
        assert!(
            step_before > 30.0,
            "构造的边界要有可测的亮度阶跃: {step_before}"
        );

        let after = skin_smooth(base, 1.0).to_rgba8();
        let step_after = (band(&after, LEFT_BAND) - band(&after, RIGHT_BAND)).abs();
        assert!(
            step_after / step_before >= 0.8,
            "中等梯度边界也要保留 80%: {step_before} -> {step_after}"
        );

        // 边缘因子在斜坡中心必须是有限的严格正值（与实现同一条表达式）。
        // 若它被删掉 / 被写死成 1，斜坡就会被平滑层抹平，上面的保留断言随之失败
        let gradient: f32 = (4..16)
            .map(|y| sobel_at(&plane, W, H, CENTER, y))
            .sum::<f32>()
            / 12.0;
        let keep_at_center = 1.0 - (gradient / EDGE_LIMIT).clamp(0.0, 1.0);
        assert!(
            keep_at_center > 0.0 && keep_at_center < 1.0,
            "斜坡中心的边缘保留因子必须严格落在 (0,1) 内: gradient={gradient} keep={keep_at_center}"
        );

        // 肤色区确实被处理过（否则上面的「保留」可能只是整幅提前返回）
        assert!(
            (0..W).any(|x| (0..H).any(|y| before.get_pixel(x, y) != after.get_pixel(x, y))),
            "amount=1 时肤色区应被处理"
        );
    }

    /// 中值步骤必须按硬掩膜放行：贴着画面的背景竖条（本身不满足 Cb/Cr/Y）
    /// 一个字节都不能动。它和肤色的梯度顶满，第一步的权重本来就是 0，
    /// 只有中值步骤会把它拉成肤色——旧实现按软化掩膜 >=8 放行，正好会踩这个坑。
    #[test]
    fn skin_median_does_not_bleed_into_background() {
        let mut img = RgbImage::new(40, 20);
        for (x, y, px) in img.enumerate_pixels_mut() {
            if x == 0 {
                // 冷色竖条：Cb 超出肤色区间，属于背景
                *px = image::Rgb([90, 110, 150]);
            } else {
                let noise = (x as i32 * 37 + y as i32 * 71) % 11 - 5;
                let mix = |base: i32| (base + noise).clamp(0, 255) as u8;
                *px = image::Rgb([mix(200), mix(160), mix(140)]);
            }
        }
        assert!(!is_skin(90.0, 110.0, 150.0), "构造的像素必须是背景");
        let base = DynamicImage::ImageRgb8(img);
        let before = base.to_rgba8();
        let out = skin_smooth(base, 1.0).to_rgba8();
        for y in 0..20 {
            assert_eq!(
                out.get_pixel(0, y),
                before.get_pixel(0, y),
                "背景列必须逐字节不变（y={y}）"
            );
        }
        // 相邻肤色被处理过，证明不是整幅提前返回导致的「不变」
        let skin_changed =
            (1..40).any(|x| (0..20).any(|y| out.get_pixel(x, y) != before.get_pixel(x, y)));
        assert!(skin_changed, "肤色区应被处理");
    }

    #[test]
    fn single_pixel_does_not_panic() {
        let img = DynamicImage::ImageRgb8(RgbImage::from_pixel(1, 1, image::Rgb([200, 160, 140])));
        let _ = skin_smooth(img.clone(), 1.0);
        let _ = sharpen(img.clone(), 1.0);
        let _ = denoise(img, 1.0);
    }

    #[test]
    fn zero_amount_is_identity() {
        let mut img = RgbImage::new(12, 9);
        for (x, y, px) in img.enumerate_pixels_mut() {
            *px = image::Rgb([(x * 7) as u8, (y * 11) as u8, 128]);
        }
        let base = DynamicImage::ImageRgb8(img);
        let expected = base.to_rgba8().into_raw();
        assert_eq!(
            skin_smooth(base.clone(), 0.0).to_rgba8().into_raw(),
            expected
        );
        assert_eq!(sharpen(base.clone(), 0.0).to_rgba8().into_raw(), expected);
        assert_eq!(denoise(base, 0.0).to_rgba8().into_raw(), expected);
    }

    /// 降噪把孤立噪声点往四邻域均值拉；结构平缓处基本不动
    #[test]
    fn denoise_pulls_outlier_toward_neighbors() {
        let mut img = RgbImage::from_pixel(9, 9, image::Rgb([100, 100, 100]));
        img.put_pixel(4, 4, image::Rgb([200, 200, 200]));
        let out = denoise(DynamicImage::ImageRgb8(img), 1.0).to_rgba8();
        let px = out.get_pixel(4, 4);
        assert!(px[0] < 200 && px[0] > 100, "噪声点应向邻域靠拢: {px:?}");
        assert_eq!(out.get_pixel(0, 0)[0], 100, "平坦区域不应被改动");
    }
}
