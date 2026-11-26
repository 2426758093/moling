import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  api,
  type AdapterError,
  type PresetRef,
  type PromptTemplate,
  type WorkflowPreset,
} from "../../lib/api";
import { readFileAsDataUrl, readFileAsText } from "../../lib/file";
import { toast } from "../../lib/notify";
import { useAppStore } from "../../stores/appStore";
import { useChatStore } from "../../stores/chatStore";
import { usePromptAssetsStore } from "../../stores/promptAssetsStore";
import {
  VALID_ROLES,
  downloadJson,
  parseTagInput,
  rollInspiration,
  safeParamsJson,
} from "./types";

/** 收藏 / 预设只在首次打开时拉取；后续增删由 store 局部更新 */
export function usePromptAssetsBootstrap(): void {
  useEffect(() => {
    const store = usePromptAssetsStore.getState();
    if (!store.loaded) void store.load();
  }, []);
}

export function useTemplates() {
  const [builtin, setBuiltin] = useState<PromptTemplate[]>([]);
  const [custom, setCustom] = useState<PromptTemplate[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const [newText, setNewText] = useState("");

  useEffect(() => {
    api
      .getPromptTemplates()
      .then((r) => {
        setBuiltin(r.builtin);
        setCustom(r.custom);
      })
      .catch(() => undefined);
  }, []);

  const addCustom = async () => {
    if (!newTitle.trim() || !newText.trim()) return;
    const next = [
      ...custom,
      {
        id: `c_${Date.now()}`,
        title: newTitle.trim(),
        text: newText.trim(),
      },
    ];
    setCustom(next);
    await api.savePromptTemplates(next).catch(() => undefined);
    setNewTitle("");
    setNewText("");
  };

  const removeCustom = async (id: string) => {
    const next = custom.filter((c) => c.id !== id);
    setCustom(next);
    await api.savePromptTemplates(next).catch(() => undefined);
  };

  return {
    builtin,
    custom,
    newTitle,
    setNewTitle,
    newText,
    setNewText,
    addCustom,
    removeCustom,
  };
}

export function useInspiration() {
  const [inspiration, setInspiration] = useState(rollInspiration);
  return {
    inspiration,
    roll: () => setInspiration(rollInspiration()),
  };
}

export function useReverse() {
  const [img, setImg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AdapterError | null>(null);
  const [result, setResult] = useState("");

  const run = async (file: File) => {
    const dataUrl = await readFileAsDataUrl(file);
    setImg(dataUrl);
    setBusy(true);
    setError(null);
    setResult("");
    try {
      const r = await api.reversePrompt(dataUrl);
      if (r.ok && r.prompt) {
        setResult(r.prompt);
      } else if (r.error) {
        setError(r.error);
      }
    } catch (e) {
      setError({ type: "other", message: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return { img, busy, error, result, setResult, run };
}

export function useFavorites(draft: string) {
  const { t } = useTranslation();
  const favorites = usePromptAssetsStore((s) => s.favorites);
  const [favTags, setFavTags] = useState("");
  const [favTagFilter, setFavTagFilter] = useState("");

  const addFavorite = async () => {
    const text = draft.trim();
    if (!text) return;
    const res = await usePromptAssetsStore
      .getState()
      .upsertFavorite(text, parseTagInput(favTags));
    if (res === "created") toast(t("已收藏当前提示词"));
    if (res === "updated") toast(t("该提示词已存在，已更新收藏"));
    if (res) setFavTags("");
  };

  const removeFavorite = (id: number) => {
    void usePromptAssetsStore.getState().removeFavorite(id);
  };

  const exportFavorites = () => {
    if (favorites.length === 0) {
      toast(t("还没有可导出的收藏"), "error");
      return;
    }
    void downloadJson(
      `moling_favorites_${Date.now()}.json`,
      {
        version: 1,
        type: "moling-favorites",
        favorites: favorites.map((f) => ({
          text: f.text,
          tags: f.tags,
          createdAt: f.createdAt,
        })),
      },
      t("导出失败"),
    );
  };

  const importFavorites = async (file: File) => {
    try {
      const data = JSON.parse(await readFileAsText(file));
      if (data?.type !== "moling-favorites" || !Array.isArray(data.favorites)) {
        throw new Error(t("文件格式不正确"));
      }
      let ok = 0;
      for (const item of data.favorites) {
        if (typeof item?.text !== "string" || !item.text.trim()) continue;
        const tags = Array.isArray(item.tags)
          ? item.tags.filter((t: unknown) => typeof t === "string")
          : [];
        const res = await usePromptAssetsStore
          .getState()
          .upsertFavorite(item.text, tags);
        if (res) ok += 1;
      }
      toast(
        ok > 0
          ? t("已导入 {{n}} 条收藏", { n: ok })
          : t("文件中没有可导入的收藏"),
        ok > 0 ? "info" : "error",
      );
    } catch (e) {
      toast(t("导入收藏失败：{{error}}", { error: String(e) }), "error");
    }
  };

  const allTags = Array.from(new Set(favorites.flatMap((f) => f.tags)));
  const visibleFavorites = favTagFilter
    ? favorites.filter((f) => f.tags.includes(favTagFilter))
    : favorites;

  return {
    favorites,
    totalCount: favorites.length,
    favTags,
    setFavTags,
    favTagFilter,
    setFavTagFilter,
    allTags,
    visibleFavorites,
    addFavorite,
    removeFavorite,
    exportFavorites,
    importFavorites,
  };
}

export function usePresets(draft: string, onClose: () => void) {
  const { t } = useTranslation();
  const presets = usePromptAssetsStore((s) => s.presets);
  const [presetName, setPresetName] = useState("");
  const [presetBusy, setPresetBusy] = useState(false);

  const saveCurrentPreset = async () => {
    const name = presetName.trim();
    if (!name) return;
    const attachments = useChatStore.getState().attachments;
    const prefs = useAppStore.getState().prefs;
    setPresetBusy(true);
    try {
      const refs: PresetRef[] = [];
      for (const att of attachments.slice(0, 4)) {
        const path = att.path ?? (await api.saveReferenceImage(att.dataUrl));
        refs.push({
          path,
          role: att.role ?? "composition",
          strength: att.strength ?? 60,
        });
      }
      const saved = await usePromptAssetsStore.getState().savePreset({
        name,
        prompt: draft.trim(),
        negativePrompt: prefs.negativePrompt,
        params: {
          ratio: prefs.ratio,
          width: prefs.width,
          height: prefs.height,
          quality: prefs.quality,
          style: prefs.style,
          count: prefs.count,
        },
        refs,
      });
      if (saved) {
        toast(t("已保存预设「{{name}}」", { name: saved.name }));
        setPresetName("");
        if (attachments.length > 4) {
          toast(t("预设最多保存 4 张参考图，已取前 4 张"), "error");
        }
      }
    } catch (e) {
      toast(t("保存预设失败：{{error}}", { error: String(e) }), "error");
    } finally {
      setPresetBusy(false);
    }
  };

  const applyPreset = async (preset: WorkflowPreset) => {
    await usePromptAssetsStore.getState().applyPreset(preset);
    onClose();
  };

  const removePreset = (id: number) => {
    void usePromptAssetsStore.getState().removePreset(id);
  };

  const exportPresets = async () => {
    if (presets.length === 0) {
      toast(t("还没有可导出的预设"), "error");
      return;
    }
    let skipped = 0;
    const out = [];
    for (const p of presets) {
      const refs: Array<{ role: string; strength: number; dataUrl: string }> =
        [];
      for (const r of p.refs) {
        try {
          refs.push({
            role: r.role,
            strength: r.strength,
            dataUrl: await api.readReferenceImage(r.path),
          });
        } catch {
          skipped += 1;
        }
      }
      out.push({
        name: p.name,
        prompt: p.prompt,
        negativePrompt: p.negativePrompt,
        params: safeParamsJson(p.paramsJson),
        refs,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      });
    }
    void downloadJson(
      `moling_presets_${Date.now()}.json`,
      {
        version: 1,
        type: "moling-presets",
        presets: out,
      },
      t("导出失败"),
    );
    if (skipped > 0) {
      toast(t("已导出预设，{{n}} 张参考图缺失被跳过", { n: skipped }), "error");
    }
  };

  const importPresets = async (file: File) => {
    try {
      const data = JSON.parse(await readFileAsText(file));
      if (data?.type !== "moling-presets" || !Array.isArray(data.presets)) {
        throw new Error(t("文件格式不正确"));
      }
      let ok = 0;
      let failed = 0;
      for (const item of data.presets) {
        try {
          const name = typeof item?.name === "string" ? item.name.trim() : "";
          if (!name) {
            failed += 1;
            continue;
          }
          const refs: PresetRef[] = [];
          const rawRefs = Array.isArray(item.refs) ? item.refs.slice(0, 4) : [];
          for (const r of rawRefs) {
            if (
              typeof r?.dataUrl !== "string" ||
              !r.dataUrl.startsWith("data:image/")
            ) {
              continue;
            }
            const path = await api.saveReferenceImage(r.dataUrl);
            const strength = Number(r.strength);
            refs.push({
              path,
              role: VALID_ROLES.includes(r.role) ? r.role : "composition",
              strength: Number.isFinite(strength)
                ? Math.min(100, Math.max(0, Math.round(strength)))
                : 60,
            });
          }
          const saved = await usePromptAssetsStore.getState().savePreset({
            name,
            prompt: typeof item.prompt === "string" ? item.prompt : "",
            negativePrompt:
              typeof item.negativePrompt === "string"
                ? item.negativePrompt
                : "",
            params:
              item.params &&
              typeof item.params === "object" &&
              !Array.isArray(item.params)
                ? item.params
                : {},
            refs,
          });
          if (saved) ok += 1;
          else failed += 1;
        } catch {
          failed += 1;
        }
      }
      toast(
        failed > 0
          ? t("已导入 {{ok}} 个预设，{{failed}} 个失败", { ok, failed })
          : t("已导入 {{ok}} 个预设", { ok }),
        ok > 0 ? "info" : "error",
      );
    } catch (e) {
      toast(t("导入预设失败：{{error}}", { error: String(e) }), "error");
    }
  };

  return {
    presets,
    presetName,
    setPresetName,
    presetBusy,
    saveCurrentPreset,
    applyPreset,
    removePreset,
    exportPresets,
    importPresets,
  };
}

export function useOptimize(draft: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AdapterError | null>(null);
  const [result, setResult] = useState("");

  const run = async () => {
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    setResult("");
    try {
      const r = await api.optimizePrompt(text);
      if (r.ok && r.optimized) {
        setResult(r.optimized);
      } else if (r.error) {
        setError(r.error);
      }
    } catch (e) {
      setError({ type: "other", message: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, result, setResult, run };
}

export function useTranslate(draft: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AdapterError | null>(null);
  const [result, setResult] = useState("");

  const run = async () => {
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    setResult("");
    try {
      const r = await api.translatePrompt(text);
      if (r.ok && r.translated) {
        setResult(r.translated);
      } else if (r.error) {
        setError(r.error);
      }
    } catch (e) {
      setError({ type: "other", message: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, result, setResult, run };
}
