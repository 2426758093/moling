//! 基础编辑：裁剪 / 旋转 / 翻转 / 亮度对比度饱和度，纯本地 `image` crate 运算，
//! 不消耗服务商额度。预览在前端用 CSS filter/transform 实时呈现，确认后才落一次像素。
//!
//! 任意角度旋转用「中心逆映射 + 双线性插值」实现，越界部分输出透明；
//! 自动拉直只做灰度投影分析，返回可直接喂给 `RotateFree` 的角度。

use image::{DynamicImage, Rgba, RgbaImage};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FlipAxis {
    Horizontal,
    Vertical,
}

/// 编辑指令按数组顺序依次作用；前端按「旋转 → 翻转 → 裁剪 → 调色」下发，
/// 因此裁剪坐标就是用户在屏幕上框选的坐标（已含旋转翻转后的方向）。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum EditOp {
    Crop {
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    },
    Rotate {
        deg: u32,
    },
    /// 任意角度旋转：`deg` 为角度（度），正值为顺时针，绝对值不超过 180。
    /// 输出会按包围盒扩大，越界区域透明；|deg| < 0.01 视为不变。
    RotateFree {
        deg: f32,
    },
    Flip {
        axis: FlipAxis,
    },
    Adjust {
        brightness: f32,
        contrast: f32,
        saturation: f32,
    },
}

/// 亮度 / 对比度 / 饱和度，取值 -100..=100（0 不变）。
/// 运算顺序与前端 CSS `brightness() contrast() saturate()` 一致，保证预览与落盘接近。
fn adjust_pixels(
    img: DynamicImage,
    brightness: f32,
    contrast: f32,
    saturation: f32,
) -> DynamicImage {
    if brightness == 0.0 && contrast == 0.0 && saturation == 0.0 {
        return img;
    }
    let bf = (1.0 + brightness / 100.0).max(0.0);
    let cf = (1.0 + contrast / 100.0).max(0.0);
    let sf = (1.0 + saturation / 100.0).max(0.0);
    let mut rgba = img.to_rgba8();
    for px in rgba.pixels_mut() {
        let mut c = [px[0] as f32, px[1] as f32, px[2] as f32];
        for v in c.iter_mut() {
            *v = (*v * bf - 127.5) * cf + 127.5;
        }
        // CSS saturate 的亮度权重，保证与预览一致
        let luma = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        for v in c.iter_mut() {
            *v = luma + (*v - luma) * sf;
        }
        px[0] = c[0].clamp(0.0, 255.0).round() as u8;
        px[1] = c[1].clamp(0.0, 255.0).round() as u8;
        px[2] = c[2].clamp(0.0, 255.0).round() as u8;
        // alpha 原样保留
    }
    DynamicImage::ImageRgba8(rgba)
}

/// 依次应用编辑指令；越界裁剪自动收敛到图像内，非法旋转角度直接报错。
pub fn apply_ops(mut img: DynamicImage, ops: &[EditOp]) -> Result<DynamicImage, String> {
    for op in ops {
        match op {
            EditOp::Crop {
                x,
                y,
                width,
                height,
            } => {
                if *width == 0 || *height == 0 {
                    return Err("裁剪区域为空".to_string());
                }
                let (w, h) = (img.width(), img.height());
                let x = (*x).min(w.saturating_sub(1));
                let y = (*y).min(h.saturating_sub(1));
                let cw = (*width).min(w - x);
                let ch = (*height).min(h - y);
                img = img.crop_imm(x, y, cw, ch);
            }
            EditOp::Rotate { deg } => {
                img = match deg {
                    90 => img.rotate90(),
                    180 => img.rotate180(),
                    270 => img.rotate270(),
                    _ => return Err("旋转角度只支持 90 / 180 / 270".to_string()),
                };
            }
            EditOp::RotateFree { deg } => {
                img = rotate_free(img, *deg)?;
            }
            EditOp::Flip { axis } => {
                img = match axis {
                    FlipAxis::Horizontal => img.fliph(),
                    FlipAxis::Vertical => img.flipv(),
                };
            }
            EditOp::Adjust {
                brightness,
                contrast,
                saturation,
            } => {
                img = adjust_pixels(img, *brightness, *contrast, *saturation);
            }
        }
    }
    Ok(img)
}

/// 双线性采样：四个邻点按 alpha 预乘后加权，越界邻点视为全透明。
/// 这样旋转后的外边界自然过渡到 alpha=0，而不是把边缘像素拉成硬边。
fn sample_bilinear(src: &RgbaImage, x: f32, y: f32) -> [u8; 4] {
    let w = src.width() as i32;
    let h = src.height() as i32;
    if w == 0 || h == 0 {
        return [0, 0, 0, 0];
    }
    let x0 = x.floor();
    let y0 = y.floor();
    let fx = x - x0;
    let fy = y - y0;
    let x0 = x0 as i32;
    let y0 = y0 as i32;
    let mut acc = [0.0f32; 4];
    let neighbors = [
        (0, 0, (1.0 - fx) * (1.0 - fy)),
        (1, 0, fx * (1.0 - fy)),
        (0, 1, (1.0 - fx) * fy),
        (1, 1, fx * fy),
    ];
    for (dx, dy, weight) in neighbors {
        if weight <= 0.0 {
            continue;
        }
        let (xi, yi) = (x0 + dx, y0 + dy);
        if xi < 0 || yi < 0 || xi >= w || yi >= h {
            continue;
        }
        let p = src.get_pixel(xi as u32, yi as u32).0;
        let a = f32::from(p[3]) * weight;
        acc[0] += f32::from(p[0]) * a;
        acc[1] += f32::from(p[1]) * a;
        acc[2] += f32::from(p[2]) * a;
        acc[3] += a;
    }
    if acc[3] <= 0.0 {
        return [0, 0, 0, 0];
    }
    [
        (acc[0] / acc[3]).clamp(0.0, 255.0) as u8,
        (acc[1] / acc[3]).clamp(0.0, 255.0) as u8,
        (acc[2] / acc[3]).clamp(0.0, 255.0) as u8,
        acc[3].clamp(0.0, 255.0) as u8,
    ]
}

/// 以图像中心为原点做逆映射 + 双线性插值，输出包围盒随角度扩大，
/// 越界区域 alpha=0。`deg` 为顺时针角度（度），必须有限且 |deg| ≤ 180。
pub fn rotate_free(img: DynamicImage, deg: f32) -> Result<DynamicImage, String> {
    if !deg.is_finite() || !(-180.0..=180.0).contains(&deg) {
        return Err(format!(
            "旋转角度无效（{deg:?}），需为 -180° 到 180° 的有限值"
        ));
    }
    if deg.abs() < 0.01 {
        return Ok(img);
    }
    // 直角档直接走无损路径：既快，也避免浮点误差让尺寸多出 1 像素
    if (deg.abs() - 90.0).abs() < 1e-3 {
        return Ok(if deg > 0.0 {
            img.rotate90()
        } else {
            img.rotate270()
        });
    }
    if (deg.abs() - 180.0).abs() < 1e-3 {
        return Ok(img.rotate180());
    }

    let src = img.to_rgba8();
    let (sw, sh) = (src.width() as f32, src.height() as f32);
    let rad = deg.to_radians();
    let (sin, cos) = (rad.sin(), rad.cos());
    // 浮点余弦在 90° 附近会残留极小值，减 1e-4 再向上取整避免多算一像素
    let out_w = ((sw * cos.abs() + sh * sin.abs()) - 1e-4).ceil().max(1.0);
    let out_h = ((sw * sin.abs() + sh * cos.abs()) - 1e-4).ceil().max(1.0);
    let (out_w, out_h) = (out_w as u32, out_h as u32);

    let (scx, scy) = ((sw - 1.0) / 2.0, (sh - 1.0) / 2.0);
    let (ocx, ocy) = ((out_w as f32 - 1.0) / 2.0, (out_h as f32 - 1.0) / 2.0);
    let mut out = RgbaImage::new(out_w, out_h);
    for oy in 0..out_h {
        let dy = oy as f32 - ocy;
        for ox in 0..out_w {
            let dx = ox as f32 - ocx;
            // 逆旋转 R(-deg)：把输出坐标映射回原图坐标
            let sx = dx * cos + dy * sin + scx;
            let sy = dy * cos - dx * sin + scy;
            let px = sample_bilinear(&src, sx, sy);
            out.put_pixel(ox, oy, Rgba(px));
        }
    }
    Ok(DynamicImage::ImageRgba8(out))
}

/// 自动拉直：灰度化 + 投影轮廓方差搜索倾斜角。
///
/// 返回值是「可直接作为 `RotateFree.deg` 应用」的角度（度）：
/// 例如画面内容顺时针偏了 8°，返回约 -8，套用后即拉正。
/// 纯本地、确定性；没有可用的边缘内容时返回 0.0。
pub fn estimate_skew(img: &DynamicImage) -> Result<f32, String> {
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return Err("图片尺寸为空，无法估算倾斜角".to_string());
    }
    // 长边超过 1024 先等比缩小：投影只关心线条走向，不需要全分辨率
    let rgba = img.to_rgba8();
    let (gw, gh, rgba) = if w.max(h) > 1024 {
        let scale = 1024.0 / w.max(h) as f32;
        let nw = ((w as f32 * scale).round() as u32).max(1);
        let nh = ((h as f32 * scale).round() as u32).max(1);
        let resized = image::imageops::resize(&rgba, nw, nh, image::imageops::FilterType::Triangle);
        (nw, nh, resized)
    } else {
        (w, h, rgba)
    };
    // 灰度：透明像素记为 NaN，参与梯度计算时结果仍是 NaN，
    // 后续 `>= 阈值` 判断自然为 false，等于跳过透明边界。
    let luma: Vec<f32> = rgba
        .pixels()
        .map(|p| {
            if p[3] < 8 {
                f32::NAN
            } else {
                0.2126 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.0722 * f32::from(p[2])
            }
        })
        .collect();
    let lum = |x: u32, y: u32| luma[(y * gw + x) as usize];

    let cx = (gw as f32 - 1.0) / 2.0;
    let cy = (gh as f32 - 1.0) / 2.0;
    let pixels = u64::from(gw) * u64::from(gh);
    // 采样步长：控制参与投影的像素在 25 万以内，缩略图本就够用
    let step = (((pixels as f32) / 250_000.0).sqrt().ceil() as usize).max(1);
    let mut samples: Vec<(f32, f32, f32)> = Vec::new();
    let mut total_weight = 0.0f32;
    for y in (0..gh).step_by(step) {
        for x in (0..gw).step_by(step) {
            let l = lum(x, y);
            let gx = if x + 1 < gw {
                (lum(x + 1, y) - l).abs()
            } else {
                f32::NAN
            };
            let gy = if y + 1 < gh {
                (lum(x, y + 1) - l).abs()
            } else {
                f32::NAN
            };
            let weight = gx + gy;
            // NaN（透明区域）与弱纹理都不参与
            if weight >= 8.0 {
                samples.push((x as f32 - cx, y as f32 - cy, weight));
                total_weight += weight;
            }
        }
    }
    if samples.len() < 16 || total_weight < 1.0 {
        return Ok(0.0);
    }

    let diagonal = ((gw * gw + gh * gh) as f32).sqrt();
    let bins = (diagonal.ceil() as usize).max(1) + 2;
    let offset = diagonal / 2.0 + 1.0;
    let mut best_angle = 0.0f32;
    let mut best_score = -1.0f32;
    // -15.0..=15.0，步长 0.5°，共 61 个候选
    for i in 0..=60 {
        let candidate = -15.0 + 0.5 * i as f32;
        let rad = candidate.to_radians();
        let (sin, cos) = (rad.sin(), rad.cos());
        let mut profile = vec![0.0f32; bins];
        for &(dx, dy, weight) in &samples {
            // 按「把图转 candidate 度」后的纵向坐标投影
            let t = dx * sin + dy * cos + offset;
            let idx = t.floor();
            if idx >= 0.0 && (idx as usize) < bins {
                profile[idx as usize] += weight;
            }
        }
        let n = bins as f32;
        let mean = profile.iter().sum::<f32>() / n;
        let score = profile.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / n;
        // 分数相同时偏向更小的角度，避免噪声图报出一个大角度
        let near_tie = (score - best_score).abs() <= best_score.abs() * 1e-6;
        if score > best_score * (1.0 + 1e-6) || (near_tie && candidate.abs() < best_angle.abs()) {
            best_score = score;
            best_angle = candidate;
        }
    }
    Ok(best_angle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    fn solid(w: u32, h: u32, rgba: [u8; 4]) -> DynamicImage {
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(w, h, Rgba(rgba)))
    }

    fn pixel(img: &DynamicImage, x: u32, y: u32) -> [u8; 4] {
        img.to_rgba8().get_pixel(x, y).0
    }

    #[test]
    fn rotate_90_swaps_dimensions() {
        let img = solid(40, 20, [1, 2, 3, 255]);
        let out = apply_ops(img.clone(), &[EditOp::Rotate { deg: 90 }]).unwrap();
        assert_eq!((out.width(), out.height()), (20, 40));
        let out = apply_ops(img, &[EditOp::Rotate { deg: 270 }]).unwrap();
        assert_eq!((out.width(), out.height()), (20, 40));
        // 180 不换边
        let out = apply_ops(
            solid(40, 20, [1, 2, 3, 255]),
            &[EditOp::Rotate { deg: 180 }],
        )
        .unwrap();
        assert_eq!((out.width(), out.height()), (40, 20));
    }

    #[test]
    fn rotate_rejects_other_angles() {
        let err =
            apply_ops(solid(4, 4, [0, 0, 0, 255]), &[EditOp::Rotate { deg: 45 }]).unwrap_err();
        assert!(err.contains("90"), "{err}");
    }

    #[test]
    fn crop_keeps_requested_region() {
        // 8x4：左 4 列红，右 4 列蓝
        let mut img = RgbaImage::new(8, 4);
        for (x, _, p) in img.enumerate_pixels_mut() {
            *p = if x < 4 {
                Rgba([255, 0, 0, 255])
            } else {
                Rgba([0, 0, 255, 255])
            };
        }
        let out = apply_ops(
            DynamicImage::ImageRgba8(img),
            &[EditOp::Crop {
                x: 4,
                y: 0,
                width: 4,
                height: 4,
            }],
        )
        .unwrap();
        assert_eq!((out.width(), out.height()), (4, 4));
        assert_eq!(pixel(&out, 0, 0), [0, 0, 255, 255]);
        assert_eq!(pixel(&out, 3, 3), [0, 0, 255, 255]);
    }

    #[test]
    fn crop_clamps_overflow_and_rejects_empty() {
        let out = apply_ops(
            solid(8, 6, [10, 10, 10, 255]),
            &[EditOp::Crop {
                x: 6,
                y: 4,
                width: 100,
                height: 100,
            }],
        )
        .unwrap();
        assert_eq!((out.width(), out.height()), (2, 2));

        let err = apply_ops(
            solid(8, 6, [10, 10, 10, 255]),
            &[EditOp::Crop {
                x: 0,
                y: 0,
                width: 0,
                height: 3,
            }],
        )
        .unwrap_err();
        assert!(err.contains("裁剪区域为空"), "{err}");
    }

    #[test]
    fn brightness_is_monotonic() {
        let base = solid(2, 2, [100, 100, 100, 255]);
        let dim = apply_ops(
            base.clone(),
            &[EditOp::Adjust {
                brightness: -30.0,
                contrast: 0.0,
                saturation: 0.0,
            }],
        )
        .unwrap();
        let bright = apply_ops(
            base,
            &[EditOp::Adjust {
                brightness: 30.0,
                contrast: 0.0,
                saturation: 0.0,
            }],
        )
        .unwrap();
        assert!(pixel(&dim, 0, 0)[0] < 100);
        assert!(pixel(&bright, 0, 0)[0] > 100);
    }

    #[test]
    fn saturation_minus_100_grays_out() {
        let out = apply_ops(
            solid(2, 2, [200, 30, 30, 255]),
            &[EditOp::Adjust {
                brightness: 0.0,
                contrast: 0.0,
                saturation: -100.0,
            }],
        )
        .unwrap();
        let p = pixel(&out, 0, 0);
        assert_eq!(p[0], p[1], "{p:?}");
        assert_eq!(p[1], p[2], "{p:?}");
    }

    #[test]
    fn flip_mirrors_pixels_and_keeps_dimensions() {
        let mut img = RgbaImage::new(4, 2);
        img.put_pixel(0, 0, Rgba([255, 0, 0, 255]));
        img.put_pixel(3, 0, Rgba([0, 255, 0, 255]));
        let out = apply_ops(
            DynamicImage::ImageRgba8(img),
            &[EditOp::Flip {
                axis: FlipAxis::Horizontal,
            }],
        )
        .unwrap();
        assert_eq!((out.width(), out.height()), (4, 2));
        assert_eq!(pixel(&out, 0, 0), [0, 255, 0, 255]);
        assert_eq!(pixel(&out, 3, 0), [255, 0, 0, 255]);
    }

    #[test]
    fn ops_apply_in_order() {
        // 先裁剪 2x4 再转 90°，应得到 4x2
        let out = apply_ops(
            solid(10, 10, [1, 1, 1, 255]),
            &[
                EditOp::Crop {
                    x: 0,
                    y: 0,
                    width: 2,
                    height: 4,
                },
                EditOp::Rotate { deg: 90 },
            ],
        )
        .unwrap();
        assert_eq!((out.width(), out.height()), (4, 2));
    }

    #[test]
    fn rotate_free_zero_is_identity() {
        let img = solid(10, 6, [7, 8, 9, 255]);
        let out = rotate_free(img, 0.0).unwrap();
        assert_eq!((out.width(), out.height()), (10, 6));
        assert_eq!(pixel(&out, 3, 2), [7, 8, 9, 255]);
        assert_eq!(pixel(&out, 9, 5), [7, 8, 9, 255]);
        // 小于 0.01° 同样视为不变
        let out = rotate_free(solid(10, 6, [1, 1, 1, 255]), 0.004).unwrap();
        assert_eq!((out.width(), out.height()), (10, 6));
    }

    #[test]
    fn rotate_free_right_angles_match_rotate_dims() {
        // rotateFree 的角度上限是 180°，270° 用等价的 -90° 表达
        for (deg, free_deg) in [(90u32, 90.0f32), (180, 180.0), (270, -90.0)] {
            let img = solid(40, 20, [1, 2, 3, 255]);
            let by_op = apply_ops(img.clone(), &[EditOp::Rotate { deg }]).unwrap();
            let free = rotate_free(img, free_deg).unwrap();
            assert_eq!(
                (free.width(), free.height()),
                (by_op.width(), by_op.height()),
                "{deg}° 尺寸应与 Rotate 一致"
            );
        }
        // 负角度同样命中直角分支（-90 = 顺时针 270）
        let out = rotate_free(solid(40, 20, [1, 2, 3, 255]), -90.0).unwrap();
        assert_eq!((out.width(), out.height()), (20, 40));
    }

    #[test]
    fn rotate_free_bounding_box_for_45deg() {
        // ceil(100*cos45 + 50*sin45) = ceil(106.07) = 107
        let out = rotate_free(solid(100, 50, [10, 20, 30, 255]), 45.0).unwrap();
        assert_eq!((out.width(), out.height()), (107, 107));
        // 负角度包围盒一致
        let out = rotate_free(solid(100, 50, [10, 20, 30, 255]), -45.0).unwrap();
        assert_eq!((out.width(), out.height()), (107, 107));
    }

    #[test]
    fn rotate_free_rejects_invalid_angles() {
        for deg in [f32::NAN, f32::INFINITY, 181.0, -181.0] {
            let err = rotate_free(solid(4, 4, [0, 0, 0, 255]), deg).unwrap_err();
            assert!(err.contains("角度"), "{deg:?} => {err}");
        }
        let err = apply_ops(
            solid(4, 4, [0, 0, 0, 255]),
            &[EditOp::RotateFree { deg: 181.0 }],
        )
        .unwrap_err();
        assert!(err.contains("角度"), "{err}");
    }

    #[test]
    fn rotate_free_outside_pixels_are_transparent() {
        let out = rotate_free(solid(100, 50, [255, 0, 0, 255]), 45.0).unwrap();
        assert_eq!(pixel(&out, 0, 0)[3], 0);
        assert_eq!(pixel(&out, out.width() - 1, out.height() - 1)[3], 0);
        // 中心保持原色与不透明
        let center = pixel(&out, out.width() / 2, out.height() / 2);
        assert_eq!(center, [255, 0, 0, 255]);
    }

    /// 白底黑格：每 20 像素一条 2 像素宽的黑线，横竖都有
    fn grid(w: u32, h: u32) -> DynamicImage {
        let mut img = RgbaImage::from_pixel(w, h, Rgba([255, 255, 255, 255]));
        for x in (0..w).step_by(20) {
            for dx in 0..2 {
                if x + dx < w {
                    for y in 0..h {
                        img.put_pixel(x + dx, y, Rgba([0, 0, 0, 255]));
                    }
                }
            }
        }
        for y in (0..h).step_by(20) {
            for dy in 0..2 {
                if y + dy < h {
                    for x in 0..w {
                        img.put_pixel(x, y + dy, Rgba([0, 0, 0, 255]));
                    }
                }
            }
        }
        DynamicImage::ImageRgba8(img)
    }

    #[test]
    fn estimate_skew_detects_rotated_grid() {
        let upright = grid(240, 240);
        let base = estimate_skew(&upright).unwrap();
        assert!(base.abs() <= 1.0, "正放网格应接近 0°，实际 {base}");

        let skewed = rotate_free(upright, 8.0).unwrap();
        let angle = estimate_skew(&skewed).unwrap();
        assert!((angle + 8.0).abs() <= 1.0, "应报约 -8°，实际 {angle}");

        // 返回值可直接作为 RotateFree.deg 使用，套用后残余倾斜应很小
        let fixed = rotate_free(skewed, angle).unwrap();
        let residual = estimate_skew(&fixed).unwrap();
        assert!(residual.abs() <= 1.0, "拉直后仍偏 {residual}°");
    }

    #[test]
    fn estimate_skew_blank_image_is_zero() {
        // 无梯度内容：必须返回 0.0 且不 panic
        assert_eq!(
            estimate_skew(&solid(64, 64, [128, 128, 128, 255])).unwrap(),
            0.0
        );
        // 全透明同样视为无有效内容
        assert_eq!(estimate_skew(&solid(32, 32, [0, 0, 0, 0])).unwrap(), 0.0);
    }
}
