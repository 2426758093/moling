import { create } from "zustand";
import {
  GlassAppearance,
  ThemeMode,
  UiMode,
  ImageQuality,
  RATIO_OPTIONS,
} from "../lib/types";
import { api } from "../lib/api";
import i18n, { applyLocale, Locale, readLocaleMirror } from "../i18n";
import { toast } from "../lib/notify";
import {
  applyReduceTransparency,
  readAppearanceMirror,
  writeGlassMirror,
  writeThemeMirror,
  writeTransparencyMirror,
} from "../lib/theme";

export type AppView = "chat" | "gallery" | "canvas" | "queue" | "settings";

export interface GenPrefs {
  ratio: string;
  width: number;
  height: number;
  style: string;
  count: number;
  /** 图片质量；auto = 不发送 quality 字段 */
  quality: ImageQuality;
  negativePrompt: string;
}

/** 编辑入口来源；canvas = 从画布节点打开，结果回写画布 */
export type EditHost = "canvas";

export interface EditTarget {
  historyId: number;
  dataUrl: string;
  prompt: string;
  mode: "inpaint" | "erase";
  host?: EditHost;
}

export interface OutpaintTarget {
  historyId: number;
  dataUrl: string;
  prompt: string;
  host?: EditHost;
}

/** upscale = 高清放大；style = 风格转换 */
export type TransformKind = "upscale" | "style";

/** 基础编辑（本地）：无服务商依赖，任何图片都能进 */
export interface BasicEditTarget {
  historyId: number;
  dataUrl: string;
  prompt: string;
  host?: EditHost;
}

/** 换背景：蒙版 + 纯色 / 渐变 / AI 描述 */
export interface BackgroundTarget {
  historyId: number;
  dataUrl: string;
  prompt: string;
  host?: EditHost;
}

export interface TransformTarget {
  kind: TransformKind;
  historyId: number;
  dataUrl: string;
  prompt: string;
  host?: EditHost;
}

interface AppState {
  view: AppView;
  theme: ThemeMode;
  glass: GlassAppearance;
  reduceTransparency: boolean;
  mode: UiMode;
  locale: Locale;
  sidebarCollapsed: boolean;
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  /** 画布节点触发的编辑是否以内嵌面板显示；关闭则回到全屏浮层 */
  canvasInline: boolean;
  prefs: GenPrefs;
  editTarget: EditTarget | null;
  outpaintTarget: OutpaintTarget | null;
  transformTarget: TransformTarget | null;
  basicEditTarget: BasicEditTarget | null;
  backgroundTarget: BackgroundTarget | null;
  setView: (view: AppView) => void;
  setTheme: (theme: ThemeMode) => void;
  setGlass: (glass: GlassAppearance) => void;
  setReduceTransparency: (on: boolean) => void;
  setMode: (mode: UiMode) => void;
  setLocale: (locale: Locale) => void;
  toggleSidebar: () => void;
  setPaletteOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  setCanvasInline: (on: boolean) => void;
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

export const DEFAULT_PREFS: GenPrefs = {
  ratio: "1:1",
  width: BASE,
  height: BASE,
  style: "",
  count: 1,
  quality: "auto",
  negativePrompt: "",
};

/// 从磁盘/导入的 JSON 恢复生成参数：逐字段校验，非法值直接丢弃，
/// 由调用方用当前值兜底，避免坏数据把界面推进非法状态。
export function sanitizePrefs(raw: unknown): Partial<GenPrefs> {
  if (!raw || typeof raw !== "object") return {};
  const src = raw as Record<string, unknown>;
  const out: Partial<GenPrefs> = {};
  const size = (v: unknown): number | undefined => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return undefined;
    // 0 = 自动尺寸；其余按 8 对齐并限制在 512–4096
    if (v === 0) return 0;
    return Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(v / 8) * 8));
  };
  if (typeof src.ratio === "string" && src.ratio.length > 0) {
    out.ratio = src.ratio;
  }
  const width = size(src.width);
  if (width !== undefined) out.width = width;
  const height = size(src.height);
  if (height !== undefined) out.height = height;
  if (typeof src.style === "string") out.style = src.style;
  if (typeof src.count === "number" && Number.isFinite(src.count)) {
    out.count = Math.min(4, Math.max(1, Math.round(src.count)));
  }
  const quality = src.quality;
  if (
    quality === "auto" ||
    quality === "low" ||
    quality === "medium" ||
    quality === "high"
  ) {
    out.quality = quality;
  }
  if (typeof src.negativePrompt === "string") {
    out.negativePrompt = src.negativePrompt;
  }
  return out;
}

const CANVAS_INLINE_KEY = "moling.canvasInline";

/// 纯显示偏好，与 reduceTransparency 一样只落 localStorage，不进 Rust 白名单
function readCanvasInline(): boolean {
  try {
    return localStorage.getItem(CANVAS_INLINE_KEY) !== "off";
  } catch {
    return true;
  }
}

export const useAppStore = create<AppState>((set) => ({
  view: "chat",
  theme: "system",
  glass: "standard",
  reduceTransparency: readAppearanceMirror().transparency ?? false,
  mode: "expert",
  locale: readLocaleMirror(),
  sidebarCollapsed: false,
  paletteOpen: false,
  shortcutsOpen: false,
  canvasInline: readCanvasInline(),
  prefs: { ...DEFAULT_PREFS },
  editTarget: null,
  outpaintTarget: null,
  transformTarget: null,
  basicEditTarget: null,
  backgroundTarget: null,
  setView: (view) => set({ view }),
  setTheme: (theme) => {
    set({ theme });
    // 镜像先写：下一帧的首屏靠 localStorage，不等 SQLite
    writeThemeMirror(theme);
    // 主题是纯本机偏好：先切 UI 再落库，写失败只提示不阻断（下次启动回退 system）
    void api
      .setSetting("theme", theme)
      .catch((e) =>
        toast(i18n.t("保存主题失败：{{error}}", { error: String(e) }), "error"),
      );
  },
  setGlass: (glass) => {
    set({ glass });
    writeGlassMirror(glass);
    void api
      .setSetting("glassAppearance", glass)
      .catch((e) =>
        toast(
          i18n.t("保存玻璃质感失败：{{error}}", { error: String(e) }),
          "error",
        ),
      );
  },
  setReduceTransparency: (on) => {
    // 只落 localStorage —— 纯显示偏好，不进 Rust 设置白名单
    set({ reduceTransparency: on });
    writeTransparencyMirror(on);
    applyReduceTransparency(on);
  },
  setMode: (mode) => {
    set({ mode });
    void api
      .setSetting("uiMode", mode)
      .catch((e) =>
        toast(
          i18n.t("保存界面模式失败：{{error}}", { error: String(e) }),
          "error",
        ),
      );
  },
  setLocale: (locale) => {
    // 语言是纯本机偏好：先切 UI 再落库，写失败只提示不阻断
    set({ locale });
    applyLocale(locale);
    void api
      .setSetting("locale", locale)
      .catch((e) =>
        toast(
          i18n.t("保存语言设置失败：{{error}}", { error: String(e) }),
          "error",
        ),
      );
  },
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setCanvasInline: (canvasInline) => {
    set({ canvasInline });
    try {
      localStorage.setItem(CANVAS_INLINE_KEY, canvasInline ? "on" : "off");
    } catch {
      // 隐私模式等写不了 localStorage 时只在本次会话生效
    }
  },
  setPrefs: (patch) => set((s) => ({ prefs: { ...s.prefs, ...patch } })),
  applyRatio: (ratioId) =>
    set((s) => {
      const r = RATIO_OPTIONS.find((o) => o.id === ratioId);
      if (!r) return s;
      // 自动尺寸用 0×0 表示：后端据此省略 size 字段
      if (r.w === 0 || r.h === 0) {
        return {
          prefs: { ...s.prefs, ratio: ratioId, width: 0, height: 0 },
        };
      }
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
  // 同一时刻只允许一个编辑实例：打开任一入口都先关掉其余四个
  openEditor: (editTarget) =>
    set({
      editTarget,
      outpaintTarget: null,
      transformTarget: null,
      basicEditTarget: null,
      backgroundTarget: null,
    }),
  closeEditor: () => set({ editTarget: null }),
  openOutpaint: (outpaintTarget) =>
    set({
      outpaintTarget,
      editTarget: null,
      transformTarget: null,
      basicEditTarget: null,
      backgroundTarget: null,
    }),
  closeOutpaint: () => set({ outpaintTarget: null }),
  openTransform: (transformTarget) =>
    set({
      transformTarget,
      editTarget: null,
      outpaintTarget: null,
      basicEditTarget: null,
      backgroundTarget: null,
    }),
  closeTransform: () => set({ transformTarget: null }),
  openBasicEdit: (basicEditTarget) =>
    set({
      basicEditTarget,
      editTarget: null,
      outpaintTarget: null,
      transformTarget: null,
      backgroundTarget: null,
    }),
  closeBasicEdit: () => set({ basicEditTarget: null }),
  openBackground: (backgroundTarget) =>
    set({
      backgroundTarget,
      editTarget: null,
      outpaintTarget: null,
      transformTarget: null,
      basicEditTarget: null,
    }),
  closeBackground: () => set({ backgroundTarget: null }),
}));
