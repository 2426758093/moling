import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { api } from "./lib/api";
import { applyThemeClass, isThemeMode } from "./lib/theme";
import { useAppStore } from "./stores/appStore";

/// 首帧前恢复主题。
///
/// 直接改 store 并 toggle `<html>` 类，而不调用 setTheme —— 那条路径会把读到的
/// 值再写回库，造成"每次启动都写一次设置"。读取失败（浏览器直开、无 Tauri
/// 容器）或取值非法时保持默认 system，且不写库。
async function restoreTheme() {
  try {
    const saved = await api.getSetting("theme");
    if (isThemeMode(saved)) {
      useAppStore.setState({ theme: saved });
      applyThemeClass(saved);
    }
  } catch {
    // 忽略：无容器或读失败都按默认主题启动
  }
}

async function boot() {
  await restoreTheme();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void boot();
