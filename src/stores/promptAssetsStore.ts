import { create } from "zustand";
import { api, PresetInput, PromptFavorite, WorkflowPreset } from "../lib/api";
import { genAttachmentId } from "../lib/file";
import { toast } from "../lib/notify";
import { useAppStore, GenPrefs, SIZE_MAX, SIZE_MIN } from "./appStore";
import { useChatStore } from "./chatStore";

/** 预设 params 的宽松解析：只接受界面能验证的字段，坏值一律忽略。 */
export function prefsFromPresetParams(json: string): Partial<GenPrefs> {
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    raw = parsed as Record<string, unknown>;
  } catch {
    return {};
  }
  const out: Partial<GenPrefs> = {};
  const clampSize = (v: unknown): number | null => {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(n / 8) * 8));
  };
  if (typeof raw.ratio === "string") out.ratio = raw.ratio;
  const width = clampSize(raw.width);
  const height = clampSize(raw.height);
  if (width !== null) out.width = width;
  if (height !== null) out.height = height;
  if (typeof raw.style === "string") out.style = raw.style;
  if (typeof raw.count === "number" && Number.isFinite(raw.count)) {
    out.count = Math.min(4, Math.max(1, Math.round(raw.count)));
  }
  return out;
}

interface PromptAssetsState {
  favorites: PromptFavorite[];
  presets: WorkflowPreset[];
  loaded: boolean;
  loading: boolean;
  load: () => Promise<void>;
  /** 返回 created / updated / null（失败），供界面提示用词 */
  upsertFavorite: (
    text: string,
    tags: string[],
  ) => Promise<"created" | "updated" | null>;
  removeFavorite: (id: number) => Promise<void>;
  savePreset: (input: PresetInput) => Promise<WorkflowPreset | null>;
  removePreset: (id: number) => Promise<void>;
  /** 回填草稿、生成参数与参考图；缺图的 ref 跳过并提示 */
  applyPreset: (preset: WorkflowPreset) => Promise<void>;
}

export const usePromptAssetsStore = create<PromptAssetsState>((set, get) => ({
  favorites: [],
  presets: [],
  loaded: false,
  loading: false,

  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const [favorites, presets] = await Promise.all([
        api.listFavorites(),
        api.listPresets(),
      ]);
      set({ favorites, presets, loaded: true });
    } catch {
      toast("加载提示词资产失败，请稍后重试", "error");
    } finally {
      set({ loading: false });
    }
  },

  upsertFavorite: async (text, tags) => {
    const target = text.trim();
    if (!target) return null;
    const existed = get().favorites.some((f) => f.text === target);
    try {
      const saved = await api.upsertFavorite(target, tags);
      set((s) => ({
        favorites: [saved, ...s.favorites.filter((f) => f.id !== saved.id)],
      }));
      return existed ? "updated" : "created";
    } catch (e) {
      toast(`收藏失败：${String(e)}`, "error");
      return null;
    }
  },

  removeFavorite: async (id) => {
    try {
      await api.deleteFavorite(id);
      set((s) => ({ favorites: s.favorites.filter((f) => f.id !== id) }));
    } catch (e) {
      toast(`删除收藏失败：${String(e)}`, "error");
    }
  },

  savePreset: async (input) => {
    try {
      const saved = await api.savePreset(input);
      set((s) => ({
        presets: [saved, ...s.presets.filter((p) => p.id !== saved.id)],
      }));
      return saved;
    } catch (e) {
      toast(`保存预设失败：${String(e)}`, "error");
      return null;
    }
  },

  removePreset: async (id) => {
    try {
      await api.deletePreset(id);
      set((s) => ({ presets: s.presets.filter((p) => p.id !== id) }));
    } catch (e) {
      toast(`删除预设失败：${String(e)}`, "error");
    }
  },

  applyPreset: async (preset) => {
    const app = useAppStore.getState();
    app.setPrefs({
      ...prefsFromPresetParams(preset.paramsJson),
      negativePrompt: preset.negativePrompt,
    });
    const chat = useChatStore.getState();
    chat.clearAttachments();
    chat.setDraftPrompt(preset.prompt);
    app.setView("chat");

    let skipped = 0;
    for (const ref of preset.refs) {
      try {
        const dataUrl = await api.readReferenceImage(ref.path);
        chat.addAttachment({
          id: genAttachmentId(),
          dataUrl,
          name: `预设参考图 ${ref.role}`,
          path: ref.path,
          role: ref.role,
          strength: ref.strength,
        });
      } catch {
        skipped += 1;
      }
    }
    if (skipped > 0) {
      toast(`已应用预设，${skipped} 张参考图不可用被跳过`, "error");
    }
  },
}));
