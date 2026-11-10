import { useEffect } from "react";
import { useAppStore, type AppView } from "../stores/appStore";
import { useChatStore } from "../stores/chatStore";
import { FOCUS_SIDEBAR_SEARCH_EVENT } from "../lib/commands";
import { isComposingEvent, matchesShortcut } from "../lib/shortcuts";

const VIEW_KEYS: Record<string, AppView> = {
  "1": "chat",
  "2": "gallery",
  "3": "canvas",
  "4": "queue",
  "5": "retouch",
  "6": "settings",
};

/// 全局快捷键只在这里挂一次：修饰键组合在任何焦点下生效，
/// 裸键（Delete / 数字）交给各视图自己处理。
export function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isComposingEvent(e)) return;
      const app = useAppStore.getState();

      if (e.key === "F1") {
        e.preventDefault();
        app.setPaletteOpen(false);
        app.setShortcutsOpen(true);
        return;
      }

      if (matchesShortcut(e, "Ctrl+K")) {
        e.preventDefault();
        app.setShortcutsOpen(false);
        app.setPaletteOpen(!app.paletteOpen);
        return;
      }

      if (e.key === "Escape") {
        if (app.paletteOpen) {
          e.preventDefault();
          app.setPaletteOpen(false);
        } else if (app.shortcutsOpen) {
          e.preventDefault();
          app.setShortcutsOpen(false);
        }
        return;
      }

      if (!e.ctrlKey && !e.metaKey) return;

      if (matchesShortcut(e, "Ctrl+N")) {
        e.preventDefault();
        app.setView("chat");
        void useChatStore.getState().newConversation();
        return;
      }
      if (matchesShortcut(e, "Ctrl+B")) {
        e.preventDefault();
        app.toggleSidebar();
        return;
      }
      if (matchesShortcut(e, "Ctrl+,")) {
        e.preventDefault();
        app.setView("settings");
        return;
      }
      if (matchesShortcut(e, "Ctrl+F")) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(FOCUS_SIDEBAR_SEARCH_EVENT));
        return;
      }

      // Ctrl 1–6 切视图：带修饰键，在输入框里也生效
      const view = VIEW_KEYS[e.key];
      if (view) {
        e.preventDefault();
        app.setView(view);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
