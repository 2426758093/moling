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
