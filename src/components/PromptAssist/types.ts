import type { TFunction } from "i18next";
import type { WorkflowPreset } from "../../lib/api";
import { qualityLabel } from "../../lib/presets";
import { saveTextFile } from "../../lib/save";
import { toast } from "../../lib/notify";

export const SUBJECTS = [
  "一只橘猫",
  "古风少女",
  "未来机甲",
  "山间古寺",
  "蒸汽火车",
  "深海鲸鱼",
  "竹林剑客",
  "玻璃花房",
  "沙漠旅人",
  "云端城市",
];
export const SCENES = [
  "在暴雨夜",
  "于晨光之中",
  "漂浮在太空",
  "被樱花环绕",
  "在霓虹灯下",
  "于云海之上",
  "在古老图书馆",
  "伴着极光",
  "在无人海滩",
  "于金色麦田",
];
export const STYLES = [
  "赛博朋克",
  "水彩画",
  "吉卜力动画",
  "写实摄影",
  "浮世绘",
  "低多边形 3D",
  "黑白胶片",
  "像素艺术",
  "油画",
  "概念设计稿",
];
export const LIGHTS = [
  "逆光轮廓光",
  "柔和的窗光",
  "戏剧化聚光",
  "月光冷色调",
  "暖色黄昏光",
  "霓虹反射光",
  "薄雾散射光",
  "闪电瞬间",
  "烛光摇曳",
  "正午硬光",
];

export const pick = (arr: string[]) =>
  arr[Math.floor(Math.random() * arr.length)];

export const TABS = [
  { id: "optimize", label: "优化" },
  { id: "templates", label: "模板" },
  { id: "inspire", label: "灵感" },
  { id: "reverse", label: "反推" },
  { id: "favorites", label: "收藏" },
  { id: "presets", label: "预设" },
  { id: "translate", label: "翻译" },
] as const;

export type TabId = (typeof TABS)[number]["id"];

export function rollInspiration(): string {
  return `${pick(SUBJECTS)}${pick(SCENES)}，${pick(STYLES)}风格，${pick(LIGHTS)}`;
}

/** 与后端 translation_direction 同规则：含 CJK 汉字按中→英 */
export function isCJK(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

export function parseTagInput(raw: string): string[] {
  return raw
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 8);
}

export async function downloadJson(
  filename: string,
  data: unknown,
  failMessage: string,
): Promise<void> {
  try {
    await saveTextFile(JSON.stringify(data, null, 2), filename);
  } catch {
    toast(failMessage, "error");
  }
}

export function presetRefSummary(
  p: WorkflowPreset,
  t: TFunction<"translation">,
): string {
  try {
    const v = JSON.parse(p.paramsJson);
    const parts: string[] = [];
    if (typeof v?.ratio === "string")
      parts.push(
        v.ratio === "custom"
          ? t("自定义")
          : v.ratio === "auto"
            ? t("自动")
            : v.ratio,
      );
    if (
      typeof v?.width === "number" &&
      typeof v?.height === "number" &&
      (v.width > 0 || v.height > 0)
    ) {
      parts.push(`${v.width}×${v.height}`);
    }
    if (typeof v?.quality === "string" && v.quality !== "auto") {
      const quality = qualityLabel(v.quality);
      parts.push(`${t("质量")} ${t(quality, quality)}`);
    }
    if (p.refs.length > 0) {
      parts.push(t("{{n}} 参考图", { n: p.refs.length }));
    }
    return parts.join(" · ");
  } catch {
    return p.refs.length > 0 ? t("{{n}} 参考图", { n: p.refs.length }) : "";
  }
}

export function safeParamsJson(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export const VALID_ROLES = ["composition", "style", "face", "element"];
