//! 本地修图引擎：分析 + LUT 自动增强 + 肤色蒙版磨皮，全部纯本地确定性运算。
//!
//! 与基础编辑（裁剪 / 旋转）不同，这里的操作只改像素色彩、不改尺寸，
//! 因此可以在前端反复下发做实时预览，确认后才落一次盘。

pub mod analysis;
pub mod enhance;
pub mod portrait;

use image::DynamicImage;

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RetouchOp {
    /// 0..=1
    AutoEnhance { strength: f32 },
    /// -1..=1
    WhiteBalance { temp: f32, tint: f32 },
    /// -1..=1
    ToneCurve {
        contrast: f32,
        brightness: f32,
        saturation: f32,
    },
    /// 0..=1
    SkinSmooth { amount: f32 },
    /// 0..=1
    Sharpen { amount: f32 },
    /// 0..=1
    Denoise { amount: f32 },
}

/// 参数全部按 0..=1 处理：非法输入（NaN / 越界）不报错，落到最近边界
pub(crate) fn clamp01(v: f32) -> f32 {
    if v.is_finite() {
        v.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

/// 参数全部按 -1..=1 处理
pub(crate) fn clamp_unit(v: f32) -> f32 {
    if v.is_finite() {
        v.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

/// BT.709 亮度，入参是 0..=255 的通道值
pub(crate) fn luma(r: f32, g: f32, b: f32) -> f32 {
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

/// 四舍五入并夹到 0..=255
pub(crate) fn round_u8(v: f32) -> u8 {
    v.round().clamp(0.0, 255.0) as u8
}

/// 肤色判定：BT.601 色度 Cb 77..=127 / Cr 133..=173 且亮度 > 40。
///
/// 分析统计与磨皮蒙版共用这一份口径，两处任何一处改阈值都会同步，
/// 不会出现「分析说这是肤色、磨皮却不动」的漂移。
pub(crate) fn is_skin(r: f32, g: f32, b: f32) -> bool {
    let cb = 128.0 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    let cr = 128.0 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    (77.0..=127.0).contains(&cb) && (133.0..=173.0).contains(&cr) && luma(r, g, b) > 40.0
}

/// 依次应用；AutoEnhance 使用传入的分析结果（None 时按当前像素现算一次并缓存）。
/// 所有参数进来先 clamp，非法值不报错，按边界处理。
pub fn apply_ops(
    mut img: DynamicImage,
    ops: &[RetouchOp],
    analysis: Option<&analysis::RetouchAnalysis>,
) -> Result<DynamicImage, String> {
    let mut computed: Option<analysis::RetouchAnalysis> = None;
    for op in ops {
        match op {
            RetouchOp::AutoEnhance { strength } => {
                let a = match analysis {
                    Some(a) => a,
                    None => computed.get_or_insert_with(|| analysis::analyze(&img)),
                };
                img = enhance::auto_enhance(img, a, clamp01(*strength));
            }
            RetouchOp::WhiteBalance { temp, tint } => {
                img = enhance::white_balance(img, clamp_unit(*temp), clamp_unit(*tint));
            }
            RetouchOp::ToneCurve {
                contrast,
                brightness,
                saturation,
            } => {
                img = enhance::tone_curve(
                    img,
                    clamp_unit(*contrast),
                    clamp_unit(*brightness),
                    clamp_unit(*saturation),
                );
            }
            RetouchOp::SkinSmooth { amount } => {
                img = portrait::skin_smooth(img, clamp01(*amount));
            }
            RetouchOp::Sharpen { amount } => {
                img = portrait::sharpen(img, clamp01(*amount));
            }
            RetouchOp::Denoise { amount } => {
                img = portrait::denoise(img, clamp01(*amount));
            }
        }
    }
    Ok(img)
}

/// 历史 op 标签：含磨皮算 beaut；只有全局调色的算 auto-enhance；其余算 retouch
pub fn history_op(ops: &[RetouchOp]) -> &'static str {
    if ops
        .iter()
        .any(|o| matches!(o, RetouchOp::SkinSmooth { .. }))
    {
        return "beauty";
    }
    let color_only = !ops.is_empty()
        && ops.iter().all(|o| {
            matches!(
                o,
                RetouchOp::AutoEnhance { .. }
                    | RetouchOp::WhiteBalance { .. }
                    | RetouchOp::ToneCurve { .. }
            )
        });
    if color_only {
        "auto-enhance"
    } else {
        "retouch"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, Rgb, RgbImage};

    fn sample(w: u32, h: u32) -> DynamicImage {
        let mut img = RgbImage::new(w, h);
        for (x, y, px) in img.enumerate_pixels_mut() {
            *px = Rgb([(x % 60 + 40) as u8, (y % 50 + 60) as u8, 90]);
        }
        DynamicImage::ImageRgb8(img)
    }

    #[test]
    fn op_json_roundtrip_is_camel_case() {
        let json = r#"{"type":"autoEnhance","strength":0.8}"#;
        let op: RetouchOp = serde_json::from_str(json).expect("camelCase 反序列化");
        assert_eq!(op, RetouchOp::AutoEnhance { strength: 0.8 });
        assert_eq!(serde_json::to_string(&op).unwrap(), json);

        let skin: RetouchOp =
            serde_json::from_str(r#"{"type":"skinSmooth","amount":0.5}"#).expect("磨皮反序列化");
        assert_eq!(skin, RetouchOp::SkinSmooth { amount: 0.5 });
    }

    #[test]
    fn history_op_three_buckets() {
        assert_eq!(
            history_op(&[RetouchOp::AutoEnhance { strength: 1.0 }]),
            "auto-enhance"
        );
        assert_eq!(
            history_op(&[
                RetouchOp::WhiteBalance {
                    temp: 0.2,
                    tint: 0.0
                },
                RetouchOp::ToneCurve {
                    contrast: 0.1,
                    brightness: 0.0,
                    saturation: 0.0
                }
            ]),
            "auto-enhance"
        );
        assert_eq!(
            history_op(&[RetouchOp::SkinSmooth { amount: 0.7 }]),
            "beauty"
        );
        assert_eq!(
            history_op(&[
                RetouchOp::Sharpen { amount: 0.4 },
                RetouchOp::SkinSmooth { amount: 0.4 }
            ]),
            "beauty"
        );
        assert_eq!(history_op(&[RetouchOp::Denoise { amount: 0.3 }]), "retouch");
        assert_eq!(history_op(&[]), "retouch");
    }

    #[test]
    fn empty_ops_return_input_untouched() {
        let img = sample(8, 8);
        let before = img.to_rgba8().into_raw();
        let out = apply_ops(img, &[], None).expect("空 ops 不应报错");
        assert_eq!(out.to_rgba8().into_raw(), before);
    }

    #[test]
    fn apply_ops_keeps_alpha() {
        let mut rgba = image::RgbaImage::new(6, 6);
        for (x, y, px) in rgba.enumerate_pixels_mut() {
            *px = image::Rgba([120, 100, 80, (x * 20 + y) as u8]);
        }
        let before: Vec<u8> = rgba.pixels().map(|p| p[3]).collect();
        let out = apply_ops(
            DynamicImage::ImageRgba8(rgba),
            &[RetouchOp::AutoEnhance { strength: 1.0 }],
            None,
        )
        .expect("增强不应报错");
        let after: Vec<u8> = out.to_rgba8().pixels().map(|p| p[3]).collect();
        assert_eq!(before, after, "alpha 必须原样保留");
    }

    #[test]
    fn out_of_range_params_do_not_panic() {
        let out = apply_ops(
            sample(4, 4),
            &[
                RetouchOp::AutoEnhance { strength: f32::NAN },
                RetouchOp::WhiteBalance {
                    temp: 9.0,
                    tint: -9.0,
                },
                RetouchOp::ToneCurve {
                    contrast: f32::INFINITY,
                    brightness: -5.0,
                    saturation: 5.0,
                },
                RetouchOp::SkinSmooth { amount: 2.0 },
                RetouchOp::Sharpen { amount: -1.0 },
                RetouchOp::Denoise { amount: f32::NAN },
            ],
            None,
        )
        .expect("非法参数按边界处理");
        assert_eq!((out.width(), out.height()), (4, 4));
    }
}
