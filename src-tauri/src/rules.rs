//! 生成 / 编辑参数规则的唯一来源。
//!
//! 生成与编辑的最小尺寸不同：生成 UI 下限 512（与前端尺寸滑杆一致），
//! 编辑 / 扩图下限 64（兼容窄边与被编辑的小图）。两条路径都从这里取常量，
//! 避免 commands 层各写一份而逐渐漂移。

/// 生成（含队列）最小边长：对齐前端生成尺寸滑杆的下限
pub const GEN_SIZE_MIN: u32 = 512;
/// 编辑 / 扩图 / 基础编辑最小边长：允许窄边与小尺寸源图
pub const EDIT_SIZE_MIN: u32 = 64;
/// 单边上限：也是画布输出上限
pub const SIZE_MAX: u32 = 4096;
/// 尺寸吸附步长：服务商常见的 8 对齐要求
pub const SIZE_STEP: u32 = 8;
/// 单次生成张数上限：与前端张数滑杆同口径
pub const COUNT_MAX: u32 = 4;
/// 参考图上限：上传 / 拖拽 / 引用图三个入口共用的后端兜底
pub const REFERENCE_MAX: usize = 4;
/// 动图帧数下限
pub const GIF_FRAME_MIN: u32 = 2;
/// 动图帧数默认上限（与前端滑杆一致；后端可按模型能力放宽）
pub const GIF_FRAME_MAX: u32 = 16;
/// 每帧时长下限（毫秒）
pub const GIF_MS_MIN: u32 = 20;
/// 每帧时长上限（毫秒）
pub const GIF_MS_MAX: u32 = 2000;

/// 先夹到区间再吸附到 [`SIZE_STEP`] 的倍数：顺序不能反，否则 4097 先吸附
/// 会变成 4104 再被夹回 4096，与前端 round 口径不一致。
pub fn snap_size(n: u32, min: u32) -> u32 {
    let clamped = n.clamp(min, SIZE_MAX);
    let snapped = (clamped + SIZE_STEP / 2) / SIZE_STEP * SIZE_STEP;
    snapped.clamp(min, SIZE_MAX)
}

/// 张数归一化：0 张与超大值都夹到 1–[`COUNT_MAX`]
pub fn clamp_count(n: u32) -> u32 {
    n.clamp(1, COUNT_MAX)
}

// 区间自检：跨端共享的常量一旦被改坏，编译期直接报错
const _: () = assert!(EDIT_SIZE_MIN > 0 && GEN_SIZE_MIN >= EDIT_SIZE_MIN);
const _: () = assert!(SIZE_MAX > GEN_SIZE_MIN);
const _: () = assert!(SIZE_STEP > 0 && SIZE_MAX.is_multiple_of(SIZE_STEP));
const _: () = assert!(COUNT_MAX >= 1 && REFERENCE_MAX >= 1);
const _: () = assert!(GIF_FRAME_MIN < GIF_FRAME_MAX);
const _: () = assert!(GIF_MS_MIN < GIF_MS_MAX);

#[cfg(test)]
mod tests {
    use super::*;

    /// 吸附：先夹区间再对齐 8，两个上下文的最小尺寸各自生效
    #[test]
    fn snap_size_snaps_with_context_min() {
        assert_eq!(snap_size(0, GEN_SIZE_MIN), 512);
        assert_eq!(snap_size(1, GEN_SIZE_MIN), 512);
        assert_eq!(snap_size(0, EDIT_SIZE_MIN), 64);
        assert_eq!(snap_size(1, EDIT_SIZE_MIN), 64);
        assert_eq!(snap_size(65, EDIT_SIZE_MIN), 64);
        assert_eq!(snap_size(100, EDIT_SIZE_MIN), 104);
        assert_eq!(snap_size(1024, GEN_SIZE_MIN), 1024);
        // 4090 就近吸附到 4088（与前端 round 口径一致）
        assert_eq!(snap_size(4090, GEN_SIZE_MIN), 4088);
        assert_eq!(snap_size(4097, GEN_SIZE_MIN), SIZE_MAX);
        assert_eq!(snap_size(u32::MAX, EDIT_SIZE_MIN), SIZE_MAX);
    }

    /// 结果永远是 8 的倍数且落在 [min, SIZE_MAX]，0 / 超大值都不会透传
    #[test]
    fn snap_size_always_in_range_and_aligned() {
        for min in [GEN_SIZE_MIN, EDIT_SIZE_MIN] {
            for n in [
                0,
                1,
                7,
                8,
                63,
                64,
                65,
                100,
                511,
                512,
                1001,
                4095,
                4096,
                5000,
                u32::MAX,
            ] {
                let v = snap_size(n, min);
                assert_eq!(v % SIZE_STEP, 0, "{n} -> {v} 不是 8 的倍数");
                assert!((min..=SIZE_MAX).contains(&v), "{n} -> {v} 越界");
            }
        }
    }

    /// 张数：0 / 越界都收敛到 1–4
    #[test]
    fn clamp_count_bounds() {
        assert_eq!(clamp_count(0), 1);
        assert_eq!(clamp_count(1), 1);
        assert_eq!(clamp_count(COUNT_MAX), COUNT_MAX);
        assert_eq!(clamp_count(COUNT_MAX + 1), COUNT_MAX);
        assert_eq!(clamp_count(u32::MAX), COUNT_MAX);
    }

    /// 动图区间 / 参考图上限与前端 rules.ts 一致
    #[test]
    fn shared_bounds_match_frontend() {
        assert_eq!((GIF_FRAME_MIN, GIF_FRAME_MAX), (2, 16));
        assert_eq!((GIF_MS_MIN, GIF_MS_MAX), (20, 2000));
        assert_eq!(REFERENCE_MAX, 4);
        assert_eq!((GEN_SIZE_MIN, EDIT_SIZE_MIN, SIZE_MAX), (512, 64, 4096));
        assert_eq!(COUNT_MAX, 4);
    }
}
