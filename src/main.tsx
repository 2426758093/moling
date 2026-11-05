import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { api } from "./lib/api";
import {
  applyGlassAppearance,
  applyReduceTransparency,
  applyThemeClass,
  isGlassAppearance,
  isThemeMode,
  readAppearanceMirror,
  writeGlassMirror,
  writeThemeMirror,
} from "./lib/theme";
import { isUiMode } from "./lib/types";
import { useAppStore } from "./stores/appStore";

/// 首帧前恢复主题、玻璃档位与界面模式。
///
/// 直接改 store 并 toggle `<html>` 的类/属性，而不调用 setTheme / setGlass ——
/// 那两条路径会把读到的值再写回库，造成"每次启动都写一次设置"。读取失败
/// （浏览器直开、无 Tauri 容器）或取值非法时保持默认，且不写库。
///
/// public/theme-boot.js 已经用 localStorage 镜像先画了一帧；这里读到 SQLite
/// 的权威值后再覆盖，并把镜像同步回去，供下次启动使用。
async function restoreAppearance() {
  const [theme, glass, mode] = await Promise.all([
    api.getSetting("theme").catch(() => null),
    api.getSetting("glassAppearance").catch(() => null),
    api.getSetting("uiMode").catch(() => null),
  ]);
  if (isThemeMode(theme)) {
    useAppStore.setState({ theme });
    writeThemeMirror(theme);
  }
  if (isGlassAppearance(glass)) {
    useAppStore.setState({ glass });
    writeGlassMirror(glass);
  }
  if (isUiMode(mode)) useAppStore.setState({ mode });
  applyThemeClass(useAppStore.getState().theme);
  applyGlassAppearance(useAppStore.getState().glass);
  applyReduceTransparency(readAppearanceMirror().transparency ?? false);
}

async function boot() {
  await restoreAppearance();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void boot();
