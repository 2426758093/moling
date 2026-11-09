import { afterAll, describe, expect, it } from "vitest";
import i18n, { applyLocale, isLocale, readLocaleMirror } from "./index";
import enUS from "./locales/en-US";

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
