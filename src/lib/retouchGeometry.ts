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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function safeNumber(value: number | null | undefined, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 旋转后的画布尺寸（90/270 互换宽高） */
export function rotatedSize(
  size: PixelSize,
  deg: 0 | 90 | 180 | 270,
): PixelSize {
  const base = safeSize(size);
  return deg % 180 === 0 ? base : { width: base.height, height: base.width };
}

/** 调色三项：与 BasicEditView 同口径，-100..100，0 表示不改 */
export interface ToneValues {
  brightness: number;
  contrast: number;
  saturation: number;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CropState {
  deg: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  /** 变换后坐标系（rotate/flip 之后的画布） */
  rect: CropRect;
  /** 变换后的画布尺寸，用来判断 rect 是否等于全图 */
  canvas: PixelSize;
  tone: ToneValues;
}

/** api.applyEdit 的 ops 形状（与 src/lib/api.ts 的联合类型一致） */
export type EditOp =
  | { type: "rotate"; deg: 90 | 180 | 270 }
  | { type: "flip"; axis: "horizontal" | "vertical" }
  | { type: "crop"; x: number; y: number; width: number; height: number }
  | {
      type: "adjust";
      brightness: number;
      contrast: number;
      saturation: number;
    };

/** 裁剪框取自变换后坐标：四舍五入后夹进画布，宽高至少 1（缺省即全图） */
function clampRect(
  rect: CropRect | null | undefined,
  canvas: PixelSize,
): CropRect {
  const x = clamp(
    Math.round(safeNumber(rect?.x)),
    0,
    Math.max(0, canvas.width - 1),
  );
  const y = clamp(
    Math.round(safeNumber(rect?.y)),
    0,
    Math.max(0, canvas.height - 1),
  );
  return {
    x,
    y,
    width: clamp(
      Math.round(safeNumber(rect?.width, canvas.width - x)),
      1,
      canvas.width - x,
    ),
    height: clamp(
      Math.round(safeNumber(rect?.height, canvas.height - y)),
      1,
      canvas.height - y,
    ),
  };
}

/**
 * 裁剪调色的 ops：顺序与旧 BasicEditView 一致（rotate → flipH → flipV → crop → adjust）。
 * 没变的步骤一律省略：空数组表示「什么都不用做」。
 */
export function buildCropEditOps(state: CropState): EditOp[] {
  if (!state) return [];
  const canvas = safeSize(state.canvas);
  const ops: EditOp[] = [];
  const deg =
    state.deg === 90 || state.deg === 180 || state.deg === 270 ? state.deg : 0;
  if (deg !== 0) ops.push({ type: "rotate", deg });
  if (state.flipH) ops.push({ type: "flip", axis: "horizontal" });
  if (state.flipV) ops.push({ type: "flip", axis: "vertical" });

  const rect = clampRect(state.rect, canvas);
  const full =
    rect.x === 0 &&
    rect.y === 0 &&
    rect.width === canvas.width &&
    rect.height === canvas.height;
  if (!full) ops.push({ type: "crop", ...rect });

  // 三个值原样传出（不夹取）：后端已有校验，这里再截一次等于两套口径
  const brightness = safeNumber(state.tone?.brightness);
  const contrast = safeNumber(state.tone?.contrast);
  const saturation = safeNumber(state.tone?.saturation);
  if (brightness !== 0 || contrast !== 0 || saturation !== 0) {
    ops.push({ type: "adjust", brightness, contrast, saturation });
  }
  return ops;
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
