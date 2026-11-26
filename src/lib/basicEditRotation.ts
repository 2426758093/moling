/// 基础编辑的旋转角工具：预览包围盒 / 自由角归一化 / 提交 ops 组装。
/// 与 Rust basic_edit 同口径，保持为纯函数，避免预览与落盘各算一套。

/** 与后端 `rotate_free` 的恒等阈值一致：小于它的自由角视为不旋转 */
export const FREE_DEG_EPSILON = 0.01;

/** 直角档：90° 的整数倍，0 表示不转 */
export type QuarterTurns = 0 | 1 | 2 | 3;

/** 裁剪框（旋转后的轴对齐画布坐标） */
export interface BasicEditCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 与 api.applyEdit 的 ops 联合类型同形（此处不依赖 api，便于单元测试） */
export type BasicEditOp =
  | { type: "crop"; x: number; y: number; width: number; height: number }
  | { type: "rotate"; deg: 90 | 180 | 270 }
  | { type: "rotateFree"; deg: number }
  | { type: "flip"; axis: "horizontal" | "vertical" }
  | {
      type: "adjust";
      brightness: number;
      contrast: number;
      saturation: number;
    };

export interface BasicEditOpsInput {
  quarterTurns: QuarterTurns;
  /** 自由角（度），正值 = 顺时针 */
  freeDeg: number;
  flipH: boolean;
  flipV: boolean;
  /** 旋转后的轴对齐画布尺寸（已按包围盒放大） */
  canvasW: number;
  canvasH: number;
  /** 当前裁剪框；null = 全图 */
  crop: BasicEditCrop | null;
  brightness: number;
  contrast: number;
  saturation: number;
}

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));

/** 自由角归一化到 (-180, 180]；非有限值按 0 处理。 */
export function normalizeFreeDeg(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const wrapped = ((deg % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

/** 按总角度计算旋转后的轴对齐包围盒，与后端 `rotate_free` 同口径。 */
export function rotationBoundingBox(
  w: number,
  h: number,
  deg: number,
): { w: number; h: number } {
  if (!Number.isFinite(deg)) return { w, h };
  const rad = (deg * Math.PI) / 180;
  const sin = Math.abs(Math.sin(rad));
  const cos = Math.abs(Math.cos(rad));
  // 减 1e-4 再向上取整：90° / 180° 的浮点残差不会多算一像素（与 Rust 一致）
  return {
    w: Math.max(1, Math.ceil(w * cos + h * sin - 1e-4)),
    h: Math.max(1, Math.ceil(w * sin + h * cos - 1e-4)),
  };
}

/** 只有真裁剪（不是全图）才生成 op，并夹到画布内。 */
function cropOp(
  crop: BasicEditCrop,
  canvasW: number,
  canvasH: number,
): BasicEditOp | null {
  const x = clamp(Math.round(crop.x), 0, Math.max(0, canvasW - 1));
  const y = clamp(Math.round(crop.y), 0, Math.max(0, canvasH - 1));
  const width = clamp(Math.round(crop.w), 1, Math.max(1, canvasW - x));
  const height = clamp(Math.round(crop.h), 1, Math.max(1, canvasH - y));
  if (x === 0 && y === 0 && width >= canvasW && height >= canvasH) return null;
  return { type: "crop", x, y, width, height };
}

/// 提交顺序：rotate → rotateFree → flip → crop（仅无自由旋转）→ adjust。
/// 自由旋转会扩大包围盒且带透明边，此时裁剪坐标失去意义，因此不下发 crop。
export function buildBasicEditOps(input: BasicEditOpsInput): BasicEditOp[] {
  const ops: BasicEditOp[] = [];
  if (input.quarterTurns !== 0) {
    ops.push({
      type: "rotate",
      deg: (input.quarterTurns * 90) as 90 | 180 | 270,
    });
  }
  const freeDeg = normalizeFreeDeg(input.freeDeg);
  const free = Math.abs(freeDeg) >= FREE_DEG_EPSILON;
  if (free) ops.push({ type: "rotateFree", deg: freeDeg });
  if (input.flipH) ops.push({ type: "flip", axis: "horizontal" });
  if (input.flipV) ops.push({ type: "flip", axis: "vertical" });
  if (!free && input.crop) {
    const op = cropOp(input.crop, input.canvasW, input.canvasH);
    if (op) ops.push(op);
  }
  if (
    input.brightness !== 0 ||
    input.contrast !== 0 ||
    input.saturation !== 0
  ) {
    ops.push({
      type: "adjust",
      brightness: input.brightness,
      contrast: input.contrast,
      saturation: input.saturation,
    });
  }
  return ops;
}
