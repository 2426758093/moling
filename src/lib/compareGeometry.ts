// 前后对比的纯几何：抽出来是为了单测边界（0 / 100 / 宽度为 0），
// 组件里只负责把指针事件换算成这里的输入。

export type CompareMode = "slide" | "side";

/** 分隔线百分比：夹到 0–100 并取整，避免亚像素抖动 */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** 指针相对舞台左缘的偏移 → 分隔线百分比；舞台宽度为 0 时保持中点 */
export function slidePosition(offsetX: number, width: number): number {
  if (!(width > 0)) return 50;
  return clampPercent((offsetX / width) * 100);
}

/** 原图层裁切：只保留分界线左侧那部分 */
export function clipBefore(pos: number): string {
  return `inset(0 ${100 - clampPercent(pos)}% 0 0)`;
}
