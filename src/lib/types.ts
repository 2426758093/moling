export type ThemeMode = "system" | "light" | "dark";

/// 功能层玻璃的三档透明度偏好（对应 iOS 27「外观 → Liquid Glass」）
export type GlassAppearance = "clear" | "standard" | "tinted";

/// 界面模式：简单模式只保留生成必需项，专家模式展示负向词、队列与自定义尺寸
export type UiMode = "simple" | "expert";

export function isUiMode(value: unknown): value is UiMode {
  return value === "simple" || value === "expert";
}

export { RATIO_OPTIONS, STYLE_PRESETS } from "./presets";

/// 参考图角色：提示词级近似（主流接口没有逐图权重参数）
export type ReferenceRole = "composition" | "style" | "face" | "element";

export const REFERENCE_ROLES: { id: ReferenceRole; label: string }[] = [
  { id: "composition", label: "构图参考" },
  { id: "style", label: "风格参考" },
  { id: "face", label: "人脸参考" },
  { id: "element", label: "元素参考" },
];

export const DEFAULT_REFERENCE_STRENGTH = 60;
