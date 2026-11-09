/** 区域提示：把最多 3 个区域编译成一段提示词，随现有 generate 发送。
 *  纯提示词级近似——是否生效取决于模型对长提示词的遵循度，不是分区重绘。 */

export const REGION_AREAS = [
  ["left", "左侧"],
  ["center", "中央"],
  ["right", "右侧"],
  ["top", "上方"],
  ["bottom", "下方"],
  ["background", "背景"],
  ["full", "全画面"],
] as const;

export type RegionArea = (typeof REGION_AREAS)[number][0];

export interface RegionHint {
  area: RegionArea;
  description: string;
}

export const MAX_REGIONS = 3;

const PHRASE: Record<RegionArea, string> = {
  left: "left third",
  center: "center",
  right: "right third",
  top: "top",
  bottom: "bottom",
  background: "background",
  full: "whole frame",
};

export const REGION_ITEMS = REGION_AREAS.map(([value, label]) => ({
  value,
  label,
}));

/// 编译为单段英文提示（主流模型对英文区位词更稳定）；无有效描述返回空串。
export function compileRegionPrompt(regions: RegionHint[]): string {
  const parts = regions
    .slice(0, MAX_REGIONS)
    .filter((r) => r.description.trim() !== "")
    .map((r) => `${PHRASE[r.area]}: ${r.description.trim()}`);
  if (parts.length === 0) return "";
  return `Regional layout — ${parts.join("; ")}.`;
}

/// 把区域段写入草稿；`previous` 为上次写入的段，仍在末尾时先移除再追加，
/// 避免同一组区域反复写入时叠加成多段。无有效描述时原样返回。
export function writeRegionPrompt(
  prompt: string,
  regions: RegionHint[],
  previous: string | null = null,
): { text: string; block: string } {
  const block = compileRegionPrompt(regions);
  if (!block) return { text: prompt, block: "" };
  const trimmed = prompt.trimEnd();
  const base =
    previous && trimmed.endsWith(previous)
      ? trimmed.slice(0, -previous.length).trimEnd()
      : trimmed;
  return { text: base ? `${base}\n${block}` : block, block };
}
