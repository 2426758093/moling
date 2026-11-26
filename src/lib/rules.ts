/** 生成 / 编辑参数规则的唯一来源（与 src-tauri/src/rules.rs 一一对应）。 */

/** 生成最小边长：对齐尺寸滑杆下限 */
export const GEN_SIZE_MIN = 512;
/** 单边上限：也是画布输出上限 */
export const SIZE_MAX = 4096;
/** 尺寸吸附步长：服务商常见的 8 对齐要求 */
export const SIZE_STEP = 8;
/** 单次生成张数上限 */
export const COUNT_MAX = 4;
/** 参考图上限 */
export const REFERENCE_MAX = 4;

/** 动图帧数 2–16 */
export const GIF_FRAME_MIN = 2;
export const GIF_FRAME_MAX = 16;
export const GIF_FRAME_DEFAULT = 9;
/** 每帧时长（毫秒），20–2000 且 10ms 取整 */
export const GIF_FRAME_MS_MIN = 20;
export const GIF_FRAME_MS_MAX = 2000;
export const GIF_FRAME_MS_DEFAULT = 200;

/** 生成尺寸吸附：先夹到 [GEN_SIZE_MIN, SIZE_MAX]，再按 SIZE_STEP 四舍五入，最后再夹一次 */
export function snapGenerationSize(n: number): number {
  const clamped = Math.min(SIZE_MAX, Math.max(GEN_SIZE_MIN, n));
  const snapped = Math.round(clamped / SIZE_STEP) * SIZE_STEP;
  return Math.min(SIZE_MAX, Math.max(GEN_SIZE_MIN, snapped));
}
