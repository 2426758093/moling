import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type WindowPlatform = "windows" | "macos" | "other";

function detectPlatform(): WindowPlatform {
  if (typeof navigator === "undefined") return "other";
  if (/Mac/i.test(navigator.userAgent)) return "macos";
  if (/Win/i.test(navigator.userAgent)) return "windows";
  return "other";
}

/// 浏览器直开（无 Tauri 容器）时窗口 API 全部不可用，调用会抛错。
export function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/// 窗口状态：最大化标记 + 平台标记。
///
/// 最大化只能靠 `isMaximized()` + 窗口 resize 事件轮询 —— Tauri 没有
/// "最大化状态变化"的单独事件，尺寸变化是唯一可靠信号。
export function useWindowState() {
  const [isMaximized, setIsMaximized] = useState(false);
  const [platform] = useState<WindowPlatform>(detectPlatform);

  useEffect(() => {
    document.documentElement.dataset.platform = platform;
  }, [platform]);

  useEffect(() => {
    if (!inTauri()) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    const sync = () => {
      void win
        .isMaximized()
        .then((value) => {
          if (!cancelled) setIsMaximized(value);
        })
        .catch(() => undefined);
    };
    sync();
    void win
      .onResized(sync)
      .then((off) => {
        if (cancelled) off();
        else unlisten = off;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return { isMaximized, platform };
}
