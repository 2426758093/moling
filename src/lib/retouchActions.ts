// 修图台的动作表与门禁：只描述「能不能点、为什么不能点、点下去算什么参数」。
// 本地动作不依赖任何服务商，即使完全离线也必须可点 —— 这是 v2.1.0 的底线。

import type { RetouchAnalysis, RetouchOp, RetouchSuggestion } from "./api";

export type RetouchActionId =
  | "auto"
  | "beauty"
  | "erase"
  | "instruction"
  | "background"
  | "upscale"
  | "outpaint"
  | "crop"
  | "style"
  | "inpaint"
  | "region";

/** 动作 Chip 文案（中文即 i18n key，调用方 t() 后再渲染） */
export type RetouchActionLabel =
  | "一键优化"
  | "美颜"
  | "AI 消除"
  | "一句话改图"
  | "换背景"
  | "高清"
  | "扩图"
  | "裁剪调色"
  | "风格"
  | "局部重绘"
  | "多区域";

/** 步骤条文案：首帧是原图，之后每一步都用动作名；血统里认不出的 op 记作「编辑」 */
export type RetouchStepLabel = RetouchActionLabel | "原图" | "编辑";

/** 简单模式只放常用动作；专家模式补上重活（计划 §7.3） */
export type RetouchActionTier = "simple" | "expert";

/**
 * 禁用原因全集：数组即来源，`RetouchGateReason` 由它推导 —— 新增原因时
 * 必须同时进数组，i18n 测试才能保证英文键不漏。
 */
export const RETOUCH_GATE_REASONS = [
  "动图暂不支持修图",
  "当前离线",
  "请先在设置中配置服务商",
  "请先在设置中选择默认模型",
  "当前模型不支持指令改图",
  "当前模型不支持局部编辑",
] as const;

export type RetouchGateReason = (typeof RETOUCH_GATE_REASONS)[number];

export interface RetouchGateCtx {
  hasProvider: boolean;
  hasModel: boolean;
  /** 模型支持一句话指令改图 */
  instructionEdit: boolean;
  /** 模型支持局部编辑（带蒙版） */
  edit: boolean;
  isGif: boolean;
  online: boolean;
}

export interface RetouchActionDef {
  id: RetouchActionId;
  /** 中文键，调用方 t() 后使用 */
  label: RetouchActionLabel;
  /** 这个动作可能调用服务商计费（门禁另有口径，见 isLocalRetouchAction） */
  cloud: boolean;
  tier: RetouchActionTier;
}

export const RETOUCH_ACTIONS: RetouchActionDef[] = [
  { id: "auto", label: "一键优化", cloud: false, tier: "simple" },
  { id: "beauty", label: "美颜", cloud: false, tier: "simple" },
  { id: "erase", label: "AI 消除", cloud: true, tier: "simple" },
  { id: "instruction", label: "一句话改图", cloud: true, tier: "simple" },
  { id: "background", label: "换背景", cloud: false, tier: "simple" },
  { id: "upscale", label: "高清", cloud: true, tier: "simple" },
  { id: "outpaint", label: "扩图", cloud: true, tier: "expert" },
  { id: "crop", label: "裁剪调色", cloud: false, tier: "expert" },
  { id: "style", label: "风格", cloud: true, tier: "expert" },
  { id: "inpaint", label: "局部重绘", cloud: true, tier: "expert" },
  { id: "region", label: "多区域", cloud: true, tier: "expert" },
];

/// 重开应用时从历史血统还原步骤：`op` 是 Rust 侧写的动作标签
/// （见 `retouch::history_op`）。首帧固定「原图」，认不出的 op 记作「编辑」。
export function stepLabelForOp(op: string, index: number): RetouchStepLabel {
  if (index === 0) return "原图";
  switch (op) {
    case "auto-enhance":
      return "一键优化";
    case "beauty":
      return "美颜";
    case "erase":
      return "AI 消除";
    case "retouch":
      return "一句话改图";
    case "background":
      return "换背景";
    case "upscale":
      return "高清";
    case "style":
      return "风格";
    case "outpaint":
      return "扩图";
    case "basic-edit":
      return "裁剪调色";
    case "region-edit":
      return "多区域";
    default:
      return "编辑";
  }
}

/** 简单模式下的默认参数：不给滑杆，也不给第二种可能 */
export const DEFAULT_AUTO_STRENGTH = 1;
export const DEFAULT_BEAUTY_AMOUNT = 0.6;
/** 美颜固定带一点锐化，抵消磨皮后的发糊 */
export const BEAUTY_SHARPEN_AMOUNT = 0.25;

/**
 * 门禁与「不需要服务商」的动作：一键优化 / 美颜 / 换背景 / 裁剪调色。
 * 换背景的纯色与渐变是本地合成，离线也必须可用。
 */
const FREE_ACTIONS = new Set<RetouchActionId>([
  "auto",
  "beauty",
  "background",
  "crop",
]);

export function isLocalRetouchAction(id: RetouchActionId): boolean {
  return FREE_ACTIONS.has(id);
}

/** 云结果尺寸必须现场实测的动作（背景/裁剪的返回里自带宽高，不用测） */
export function isCloudRetouchAction(id: RetouchActionId): boolean {
  return !isLocalRetouchAction(id);
}

/** 这次提交有没有可能扣费：本地动作（含纯色/渐变换背景）为 false */
export function mayBillRetouchAction(id: RetouchActionId): boolean {
  return id !== "auto" && id !== "beauty" && id !== "crop";
}

/** 像素尺寸：一律是原图自然宽高 */
export interface PixelSize {
  width: number;
  height: number;
}

function positiveDim(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.round(value);
}

/// 云端编辑要报给服务商的输入尺寸：优先步骤记录，其次现场解码结果。
/// 两处都拿不到就返回 null —— 调用方必须拒绝提交，绝不能发 0×0。
///
/// `preferMeasured`：历史行记下的尺寸是「入库时」的，EXIF 摆正之前的旧记录
/// 会是横竖颠倒的一对数字；此时以现场解码出来的真实尺寸为准，否则蒙版会错位。
export function resolveEditInputSize(
  step: { width?: number; height?: number },
  measured: PixelSize | null,
  preferMeasured = false,
): PixelSize | null {
  const stepWidth = positiveDim(step.width);
  const stepHeight = positiveDim(step.height);
  const stored =
    stepWidth != null && stepHeight != null
      ? { width: stepWidth, height: stepHeight }
      : null;
  const measuredWidth = positiveDim(measured?.width);
  const measuredHeight = positiveDim(measured?.height);
  const live =
    measuredWidth != null && measuredHeight != null
      ? { width: measuredWidth, height: measuredHeight }
      : null;
  if (preferMeasured && live) {
    // 两者一致时没差别；不一致时信实测（旧记录未摆正）；stored 缺失就是 live
    return stored
      ? stored.width === live.width && stored.height === live.height
        ? stored
        : live
      : live;
  }
  return stored ?? live;
}

/// 新步骤的尺寸只写「结果图的真实尺寸」；量不到就留空。
/// 拿输入尺寸冒充结果尺寸会让后续蒙版按错误分辨率导出。
export function outputStepDims(measured: PixelSize | null): {
  width?: number;
  height?: number;
} {
  const width = positiveDim(measured?.width);
  const height = positiveDim(measured?.height);
  return width != null && height != null ? { width, height } : {};
}

/// 返回 null 表示可用；否则返回禁用原因（顺序即优先级）。
export function retouchActionReason(
  id: RetouchActionId,
  ctx: RetouchGateCtx,
): RetouchGateReason | null {
  // 动图连本地修都不做：逐帧语义丢了，改完只剩首帧
  if (ctx.isGif) return "动图暂不支持修图";
  if (isLocalRetouchAction(id)) return null;
  if (!ctx.online) return "当前离线";
  if (!ctx.hasProvider) return "请先在设置中配置服务商";
  if (!ctx.hasModel) return "请先在设置中选择默认模型";
  if (id === "instruction") {
    return ctx.instructionEdit ? null : "当前模型不支持指令改图";
  }
  if (id === "erase" || id === "inpaint" || id === "region") {
    return ctx.edit ? null : "当前模型不支持局部编辑";
  }
  // upscale / outpaint / style：沿用 TransformDialog 的口径，不额外要求 transform cap
  return null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 一键优化的 ops：只改色彩，strength 归一化到 0–1 */
export function autoOps(strength: number): RetouchOp[] {
  return [{ type: "autoEnhance", strength: clamp01(strength) }];
}

/** 美颜的 ops：磨皮 + 固定锐化，两步都跑在本地 */
export function beautyOps(amount: number): RetouchOp[] {
  return [
    { type: "skinSmooth", amount: clamp01(amount) },
    { type: "sharpen", amount: BEAUTY_SHARPEN_AMOUNT },
  ];
}

/** 专家模式的分析建议文案（方向由数值符号决定） */
export const RETOUCH_SUGGESTION_TEXTS = [
  "偏暗",
  "偏亮",
  "偏暖",
  "偏冷",
  "对比偏低",
  "色彩偏淡",
  "检测到人像",
  "有过曝或死黑",
] as const;

export type RetouchSuggestionText = (typeof RETOUCH_SUGGESTION_TEXTS)[number];

export function analysisSuggestionText(
  suggestion: RetouchSuggestion,
  analysis: Pick<RetouchAnalysis, "exposureEv" | "wbCast">,
): RetouchSuggestionText {
  switch (suggestion) {
    case "exposure":
      // 后端约定 exposureEv > 0 = 需要提亮，也就是图偏暗
      return analysis.exposureEv >= 0 ? "偏暗" : "偏亮";
    case "whiteBalance":
      // wbCast > 0 = 红多，画面偏暖
      return analysis.wbCast >= 0 ? "偏暖" : "偏冷";
    case "contrast":
      return "对比偏低";
    case "saturation":
      return "色彩偏淡";
    case "skin":
      return "检测到人像";
    case "clipping":
      return "有过曝或死黑";
    default:
      return "色彩偏淡";
  }
}
