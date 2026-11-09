import i18n from "../i18n";

export const RATIO_OPTIONS = [
  { id: "auto", label: "自动", w: 0, h: 0 },
  { id: "1:1", label: "1:1", w: 1, h: 1 },
  { id: "3:2", label: "3:2", w: 3, h: 2 },
  { id: "2:3", label: "2:3", w: 2, h: 3 },
  { id: "16:9", label: "16:9", w: 16, h: 9 },
  { id: "9:16", label: "9:16", w: 9, h: 16 },
  { id: "4:3", label: "4:3", w: 4, h: 3 },
  { id: "3:4", label: "3:4", w: 3, h: 4 },
  { id: "21:9", label: "21:9", w: 21, h: 9 },
];

/** 自动尺寸约定：宽高同时为 0，后端不发送 size 字段，由服务商决定 */
export function isAutoSize(width: number, height: number): boolean {
  return width === 0 && height === 0;
}

/** 尺寸展示文案：自动尺寸显示「自动」，避免界面出现 0×0 */
export function sizeLabel(width: number, height: number): string {
  return isAutoSize(width, height) ? i18n.t("自动") : `${width} × ${height}`;
}

export type ImageQuality = "auto" | "low" | "medium" | "high";

/// label 即词典 key：写成字面量类型，漏补英文时编译期即报错
export const QUALITY_OPTIONS = [
  { id: "auto", label: "自动" },
  { id: "low", label: "低" },
  { id: "medium", label: "中" },
  { id: "high", label: "高" },
] as const satisfies readonly { id: ImageQuality; label: string }[];

export function qualityLabel(quality: string): string {
  const label = QUALITY_OPTIONS.find((q) => q.id === quality)?.label ?? "自动";
  return i18n.t(label);
}

export interface StylePreset {
  id: string;
  label: string;
  prompt: string;
}

/** 内置风格的兜底副本：Rust 侧 get_style_presets 返回前先用它渲染，
 * prompt 文本与历史记录里的 style 字段保持一致。 */
export const STYLE_PRESETS: StylePreset[] = [
  { id: "photo", label: "真实摄影", prompt: "photorealistic, 8k, raw photo" },
  { id: "anime", label: "动漫", prompt: "anime style, vibrant, cel shading" },
  { id: "oil", label: "油画", prompt: "oil painting, classic brushwork" },
  {
    id: "watercolor",
    label: "水彩",
    prompt: "watercolor, soft washes, paper texture",
  },
  {
    id: "cyberpunk",
    label: "赛博朋克",
    prompt: "cyberpunk, neon lights, futuristic",
  },
  {
    id: "film",
    label: "胶片",
    prompt: "analog film photography, subtle grain",
  },
  {
    id: "render3d",
    label: "3D 渲染",
    prompt: "3D render, soft studio lighting",
  },
];
