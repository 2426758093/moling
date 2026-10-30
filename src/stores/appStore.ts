import { create } from "zustand";
import {
  GlassAppearance,
  ThemeMode,
  UiMode,
  RATIO_OPTIONS,
} from "../lib/types";
import { api } from "../lib/api";
import { toast } from "../lib/notify";

export type AppView = "chat" | "gallery" | "canvas" | "queue" | "settings";

export interface GenPrefs {
  ratio: string;
  width: number;
  height: number;
  style: string;
  count: number;
  negativePrompt: string;
}

export interface EditTarget {
  historyId: number;
  dataUrl: string;
  prompt: string;
  mode: "inpaint" | "erase";
}

export interface OutpaintTarget {
  historyId: number;
  dataUrl: string;
  prompt: string;
}

/** upscale = 高清放大；style = 风格转换 */
export type TransformKind = "upscale" | "style";

/** 基础编辑（本地）：无服务商依赖，任何图片都能进 */
export interface BasicEditTarget {
  historyId: number;
  dataUrl: string;
  prompt: string;
}

/** 换背景：蒙版 + 纯色 / 渐变 / AI 描述 */
export interface BackgroundTarget {
  historyId: number;
  dataUrl: string;
  prompt: string;
}

export interface TransformTarget {
  kind: TransformKind;
  historyId: number;
  dataUrl: string;
  prompt: string;
}

interface AppState {
  view: AppView;
  theme: ThemeMode;
  glass: GlassAppearance;
  mode: UiMode;
  sidebarCollapsed: boolean;
  prefs: GenPrefs;
  editTarget: EditTarget | null;
  outpaintTarget: OutpaintTarget | null;
  transformTarget: TransformTarget | null;
  basicEditTarget: BasicEditTarget | null;
  backgroundTarget: BackgroundTarget | null;
  setView: (view: AppView) => void;
  setTheme: (theme: ThemeMode) => void;
  setGlass: (glass: GlassAppearance) => void;
  setMode: (mode: UiMode) => void;
  toggleSidebar: () => void;
  setPrefs: (patch: Partial<GenPrefs>) => void;
  applyRatio: (ratioId: string) => void;
  applyCustomSize: (width: number, height: number) => void;
  openEditor: (target: EditTarget) => void;
  closeEditor: () => void;
  openOutpaint: (target: OutpaintTarget) => void;
  closeOutpaint: () => void;
  openTransform: (target: TransformTarget) => void;
  closeTransform: () => void;
  openBasicEdit: (target: BasicEditTarget) => void;
  closeBasicEdit: () => void;
  openBackground: (target: BackgroundTarget) => void;
  closeBackground: () => void;
}

const BASE = 1024;

/// 自由尺寸：512–4096 且 8 对齐（部分服务商只接受 8 的倍数）
export const SIZE_MIN = 512;
export const SIZE_MAX = 4096;

export function snapSize(
  width: number,
  height: number,
): { width: number; height: number } {
  const snap = (v: number) => {
    const n = Number.isFinite(v) ? v : BASE;
    return Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(n / 8) * 8));
  };
  return { width: snap(width), height: snap(height) };
}

export const useAppStore = create<AppState>((set) => ({
  view: "chat",
  theme: "system",
  glass: "standard",
  mode: "expert",
  sidebarCollapsed: false,
  prefs: {
    ratio: "1:1",
    width: BASE,
    height: BASE,
    style: "",
    count: 1,
    negativePrompt: "",
  },
  editTarget: null,
  outpaintTarget: null,
  transformTarget: null,
  basicEditTarget: null,
  backgroundTarget: null,
  setView: (view) => set({ view }),
  setTheme: (theme) => {
    set({ theme });
    // 主题是纯本机偏好：先切 UI 再落库，写失败只提示不阻断（下次启动回退 system）
    void api
      .setSetting("theme", theme)
      .catch((e) => toast(`保存主题失败：${String(e)}`, "error"));
  },
  setGlass: (glass) => {
    set({ glass });
    void api
      .setSetting("glassAppearance", glass)
      .catch((e) => toast(`保存玻璃质感失败：${String(e)}`, "error"));
  },
  setMode: (mode) => {
    set({ mode });
    void api
      .setSetting("uiMode", mode)
      .catch((e) => toast(`保存界面模式失败：${String(e)}`, "error"));
  },
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setPrefs: (patch) => set((s) => ({ prefs: { ...s.prefs, ...patch } })),
  applyRatio: (ratioId) =>
    set((s) => {
      const r = RATIO_OPTIONS.find((o) => o.id === ratioId);
      if (!r) return s;
      const scale = BASE / Math.max(r.w, r.h);
      return {
        prefs: {
          ...s.prefs,
          ratio: ratioId,
          width: Math.round((r.w * scale) / 8) * 8,
          height: Math.round((r.h * scale) / 8) * 8,
        },
      };
    }),
  applyCustomSize: (width, height) =>
    set((s) => ({
      prefs: { ...s.prefs, ratio: "custom", ...snapSize(width, height) },
    })),
  openEditor: (target) => set({ editTarget: target }),
  closeEditor: () => set({ editTarget: null }),
  openOutpaint: (target) => set({ outpaintTarget: target }),
  closeOutpaint: () => set({ outpaintTarget: null }),
  openTransform: (target) => set({ transformTarget: target }),
  closeTransform: () => set({ transformTarget: null }),
  openBasicEdit: (target) => set({ basicEditTarget: target }),
  closeBasicEdit: () => set({ basicEditTarget: null }),
  openBackground: (target) => set({ backgroundTarget: target }),
  closeBackground: () => set({ backgroundTarget: null }),
}));
