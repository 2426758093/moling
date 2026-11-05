import { GlassAppearance, ThemeMode } from "./types";

/// 把主题模式换算成 `<html>` 上的 `.dark` 类。
///
/// main.tsx（首帧前）与 App（运行期跟随系统）共用同一实现，避免两份判定
/// 逻辑漂移导致"启动一次深色、挂载后又变浅"的闪烁。
export function applyThemeClass(theme: ThemeMode) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = theme === "dark" || (theme === "system" && prefersDark);
  document.documentElement.classList.toggle("dark", dark);
}

/// 玻璃档位写到 `<html data-glass>`，由 index.css 的 `html[data-glass="…"]`
/// 覆盖 --glass-bg / --glass-blur / --glass-saturate。组件不感知档位。
export function applyGlassAppearance(glass: GlassAppearance) {
  document.documentElement.dataset.glass = glass;
}

/// 校验后端返回的主题值（历史脏值 / 手工改库都可能出现）
export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

export function isGlassAppearance(value: unknown): value is GlassAppearance {
  return value === "clear" || value === "standard" || value === "tinted";
}

/// 减少透明效果：设置里显式开启后玻璃退化为纯色（见 index.css）。
///
/// 它是纯显示偏好，不进 Rust 设置白名单 —— 只写 localStorage，让
/// public/theme-boot.js 能在首帧前同步读到，避免启动瞬间闪一次玻璃。
export function applyReduceTransparency(on: boolean) {
  document.documentElement.dataset.transparency = on ? "reduced" : "full";
}

/// 与 public/theme-boot.js 共用的镜像键。改键名必须同步那个文件。
export const MIRROR_KEYS = {
  theme: "moling.theme",
  glass: "moling.glass",
  transparency: "moling.transparency",
} as const;

export interface AppearanceMirror {
  theme?: ThemeMode;
  glass?: GlassAppearance;
  transparency?: boolean;
}

/// 读 localStorage 镜像。无容器 / 隐私模式下 localStorage 可能直接抛错，
/// 这里一律吞掉并返回空对象 —— 镜像只是首帧优化，读不到就回退默认值。
export function readAppearanceMirror(): AppearanceMirror {
  const out: AppearanceMirror = {};
  try {
    const theme = localStorage.getItem(MIRROR_KEYS.theme);
    const glass = localStorage.getItem(MIRROR_KEYS.glass);
    const transparency = localStorage.getItem(MIRROR_KEYS.transparency);
    if (isThemeMode(theme)) out.theme = theme;
    if (isGlassAppearance(glass)) out.glass = glass;
    if (transparency === "reduced") out.transparency = true;
    else if (transparency === "full") out.transparency = false;
  } catch {
    // 无存储权限：保持默认
  }
  return out;
}

export function writeThemeMirror(theme: ThemeMode) {
  writeMirror(MIRROR_KEYS.theme, theme);
}

export function writeGlassMirror(glass: GlassAppearance) {
  writeMirror(MIRROR_KEYS.glass, glass);
}

export function writeTransparencyMirror(on: boolean) {
  writeMirror(MIRROR_KEYS.transparency, on ? "reduced" : "full");
}

function writeMirror(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 写不进去不影响当前会话
  }
}
