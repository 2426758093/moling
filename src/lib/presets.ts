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
  return isAutoSize(width, height) ? "自动" : `${width} × ${height}`;
}

export type ImageQuality = "auto" | "low" | "medium" | "high";

export const QUALITY_OPTIONS: { id: ImageQuality; label: string }[] = [
  { id: "auto", label: "自动" },
  { id: "low", label: "低" },
  { id: "medium", label: "中" },
  { id: "high", label: "高" },
];

export function qualityLabel(quality: string): string {
  return QUALITY_OPTIONS.find((q) => q.id === quality)?.label ?? "自动";
}

export const STYLE_PRESETS = [
  { id: "", label: "无风格" },
  { id: "photorealistic, 8k, raw photo", label: "真实摄影" },
  { id: "anime style, vibrant, cel shading", label: "动漫" },
  { id: "oil painting, classic brushwork", label: "油画" },
  { id: "cyberpunk, neon lights, futuristic", label: "赛博朋克" },
  { id: "watercolor, soft washes, paper texture", label: "水彩" },
];
