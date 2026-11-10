import { afterAll, describe, expect, it } from "vitest";
import i18n, { applyLocale, isLocale, readLocaleMirror } from "./index";
import enUS from "./locales/en-US";
import retouch from "./locales/en-US/retouch";
import {
  RETOUCH_ACTIONS,
  RETOUCH_GATE_REASONS,
  RETOUCH_SUGGESTION_TEXTS,
} from "../lib/retouchActions";

/**
 * 修图相关源码原文：用来把 `t("...")` 字面量全部扫出来。
 * 用 Vite 的 raw 导入而不是 node:fs —— 仓库没有 @types/node，扫描逻辑不能进 tsc 的绊脚石。
 */
const retouchSources = import.meta.glob<string>(
  ["../components/retouch/**/*.tsx", "../lib/retouch*.ts"],
  { query: "?raw", import: "default", eager: true },
);

/** `t("文案")` 里的文案；前面不能是标识符字符，免得把 import("react") 当成 key */
const LITERAL_T = /(^|[^\w$])t\(\s*"([^"\n]*)"/gm;

const dict = enUS as Record<string, string>;

function resolves(key: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(dict, key) && dict[key].trim() !== ""
  );
}

afterAll(() => {
  void i18n.changeLanguage("zh-CN");
});

describe("i18n", () => {
  it("英文词典没有空译文", () => {
    for (const [key, value] of Object.entries(enUS)) {
      expect(value.trim(), key).not.toBe("");
    }
  });

  it("切换语言立即生效并支持插值", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(i18n.t("保存")).toBe("保存");

    await i18n.changeLanguage("en-US");
    expect(i18n.t("保存")).toBe("Save");
    expect(i18n.t("新版本 {{version}} 已发布", { version: "1.3.0" })).toBe(
      "Version 1.3.0 is available",
    );
  });

  it("applyLocale 同步语言、文档语言与镜像", () => {
    applyLocale("en-US");
    expect(i18n.language).toBe("en-US");
    expect(document.documentElement.lang).toBe("en-US");
    expect(readLocaleMirror()).toBe("en-US");

    applyLocale("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(isLocale("fr-FR")).toBe(false);
  });
});

describe("修图分片", () => {
  it("骨架文案已并入词典且英文非空", async () => {
    await i18n.changeLanguage("en-US");
    expect(i18n.t("修图")).toBe("Retouch");
    expect(i18n.t("返回")).toBe("Back");
    expect(i18n.t("拖入或选择一张图片开始修图")).toBe(
      "Drop or pick a photo to start retouching",
    );
    expect(i18n.t("打开修图")).toBe("Open retouch");
    await i18n.changeLanguage("zh-CN");
  });
});

describe("修图英文译文", () => {
  it("动作名不再被后置分片影子覆盖", async () => {
    await i18n.changeLanguage("en-US");
    expect(i18n.t("换背景")).toBe("Replace background");
    expect(i18n.t("扩图")).toBe("Outpaint");
    expect(i18n.t("高清")).toBe("Upscale");
    expect(i18n.t("AI 消除")).toBe("AI erase");
    expect(i18n.t("局部重绘")).toBe("Inpaint");
    expect(i18n.t("裁剪调色")).toBe("Crop & tone");
    expect(i18n.t("风格")).toBe("Style");
    expect(i18n.t("多区域")).toBe("Multi-region");
    // 编辑 同时用于设置页服务商卡片的按钮，retouch 分片不得把它译成 Edited
    expect(i18n.t("编辑")).toBe("Edit");
    await i18n.changeLanguage("zh-CN");
  });

  it("retouch 分片的译文没有残留中文（{{...}} 插值除外）", async () => {
    // 覆盖汉字、CJK 标点（U+3000–303F）与全角/半角形式区（FF00–FFEF）
    const cjk = /[\u3000-\u303f\uff00-\uffef\u4e00-\u9fff]/;
    const leftovers: string[] = [];
    for (const [key, value] of Object.entries(
      retouch as Record<string, string>,
    )) {
      // 插值占位里的中文不算残留：它们是运行时替换的变量名
      const text = value.replace(/\{\{[^}]*\}\}/g, "");
      if (cjk.test(text)) leftovers.push(`${key} → ${value}`);
    }
    expect(leftovers).toEqual([]);
  });
});

describe("修图文案全量解析", () => {
  /** 动态键：t(reason) / t(action.label) / t(step.label) 的取值都来自这四组常量 */
  const dynamicKeys = [
    ...new Set([
      ...RETOUCH_ACTIONS.map((action) => action.label),
      ...RETOUCH_GATE_REASONS,
      ...RETOUCH_SUGGESTION_TEXTS,
      "原图",
      "编辑",
    ]),
  ];

  it("扫到的源码覆盖组件与 lib", () => {
    const paths = Object.keys(retouchSources);
    expect(paths.some((path) => path.includes("/components/retouch/"))).toBe(
      true,
    );
    expect(paths.some((path) => path.includes("/lib/retouch"))).toBe(true);
  });

  it('组件与 lib 里的 t("...") 字面量都能在 en-US 解析', () => {
    const literalKeys: string[] = [];
    const missing: string[] = [];
    for (const [path, source] of Object.entries(retouchSources)) {
      if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) continue;
      for (const match of source.matchAll(LITERAL_T)) {
        const key = match[2];
        literalKeys.push(key);
        if (!resolves(key)) missing.push(`${key} (${path})`);
      }
    }
    // 没有扫到任何 key 说明 glob 或正则坏了，别让这条断言变成空转
    expect(literalKeys.length).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });

  it("动态键（动作名 / 禁用原因 / 建议文案 / 步骤文案）都能解析", () => {
    expect(dynamicKeys.filter((key) => !resolves(key))).toEqual([]);
  });
});
