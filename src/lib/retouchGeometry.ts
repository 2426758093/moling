// 扩图与裁剪的比例几何：纯函数，不碰 DOM，也不做业务判断。
// 全部按「像素整数」返回：扩图只放大不加黑边，裁剪取最大居中框。

import type { PixelSize } from "./retouchActions";

export type OutpaintRatio =
  "original" | "1:1" | "4:3" | "3:4" | "16:9" | "9:16";
export type CropRatio = OutpaintRatio;

/** 比例文案：都是可直接 t() 的中文 key */
export type RatioLabel = "原始" | "1:1" | "4:3" | "3:4" | "16:9" | "9:16";

export interface RatioOption<T extends string> {
  id: T;
  /** 中文即 i18n key，调用方 t() 后渲染 */
  label: RatioLabel;
  /** null = 保持原始比例 */
  aspect: number | null;
}

export const OUTPAINT_RATIOS: RatioOption<OutpaintRatio>[] = [
  { id: "original", label: "原始", aspect: null },
  { id: "1:1", label: "1:1", aspect: 1 },
  { id: "4:3", label: "4:3", aspect: 4 / 3 },
  { id: "3:4", label: "3:4", aspect: 3 / 4 },
  { id: "16:9", label: "16:9", aspect: 16 / 9 },
  { id: "9:16", label: "9:16", aspect: 9 / 16 },
];

export const CROP_RATIOS: RatioOption<CropRatio>[] = OUTPAINT_RATIOS;

/** 单个维度兜底：非有限 / ≤0 一律当 1，绝不返回 0 */
function safeDim(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 1;
  }
  return Math.max(1, Math.round(value));
}

function safeSize(size: PixelSize): PixelSize {
  return { width: safeDim(size?.width), height: safeDim(size?.height) };
}

function ratioAspect(ratio: OutpaintRatio): number | null {
  return OUTPAINT_RATIOS.find((option) => option.id === ratio)?.aspect ?? null;
}

/** 目标画布尺寸：只放大不加黑边；宽高至少与输入相同 */
export function outpaintTargetSize(
  size: PixelSize,
  ratio: OutpaintRatio,
): PixelSize {
  const base = safeSize(size);
  const aspect = ratioAspect(ratio);
  if (aspect == null) return base;
  if (base.width / base.height > aspect) {
    // 当前更宽：宽度不动，上下补到目标比例
    return {
      width: base.width,
      height: Math.max(base.height, Math.round(base.width / aspect)),
    };
  }
  // 当前更高（或正好相等）：高度不动，左右补到目标比例
  return {
    width: Math.max(base.width, Math.round(base.height * aspect)),
    height: base.height,
  };
}

/** 原图在目标画布里的居中偏移（像素） */
export function outpaintOffsets(
  size: PixelSize,
  target: PixelSize,
): { x: number; y: number } {
  const base = safeSize(size);
  const box = safeSize(target);
  // 居中取整用 floor：多出的那一像素留给右侧 / 下侧，和画布绘制口径一致
  return {
    x: Math.floor((box.width - base.width) / 2),
    y: Math.floor((box.height - base.height) / 2),
  };
}

/** 目标比例的最大居中裁剪框（变换后坐标系：旋转/翻转之后的画布） */
export function cropRectForRatio(
  size: PixelSize,
  ratio: CropRatio,
): { x: number; y: number; width: number; height: number } {
  const base = safeSize(size);
  const aspect = ratioAspect(ratio);
  if (aspect == null) {
    return { x: 0, y: 0, width: base.width, height: base.height };
  }
  const width =
    base.width / base.height > aspect
      ? Math.max(1, Math.round(base.height * aspect))
      : base.width;
  const height =
    base.width / base.height > aspect
      ? base.height
      : Math.max(1, Math.round(base.width / aspect));
  return {
    x: Math.floor((base.width - width) / 2),
    y: Math.floor((base.height - height) / 2),
    width,
    height,
  };
}
