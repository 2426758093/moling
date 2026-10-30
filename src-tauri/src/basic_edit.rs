//! 基础编辑：裁剪 / 旋转 / 翻转 / 亮度对比度饱和度，纯本地 `image` crate 运算，
//! 不消耗服务商额度。预览在前端用 CSS filter/transform 实时呈现，确认后才落一次像素。

use image::DynamicImage;

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
}
