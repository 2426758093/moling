import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MIRROR_KEYS,
  applyGlassAppearance,
  applyReduceTransparency,
  applyThemeClass,
  isGlassAppearance,
  isThemeMode,
  readAppearanceMirror,
  writeGlassMirror,
  writeThemeMirror,
  writeTransparencyMirror,
} from "./theme";

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  document.documentElement.classList.remove("dark");
  delete document.documentElement.dataset.glass;
  delete document.documentElement.dataset.transparency;
});

function mockPrefersDark(dark: boolean) {
  vi.spyOn(window, "matchMedia").mockReturnValue({
    matches: dark,
  } as MediaQueryList);
}

describe("applyThemeClass", () => {
  it("system 跟随系统深色偏好", () => {
    mockPrefersDark(true);
    applyThemeClass("system");
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    mockPrefersDark(false);
    applyThemeClass("system");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("显式主题覆盖系统偏好", () => {
    mockPrefersDark(true);
    applyThemeClass("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    mockPrefersDark(false);
    applyThemeClass("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});

describe("玻璃与透明度", () => {
  it("玻璃档位写到 data-glass", () => {
    applyGlassAppearance("tinted");
    expect(document.documentElement.dataset.glass).toBe("tinted");
  });

  it("减少透明效果写到 data-transparency", () => {
    applyReduceTransparency(true);
    expect(document.documentElement.dataset.transparency).toBe("reduced");
    applyReduceTransparency(false);
    expect(document.documentElement.dataset.transparency).toBe("full");
  });
});

describe("外观镜像", () => {
  it("写入后可原样读出，供首帧 theme-boot.js 使用", () => {
    writeThemeMirror("dark");
    writeGlassMirror("clear");
    writeTransparencyMirror(true);

    expect(localStorage.getItem(MIRROR_KEYS.theme)).toBe("dark");
    expect(readAppearanceMirror()).toEqual({
      theme: "dark",
      glass: "clear",
      transparency: true,
    });
  });

  it("忽略脏值与未知键", () => {
    localStorage.setItem(MIRROR_KEYS.theme, "purple");
    localStorage.setItem(MIRROR_KEYS.glass, "ghost");
    localStorage.setItem(MIRROR_KEYS.transparency, "half");
    expect(readAppearanceMirror()).toEqual({});
  });

  it("localStorage 抛错时退回空对象", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readAppearanceMirror()).toEqual({});
  });
});

describe("取值校验", () => {
  it("isThemeMode / isGlassAppearance 只接受白名单", () => {
    expect(isThemeMode("system")).toBe(true);
    expect(isThemeMode("auto")).toBe(false);
    expect(isGlassAppearance("standard")).toBe(true);
    expect(isGlassAppearance("frosted")).toBe(false);
  });
});
