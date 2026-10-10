import { create } from "zustand";
import { ThemeMode, RATIO_OPTIONS } from "../lib/types";

export type AppView = "chat" | "gallery" | "settings";

export interface GenPrefs {
  ratio: string;
  width: number;
  height: number;
  style: string;
  count: number;
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

interface AppState {
  view: AppView;
  theme: ThemeMode;
  sidebarCollapsed: boolean;
  prefs: GenPrefs;
  editTarget: EditTarget | null;
  outpaintTarget: OutpaintTarget | null;
  setView: (view: AppView) => void;
  setTheme: (theme: ThemeMode) => void;
  toggleSidebar: () => void;
  setPrefs: (patch: Partial<GenPrefs>) => void;
  applyRatio: (ratioId: string) => void;
  openEditor: (target: EditTarget) => void;
  closeEditor: () => void;
  openOutpaint: (target: OutpaintTarget) => void;
  closeOutpaint: () => void;
}

const BASE = 1024;

export const useAppStore = create<AppState>((set) => ({
  view: "chat",
  theme: "system",
  sidebarCollapsed: false,
  prefs: {
    ratio: "1:1",
    width: BASE,
    height: BASE,
    style: "",
    count: 1,
  },
  editTarget: null,
  outpaintTarget: null,
  setView: (view) => set({ view }),
  setTheme: (theme) => set({ theme }),
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
  openEditor: (target) => set({ editTarget: target }),
  closeEditor: () => set({ editTarget: null }),
  openOutpaint: (target) => set({ outpaintTarget: target }),
  closeOutpaint: () => set({ outpaintTarget: null }),
}));
