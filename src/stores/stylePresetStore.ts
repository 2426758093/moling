import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { api } from "../lib/api";
import i18n from "../i18n";
import { STYLE_PRESETS, type StylePreset } from "../lib/presets";
import { toast } from "../lib/notify";

interface StylePresetState {
  builtin: StylePreset[];
  custom: StylePreset[];
  loaded: boolean;
  loading: boolean;
  load: () => Promise<void>;
  addCustom: (label: string, prompt: string) => Promise<boolean>;
  removeCustom: (id: string) => Promise<void>;
}

export const useStylePresetStore = create<StylePresetState>((set, get) => ({
  builtin: STYLE_PRESETS,
  custom: [],
  loaded: false,
  loading: false,

  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const r = await api.getStylePresets();
      set({
        builtin: r.builtin.length > 0 ? r.builtin : STYLE_PRESETS,
        custom: r.custom,
        loaded: true,
      });
    } catch {
      // 后端不可用时退回内置兜底，不打断输入
      set({ loaded: true });
    } finally {
      set({ loading: false });
    }
  },

  addCustom: async (label, prompt) => {
    const l = label.trim();
    const p = prompt.trim();
    if (!l || !p) return false;
    if (get().custom.length >= 50) {
      toast(i18n.t("自定义风格最多 50 个"), "error");
      return false;
    }
    const next = [
      ...get().custom,
      { id: `c_${Date.now()}`, label: l, prompt: p },
    ];
    try {
      await api.saveStylePresets(next);
      set({ custom: next });
      return true;
    } catch (e) {
      toast(i18n.t("保存风格失败：{{error}}", { error: String(e) }), "error");
      return false;
    }
  },

  removeCustom: async (id) => {
    const next = get().custom.filter((p) => p.id !== id);
    try {
      await api.saveStylePresets(next);
      set({ custom: next });
    } catch (e) {
      toast(i18n.t("删除风格失败：{{error}}", { error: String(e) }), "error");
    }
  },
}));

/** 内置 + 自定义，首次使用时懒加载 */
export function useStylePresets(): StylePreset[] {
  const builtin = useStylePresetStore((s) => s.builtin);
  const custom = useStylePresetStore((s) => s.custom);
  useEffect(() => {
    const store = useStylePresetStore.getState();
    if (!store.loaded) void store.load();
  }, []);
  return useMemo(() => [...builtin, ...custom], [builtin, custom]);
}
