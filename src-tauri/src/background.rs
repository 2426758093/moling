//! 换背景：纯色 / 渐变由本地 `image` crate 合成（按蒙版做 1–2px 羽化的 alpha 混合），
//! AI 背景走服务商编辑接口。两种路径共用同一份蒙版口径：白色（luma）区域被替换。

use image::{DynamicImage, GrayImage, Luma};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GradientDirection {
    Horizontal,
    Vertical,
    Diagonal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackgroundFill {
    Solid([u8; 3]),
    Gradient {
        from: [u8; 3],
        to: [u8; 3],
        direction: GradientDirection,
    },
}

impl BackgroundFill {
    fn color_at(&self, x: u32, y: u32, w: u32, h: u32) -> [u8; 3] {
        match self {
            BackgroundFill::Solid(c) => *c,
            BackgroundFill::Gradient {
                from,
                to,
                direction,
            } => {
                let t = match direction {
                    GradientDirection::Horizontal => {
                        if w <= 1 {
                            0.0
                        } else {
                            x as f32 / (w - 1) as f32
                        }
                    }
                    GradientDirection::Vertical => {
                        if h <= 1 {
                            0.0
                        } else {
                            y as f32 / (h - 1) as f32
                        }
                    }
                    GradientDirection::Diagonal => {
                        let denom = w + h - 2;
                        if denom == 0 {
                            0.0
                        } else {
                            (x + y) as f32 / denom as f32
                        }
                    }
                };
                let mix = |a: u8, b: u8| (a as f32 + (b as f32 - a as f32) * t).round() as u8;
                [
                    mix(from[0], to[0]),
                    mix(from[1], to[1]),
                    mix(from[2], to[2]),
                ]
            }
        }
    }
}

/// 解析 `#RRGGBB` / `RRGGBB`；其它形式一律报错，避免脏值悄悄变成黑色。
pub fn parse_hex(s: &str) -> Result<[u8; 3], String> {
    let t = s.trim().trim_start_matches('#');
    if t.len() != 6 || !t.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("颜色格式无效: {s}"));
    }
    let v = u32::from_str_radix(t, 16).expect("已校验为 6 位十六进制");
    Ok([(v >> 16) as u8, (v >> 8) as u8, v as u8])
}

pub fn parse_direction(s: &str) -> GradientDirection {
    match s {
        "vertical" => GradientDirection::Vertical,
        "diagonal" => GradientDirection::Diagonal,
        _ => GradientDirection::Horizontal,
    }
}

/// AI 背景的指令前缀：让模型只改蒙版区域，其余像素保持不变。
pub fn background_ai_prompt(description: &str) -> String {
    format!("Replace the masked background with: {}", description.trim())
}

/// 白 = 替换口径：蒙版里是否存在被涂抹像素。
pub fn luma_has_region(mask: &DynamicImage) -> bool {
    mask.to_luma8().pixels().any(|p| p[0] > 0)
}

/// 黑底透明孔口径（inpainting 上传格式）：是否存在被涂抹像素。
pub fn alpha_has_region(mask: &DynamicImage) -> bool {
    mask.to_rgba8().pixels().any(|p| p[3] < 255)
}

/// 可分离盒式模糊，把蒙版边缘平滑 1–2px，避免硬边。
fn box_blur(src: &[u8], w: usize, h: usize, radius: usize, horizontal: bool) -> Vec<u8> {
    let mut out = vec![0u8; src.len()];
    let (lines, len) = if horizontal { (h, w) } else { (w, h) };
    for line in 0..lines {
        let at = |i: usize| {
            if horizontal {
                src[line * w + i]
            } else {
                src[i * w + line]
            }
        };
        let mut sum: u32 = 0;
        let mut count: u32 = 0;
        // 先铺前 radius+1 个像素（越界按边界像素重复）
        for i in 0..=radius.min(len - 1) {
            sum += at(i) as u32;
            count += 1;
        }
        for i in 0..len {
            let value = (sum / count) as u8;
            if horizontal {
                out[line * w + i] = value;
            } else {
                out[i * w + line] = value;
            }
            // 滑窗：加右侧新像素，减最左侧旧像素
            let remove = i.saturating_sub(radius);
            let add = i + radius + 1;
            if add < len {
                sum += at(add) as u32;
                count += 1;
            }
            if i >= radius {
                sum -= at(remove) as u32;
                count -= 1;
            }
        }
    }
    out
}

pub(crate) fn feather(mask: &GrayImage, radius: u32) -> GrayImage {
    if radius == 0 {
        return mask.clone();
    }
    let (w, h) = (mask.width() as usize, mask.height() as usize);
    let src: Vec<u8> = mask.pixels().map(|p| p[0]).collect();
    let pass1 = box_blur(&src, w, h, radius as usize, true);
    let pass2 = box_blur(&pass1, w, h, radius as usize, false);
    GrayImage::from_fn(mask.width(), mask.height(), |x, y| {
        Luma([pass2[y as usize * w + x as usize]])
    })
}

/// 按蒙版（白 = 替换）把 `fill` 合成到 `base` 上；蒙版外的像素保持原样。
pub fn composite(
    base: &DynamicImage,
    mask: &GrayImage,
    fill: &BackgroundFill,
    feather_radius: u32,
) -> DynamicImage {
    let (w, h) = (base.width(), base.height());
    let mask = if mask.width() == w && mask.height() == h {
        mask.clone()
    } else {
        DynamicImage::ImageLuma8(mask.clone())
            .resize_exact(w, h, image::imageops::FilterType::Nearest)
            .to_luma8()
    };
    let mask = feather(&mask, feather_radius);
    let mut out = base.to_rgba8();
    for (x, y, px) in out.enumerate_pixels_mut() {
        let a = mask.get_pixel(x, y)[0] as f32 / 255.0;
        if a <= 0.0 {
            continue;
        }
        let c = fill.color_at(x, y, w, h);
        px[0] = (px[0] as f32 * (1.0 - a) + c[0] as f32 * a).round() as u8;
        px[1] = (px[1] as f32 * (1.0 - a) + c[1] as f32 * a).round() as u8;
        px[2] = (px[2] as f32 * (1.0 - a) + c[2] as f32 * a).round() as u8;
    }
    DynamicImage::ImageRgba8(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::RgbaImage;

    fn solid_base(w: u32, h: u32, rgba: [u8; 4]) -> DynamicImage {
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(w, h, image::Rgba(rgba)))
    }

    fn mask_of(w: u32, h: u32, f: impl Fn(u32, u32) -> u8) -> GrayImage {
        GrayImage::from_fn(w, h, |x, y| Luma([f(x, y)]))
    }

    #[test]
    fn parse_hex_accepts_and_rejects() {
        assert_eq!(parse_hex("#12ab34").unwrap(), [0x12, 0xab, 0x34]);
        assert_eq!(parse_hex("ffffff").unwrap(), [255, 255, 255]);
        assert!(parse_hex("#12345").is_err());
        assert!(parse_hex("red").is_err());
    }

    #[test]
    fn solid_fills_whole_mask() {
        let base = solid_base(4, 4, [255, 0, 0, 255]);
        let mask = mask_of(4, 4, |_, _| 255);
        let out = composite(&base, &mask, &BackgroundFill::Solid([0, 0, 255]), 0);
        let rgba = out.to_rgba8();
        for p in rgba.pixels() {
            assert_eq!(p.0, [0, 0, 255, 255]);
        }
    }

    #[test]
    fn pixels_outside_mask_stay_untouched() {
        let base = solid_base(8, 4, [255, 0, 0, 255]);
        // 左半白（替换），右半黑（保留）
        let mask = mask_of(8, 4, |x, _| if x < 4 { 255 } else { 0 });
        let out = composite(&base, &mask, &BackgroundFill::Solid([0, 255, 0]), 2);
        let rgba = out.to_rgba8();
        assert_eq!(rgba.get_pixel(0, 0).0, [0, 255, 0, 255]);
        assert_eq!(rgba.get_pixel(7, 3).0, [255, 0, 0, 255]);
    }

    #[test]
    fn gradient_runs_left_to_right() {
        let base = solid_base(5, 2, [0, 0, 0, 255]);
        let mask = mask_of(5, 2, |_, _| 255);
        let out = composite(
            &base,
            &mask,
            &BackgroundFill::Gradient {
                from: [0, 0, 0],
                to: [255, 255, 255],
                direction: GradientDirection::Horizontal,
            },
            0,
        );
        let rgba = out.to_rgba8();
        let v: Vec<u8> = (0..5).map(|x| rgba.get_pixel(x, 0)[0]).collect();
        assert_eq!(v[0], 0);
        assert_eq!(v[4], 255);
        assert!(v.windows(2).all(|w| w[0] <= w[1]), "{v:?}");
    }

    #[test]
    fn gradient_runs_top_to_bottom() {
        let base = solid_base(2, 5, [0, 0, 0, 255]);
        let mask = mask_of(2, 5, |_, _| 255);
        let out = composite(
            &base,
            &mask,
            &BackgroundFill::Gradient {
                from: [0, 0, 0],
                to: [255, 255, 255],
                direction: GradientDirection::Vertical,
            },
            0,
        );
        let rgba = out.to_rgba8();
        assert_eq!(rgba.get_pixel(0, 0)[0], 0);
        assert_eq!(rgba.get_pixel(1, 4)[0], 255);
        assert!(rgba.get_pixel(0, 2)[0] > rgba.get_pixel(0, 1)[0]);
    }

    #[test]
    fn feather_softens_hard_edge() {
        let base = solid_base(9, 1, [0, 0, 0, 255]);
        let mask = mask_of(9, 1, |x, _| if x >= 4 { 255 } else { 0 });
        let hard = composite(&base, &mask, &BackgroundFill::Solid([255, 255, 255]), 0);
        let soft = composite(&base, &mask, &BackgroundFill::Solid([255, 255, 255]), 2);
        let h = hard.to_rgba8();
        let s = soft.to_rgba8();
        assert_eq!(h.get_pixel(4, 0)[0], 255);
        // 羽化后边界不再是纯色，但仍偏向新背景
        let v = s.get_pixel(4, 0)[0];
        assert!(v > 0 && v < 255, "feather value {v}");
        assert!(v > 100, "feather value {v}");
        // 远端像素不受羽化影响
        assert_eq!(s.get_pixel(0, 0)[0], 0);
    }

    #[test]
    fn mask_resized_to_base_dimensions() {
        let base = solid_base(6, 6, [0, 0, 0, 255]);
        let mask = mask_of(2, 2, |_, _| 255);
        let out = composite(&base, &mask, &BackgroundFill::Solid([9, 9, 9]), 0);
        assert_eq!(out.to_rgba8().get_pixel(5, 5)[0], 9);
    }

    #[test]
    fn mask_region_detection_handles_both_conventions() {
        // 白底黑图：没有涂抹
        let empty_luma = DynamicImage::ImageLuma8(mask_of(4, 4, |_, _| 0));
        assert!(!luma_has_region(&empty_luma));
        let painted_luma =
            DynamicImage::ImageLuma8(mask_of(4, 4, |x, _| if x == 2 { 255 } else { 0 }));
        assert!(luma_has_region(&painted_luma));

        // 黑底不透明：没有涂抹；有透明孔即视为涂抹过
        let opaque =
            DynamicImage::ImageRgba8(RgbaImage::from_pixel(4, 4, image::Rgba([0, 0, 0, 255])));
        assert!(!alpha_has_region(&opaque));
        let mut holed = RgbaImage::from_pixel(4, 4, image::Rgba([0, 0, 0, 255]));
        holed.put_pixel(1, 1, image::Rgba([0, 0, 0, 0]));
        assert!(alpha_has_region(&DynamicImage::ImageRgba8(holed)));
    }

    #[test]
    fn ai_prompt_carries_prefix() {
        let p = background_ai_prompt("  星空下的城市  ");
        assert!(p.starts_with("Replace the masked background with:"));
        assert!(p.ends_with("星空下的城市"), "{p}");
    }
}
