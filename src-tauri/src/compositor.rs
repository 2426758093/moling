use crate::background;
use image::{GrayImage, Luma, RgbaImage};

/// 一层合成输入：图像已是 RGBA，蒙版为 luma（255 = 完全显示）
pub struct LayerInput {
    pub image: RgbaImage,
    pub mask: Option<GrayImage>,
    pub feather: u32,
    pub opacity: f32,
}

/// alpha-hole 蒙版 → luma 蒙版：透明像素（画过的区域）= 255。
/// 分区重绘与单次 inpaint 都用 alpha-hole 口径，合成前统一换算。
pub fn mask_from_alpha(img: &RgbaImage) -> GrayImage {
    GrayImage::from_fn(img.width(), img.height(), |x, y| {
        Luma([255u8.saturating_sub(img.get_pixel(x, y)[3])])
    })
}

/// 自底向上 source-over 合成；`base` 不被修改。
///
/// `a = (src.a/255) * (maskLuma/255) * opacity`，
/// `out = src*a + dst*(1-a)`，输出 alpha 同样按 source-over 累积。
pub fn compose(base: &RgbaImage, layers: &[LayerInput]) -> RgbaImage {
    let (w, h) = base.dimensions();
    let mut out = base.clone();
    for layer in layers {
        if layer.opacity <= 0.0 {
            continue;
        }
        let src = if layer.image.dimensions() != (w, h) {
            tracing::warn!(
                "图层尺寸 {}x{} 与基准 {}x{} 不一致，按 Lanczos3 缩放",
                layer.image.width(),
                layer.image.height(),
                w,
                h
            );
            image::imageops::resize(&layer.image, w, h, image::imageops::FilterType::Lanczos3)
        } else {
            layer.image.clone()
        };
        let mask = layer.mask.as_ref().map(|m| {
            let mask = if m.dimensions() != (w, h) {
                image::imageops::resize(m, w, h, image::imageops::FilterType::Nearest)
            } else {
                m.clone()
            };
            background::feather(&mask, layer.feather)
        });
        blend(&mut out, &src, mask.as_ref(), layer.opacity);
    }
    out
}

/// 单层叠加（蒙版为 None 时整层生效）
pub fn blend(dst: &mut RgbaImage, src: &RgbaImage, mask: Option<&GrayImage>, opacity: f32) {
    let opacity = opacity.clamp(0.0, 1.0);
    if opacity <= 0.0 {
        return;
    }
    for (x, y, s) in src.enumerate_pixels() {
        let m = mask
            .map(|m| m.get_pixel(x, y)[0] as f32 / 255.0)
            .unwrap_or(1.0);
        let a = (s[3] as f32 / 255.0) * m * opacity;
        if a <= 0.0 {
            continue;
        }
        let d = dst.get_pixel_mut(x, y);
        for i in 0..3 {
            d[i] = (s[i] as f32 * a + d[i] as f32 * (1.0 - a))
                .round()
                .clamp(0.0, 255.0) as u8;
        }
        let da = d[3] as f32 / 255.0;
        d[3] = ((a + da * (1.0 - a)) * 255.0).round().clamp(0.0, 255.0) as u8;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn solid(w: u32, h: u32, px: [u8; 4]) -> RgbaImage {
        RgbaImage::from_pixel(w, h, Rgba(px))
    }

    fn layer(img: RgbaImage, opacity: f32) -> LayerInput {
        LayerInput {
            image: img,
            mask: None,
            feather: 0,
            opacity,
        }
    }

    #[test]
    fn opacity_zero_keeps_base_and_one_replaces_it() {
        let base = solid(2, 2, [10, 20, 30, 255]);
        let top = solid(2, 2, [200, 100, 50, 255]);
        let hidden = compose(&base, &[layer(top.clone(), 0.0)]);
        assert_eq!(hidden.get_pixel(0, 0)[0], 10);
        let full = compose(&base, &[layer(top, 1.0)]);
        assert_eq!(full.get_pixel(0, 0), &Rgba([200, 100, 50, 255]));
    }

    #[test]
    fn mask_outside_stays_untouched() {
        let base = solid(4, 4, [0, 0, 0, 255]);
        let top = solid(4, 4, [255, 255, 255, 255]);
        let mask = GrayImage::from_fn(4, 4, |x, _| Luma([if x < 2 { 255 } else { 0 }]));
        let out = compose(
            &base,
            &[LayerInput {
                image: top,
                mask: Some(mask),
                feather: 0,
                opacity: 1.0,
            }],
        );
        assert_eq!(out.get_pixel(0, 0)[0], 255);
        assert_eq!(out.get_pixel(3, 0)[0], 0);
    }

    #[test]
    fn feather_softens_mask_edge() {
        let base = solid(16, 1, [0, 0, 0, 255]);
        let top = solid(16, 1, [255, 255, 255, 255]);
        let mask = GrayImage::from_fn(16, 1, |x, _| Luma([if x >= 8 { 255 } else { 0 }]));
        let out = compose(
            &base,
            &[LayerInput {
                image: top,
                mask: Some(mask),
                feather: 2,
                opacity: 1.0,
            }],
        );
        let edge = out.get_pixel(8, 0)[0];
        assert!(edge > 0 && edge < 255, "羽化边缘应为中间值，实际 {edge}");
    }

    #[test]
    fn layers_apply_bottom_to_top() {
        let base = solid(1, 1, [0, 0, 0, 255]);
        let mid = solid(1, 1, [0, 255, 0, 255]);
        let top = solid(1, 1, [0, 0, 255, 255]);
        let out = compose(&base, &[layer(mid, 1.0), layer(top, 1.0)]);
        assert_eq!(out.get_pixel(0, 0), &Rgba([0, 0, 255, 255]));
    }

    #[test]
    fn mask_from_alpha_inverts_transparency() {
        let img = RgbaImage::from_pixel(2, 1, Rgba([0, 0, 0, 0]));
        assert_eq!(mask_from_alpha(&img).get_pixel(0, 0)[0], 255);
        let opaque = RgbaImage::from_pixel(2, 1, Rgba([9, 9, 9, 255]));
        assert_eq!(mask_from_alpha(&opaque).get_pixel(0, 0)[0], 0);
    }

    #[test]
    fn mismatched_size_is_scaled() {
        let base = solid(4, 4, [0, 0, 0, 255]);
        let top = solid(2, 2, [255, 255, 255, 255]);
        let out = compose(&base, &[layer(top, 1.0)]);
        assert_eq!(out.dimensions(), (4, 4));
        assert_eq!(out.get_pixel(3, 3)[0], 255);
    }
}
