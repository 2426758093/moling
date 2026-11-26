import { create } from "zustand";
import {
  COMPOSER_DEFAULT,
  COMPOSER_MAX,
  COMPOSER_MIN,
  DEFAULT_LAYOUT,
  INSPECTOR_DEFAULT,
  INSPECTOR_MAX,
  INSPECTOR_MIN,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  clampSize,
  readLayout,
  writeLayout,
  type LayoutSizes,
} from "../lib/layout";

/// 正在拖拽的分隔条：只用于关闭过渡，不落盘。
export type ResizeTarget = "sidebar" | "inspector" | "composer";

interface LayoutState {
  sidebarWidth: number;
  inspectorWidth: number;
  composerHeight: number;
  resizing: ResizeTarget | null;
  setSidebarWidth: (width: number) => void;
  setInspectorWidth: (width: number) => void;
  setComposerHeight: (height: number) => void;
  setResizing: (target: ResizeTarget | null) => void;
  resetLayout: () => void;
}

const PERSIST_DELAY = 200;
const initial = readLayout();
let persistTimer: number | null = null;

/// 200ms 防抖：拖拽期间每次 pointermove 都写 localStorage 会明显掉帧。
function schedulePersist(sizes: LayoutSizes) {
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    writeLayout(sizes);
  }, PERSIST_DELAY);
}

export const useLayoutStore = create<LayoutState>((set, get) => {
  const persist = () =>
    schedulePersist({
      sidebar: get().sidebarWidth,
      inspector: get().inspectorWidth,
      composer: get().composerHeight,
    });

  return {
    sidebarWidth: initial.sidebar,
    inspectorWidth: initial.inspector,
    composerHeight: initial.composer,
    resizing: null,
    setSidebarWidth: (width) => {
      set({ sidebarWidth: clampSize(width, SIDEBAR_MIN, SIDEBAR_MAX) });
      persist();
    },
    setInspectorWidth: (width) => {
      set({ inspectorWidth: clampSize(width, INSPECTOR_MIN, INSPECTOR_MAX) });
      persist();
    },
    setComposerHeight: (height) => {
      set({ composerHeight: clampSize(height, COMPOSER_MIN, COMPOSER_MAX) });
      persist();
    },
    setResizing: (resizing) => set({ resizing }),
    resetLayout: () => {
      if (persistTimer !== null) {
        window.clearTimeout(persistTimer);
        persistTimer = null;
      }
      set({
        sidebarWidth: SIDEBAR_DEFAULT,
        inspectorWidth: INSPECTOR_DEFAULT,
        composerHeight: COMPOSER_DEFAULT,
        resizing: null,
      });
      writeLayout({ ...DEFAULT_LAYOUT });
    },
  };
});
