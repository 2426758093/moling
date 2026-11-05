import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  api,
  PromptTemplate,
  AdapterError,
  adapterErrorTitle,
  PresetRef,
  WorkflowPreset,
} from "../lib/api";
import { readFileAsDataUrl, readFileAsText } from "../lib/file";
import { saveTextFile } from "../lib/save";
import { qualityLabel } from "../lib/presets";
import { DUR, EASE } from "../lib/motion";
import { toast } from "../lib/notify";
import { useChatStore } from "../stores/chatStore";
import { useAppStore } from "../stores/appStore";
import { usePromptAssetsStore } from "../stores/promptAssetsStore";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Input, Textarea } from "./ui/Field";
import { SegmentedControl } from "./ui/SegmentedControl";
import SafeImg from "./SafeImg";
import { IconSparkle, IconImage, IconClose, IconTrash } from "./Icons";

const SUBJECTS = [
  "一只橘猫",
  "古风少女",
  "未来机甲",
  "山间古寺",
  "蒸汽火车",
  "深海鲸鱼",
  "竹林剑客",
  "玻璃花房",
  "沙漠旅人",
  "云端城市",
];
const SCENES = [
  "在暴雨夜",
  "于晨光之中",
  "漂浮在太空",
  "被樱花环绕",
  "在霓虹灯下",
  "于云海之上",
  "在古老图书馆",
  "伴着极光",
  "在无人海滩",
  "于金色麦田",
];
const STYLES = [
  "赛博朋克",
  "水彩画",
  "吉卜力动画",
  "写实摄影",
  "浮世绘",
  "低多边形 3D",
  "黑白胶片",
  "像素艺术",
  "油画",
  "概念设计稿",
];
const LIGHTS = [
  "逆光轮廓光",
  "柔和的窗光",
  "戏剧化聚光",
  "月光冷色调",
  "暖色黄昏光",
  "霓虹反射光",
  "薄雾散射光",
  "闪电瞬间",
  "烛光摇曳",
  "正午硬光",
];

const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];

const TABS = [
  { id: "optimize", label: "优化" },
  { id: "templates", label: "模板" },
  { id: "inspire", label: "灵感" },
  { id: "reverse", label: "反推" },
  { id: "favorites", label: "收藏" },
  { id: "presets", label: "预设" },
  { id: "translate", label: "翻译" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function rollInspiration(): string {
  return `${pick(SUBJECTS)}${pick(SCENES)}，${pick(STYLES)}风格，${pick(LIGHTS)}`;
}

/** 与后端 translation_direction 同规则：含 CJK 汉字按中→英 */
function isCJK(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

function parseTagInput(raw: string): string[] {
  return raw
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 8);
}

async function downloadJson(filename: string, data: unknown): Promise<void> {
  try {
    await saveTextFile(JSON.stringify(data, null, 2), filename);
  } catch {
    toast("导出失败", "error");
  }
}

function presetRefSummary(p: WorkflowPreset): string {
  try {
    const v = JSON.parse(p.paramsJson);
    const parts: string[] = [];
    if (typeof v?.ratio === "string")
      parts.push(
        v.ratio === "custom" ? "自定义" : v.ratio === "auto" ? "自动" : v.ratio,
      );
    if (
      typeof v?.width === "number" &&
      typeof v?.height === "number" &&
      (v.width > 0 || v.height > 0)
    ) {
      parts.push(`${v.width}×${v.height}`);
    }
    if (typeof v?.quality === "string" && v.quality !== "auto") {
      parts.push(`质量 ${qualityLabel(v.quality)}`);
    }
    if (p.refs.length > 0) parts.push(`${p.refs.length} 参考图`);
    return parts.join(" · ");
  } catch {
    return p.refs.length > 0 ? `${p.refs.length} 参考图` : "";
  }
}

function safeParamsJson(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

const VALID_ROLES = ["composition", "style", "face", "element"];

export default function PromptAssist({
  draft,
  onClose,
}: {
  draft: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<TabId>("templates");
  const setDraftPrompt = useChatStore((s) => s.setDraftPrompt);
  const favorites = usePromptAssetsStore((s) => s.favorites);
  const presets = usePromptAssetsStore((s) => s.presets);

  // 模板
  const [builtin, setBuiltin] = useState<PromptTemplate[]>([]);
  const [custom, setCustom] = useState<PromptTemplate[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const [newText, setNewText] = useState("");

  // 灵感
  const [inspiration, setInspiration] = useState(rollInspiration);

  // 反推
  const fileRef = useRef<HTMLInputElement>(null);
  const [reverseImg, setReverseImg] = useState<string | null>(null);
  const [reverseBusy, setReverseBusy] = useState(false);
  const [reverseError, setReverseError] = useState<AdapterError | null>(null);
  const [reverseResult, setReverseResult] = useState("");

  // 收藏
  const [favTags, setFavTags] = useState("");
  const [favTagFilter, setFavTagFilter] = useState("");
  const favFileRef = useRef<HTMLInputElement>(null);

  // 预设
  const [presetName, setPresetName] = useState("");
  const [presetBusy, setPresetBusy] = useState(false);
  const presetFileRef = useRef<HTMLInputElement>(null);

  // 优化
  const [optimizeBusy, setOptimizeBusy] = useState(false);
  const [optimizeError, setOptimizeError] = useState<AdapterError | null>(null);
  const [optimizeResult, setOptimizeResult] = useState("");

  // 翻译
  const [translateBusy, setTranslateBusy] = useState(false);
  const [translateError, setTranslateError] = useState<AdapterError | null>(
    null,
  );
  const [translateResult, setTranslateResult] = useState("");

  useEffect(() => {
    api
      .getPromptTemplates()
      .then((r) => {
        setBuiltin(r.builtin);
        setCustom(r.custom);
      })
      .catch(() => undefined);
  }, []);

  // 收藏 / 预设只在首次打开时拉取；后续增删由 store 局部更新
  useEffect(() => {
    const store = usePromptAssetsStore.getState();
    if (!store.loaded) void store.load();
  }, []);

  const applyText = (text: string) => {
    setDraftPrompt(text);
    onClose();
  };

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

  const doReverse = async (file: File) => {
    const dataUrl = await readFileAsDataUrl(file);
    setReverseImg(dataUrl);
    setReverseBusy(true);
    setReverseError(null);
    setReverseResult("");
    try {
      const r = await api.reversePrompt(dataUrl);
      if (r.ok && r.prompt) {
        setReverseResult(r.prompt);
      } else if (r.error) {
        setReverseError(r.error);
      }
    } catch (e) {
      setReverseError({ type: "other", message: String(e) });
    } finally {
      setReverseBusy(false);
    }
  };

  const addFavorite = async () => {
    const text = draft.trim();
    if (!text) return;
    const res = await usePromptAssetsStore
      .getState()
      .upsertFavorite(text, parseTagInput(favTags));
    if (res === "created") toast("已收藏当前提示词");
    if (res === "updated") toast("该提示词已存在，已更新收藏");
    if (res) setFavTags("");
  };

  const exportFavorites = () => {
    if (favorites.length === 0) {
      toast("还没有可导出的收藏", "error");
      return;
    }
    void downloadJson(`moling_favorites_${Date.now()}.json`, {
      version: 1,
      type: "moling-favorites",
      favorites: favorites.map((f) => ({
        text: f.text,
        tags: f.tags,
        createdAt: f.createdAt,
      })),
    });
  };

  const importFavorites = async (file: File) => {
    try {
      const data = JSON.parse(await readFileAsText(file));
      if (data?.type !== "moling-favorites" || !Array.isArray(data.favorites)) {
        throw new Error("文件格式不正确");
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
        ok > 0 ? `已导入 ${ok} 条收藏` : "文件中没有可导入的收藏",
        ok > 0 ? "info" : "error",
      );
    } catch (e) {
      toast(`导入收藏失败：${String(e)}`, "error");
    }
  };

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
        toast(`已保存预设「${saved.name}」`);
        setPresetName("");
        if (attachments.length > 4) {
          toast("预设最多保存 4 张参考图，已取前 4 张", "error");
        }
      }
    } catch (e) {
      toast(`保存预设失败：${String(e)}`, "error");
    } finally {
      setPresetBusy(false);
    }
  };

  const applyPreset = async (preset: WorkflowPreset) => {
    await usePromptAssetsStore.getState().applyPreset(preset);
    onClose();
  };

  const exportPresets = async () => {
    if (presets.length === 0) {
      toast("还没有可导出的预设", "error");
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
    void downloadJson(`moling_presets_${Date.now()}.json`, {
      version: 1,
      type: "moling-presets",
      presets: out,
    });
    if (skipped > 0) {
      toast(`已导出预设，${skipped} 张参考图缺失被跳过`, "error");
    }
  };

  const importPresets = async (file: File) => {
    try {
      const data = JSON.parse(await readFileAsText(file));
      if (data?.type !== "moling-presets" || !Array.isArray(data.presets)) {
        throw new Error("文件格式不正确");
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
        `已导入 ${ok} 个预设${failed > 0 ? `，${failed} 个失败` : ""}`,
        ok > 0 ? "info" : "error",
      );
    } catch (e) {
      toast(`导入预设失败：${String(e)}`, "error");
    }
  };

  const doOptimize = async () => {
    const text = draft.trim();
    if (!text) return;
    setOptimizeBusy(true);
    setOptimizeError(null);
    setOptimizeResult("");
    try {
      const r = await api.optimizePrompt(text);
      if (r.ok && r.optimized) {
        setOptimizeResult(r.optimized);
      } else if (r.error) {
        setOptimizeError(r.error);
      }
    } catch (e) {
      setOptimizeError({ type: "other", message: String(e) });
    } finally {
      setOptimizeBusy(false);
    }
  };

  const doTranslate = async () => {
    const text = draft.trim();
    if (!text) return;
    setTranslateBusy(true);
    setTranslateError(null);
    setTranslateResult("");
    try {
      const r = await api.translatePrompt(text);
      if (r.ok && r.translated) {
        setTranslateResult(r.translated);
      } else if (r.error) {
        setTranslateError(r.error);
      }
    } catch (e) {
      setTranslateError({ type: "other", message: String(e) });
    } finally {
      setTranslateBusy(false);
    }
  };

  const allTags = Array.from(new Set(favorites.flatMap((f) => f.tags)));
  const visibleFavorites = favTagFilter
    ? favorites.filter((f) => f.tags.includes(favTagFilter))
    : favorites;
  const directionLabel = isCJK(draft) ? "中 → 英" : "英 → 中";

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 10 }}
      transition={{ duration: DUR.base, ease: EASE.ios }}
      className="glass absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-pop border border-line shadow-sheet"
    >
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0 overflow-x-auto">
          <SegmentedControl
            value={tab}
            onValueChange={setTab}
            label="提示词助手分区"
            size="sm"
            options={TABS.map((t) => ({ value: t.id, label: t.label }))}
          />
        </div>
        <IconButton
          label="关闭提示词助手"
          icon={<IconClose size={14} />}
          size="sm"
          onClick={onClose}
        />
      </div>

      <div className="max-h-72 overflow-y-auto p-3">
        {tab === "optimize" && (
          <div className="space-y-2.5">
            <div className="rounded-btn bg-fill px-3 py-2 text-footnote leading-snug text-secondary">
              {draft.trim() || "先在输入框写好提示词，再回来优化"}
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-caption text-tertiary">
                补全场景、构图、光线与质感，保留原意
                {!draft.trim() && "（需要先输入内容）"}
              </span>
              <Button
                size="sm"
                icon={<IconSparkle size={13} />}
                disabled={!draft.trim() || optimizeBusy}
                onClick={() => void doOptimize()}
              >
                {optimizeBusy ? "优化中…" : "优化"}
              </Button>
            </div>
            {optimizeError && (
              <div className="text-footnote leading-snug text-danger">
                {adapterErrorTitle(optimizeError)}
                <div className="mt-0.5 break-all text-caption text-tertiary">
                  {optimizeError.message}
                </div>
              </div>
            )}
            {optimizeResult && !optimizeBusy && (
              <>
                <Textarea
                  value={optimizeResult}
                  onChange={(e) => setOptimizeResult(e.target.value)}
                  rows={3}
                  compact
                  aria-label="优化结果"
                />
                <Button
                  size="sm"
                  variant="primary"
                  block
                  onClick={() => applyText(optimizeResult)}
                >
                  填入输入框
                </Button>
              </>
            )}
          </div>
        )}

        {tab === "templates" && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-1.5">
              {builtin.map((t) => (
                <button
                  key={t.id}
                  onClick={() => applyText(t.text)}
                  className="pressable rounded-btn border border-line px-3 py-2 text-left transition-colors duration-150 hover:border-accent hover:bg-accent-soft"
                >
                  <div className="text-subhead font-medium text-primary">
                    {t.title}
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-footnote leading-snug text-tertiary">
                    {t.text}
                  </div>
                </button>
              ))}
            </div>
            {custom.length > 0 && (
              <div className="space-y-1.5 border-t border-line pt-2.5">
                {custom.map((t) => (
                  <div
                    key={t.id}
                    className="group flex items-center gap-2 rounded-btn border border-line px-3 py-2"
                  >
                    <button
                      onClick={() => applyText(t.text)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="text-subhead font-medium text-primary">
                        {t.title}
                      </div>
                      <div className="mt-0.5 truncate text-footnote text-tertiary">
                        {t.text}
                      </div>
                    </button>
                    <IconButton
                      label={`删除模板 ${t.title}`}
                      icon={<IconTrash size={13} />}
                      size="sm"
                      tooltip={false}
                      className="text-tertiary hover:text-danger"
                      onClick={() => void removeCustom(t.id)}
                    />
                  </div>
                ))}
              </div>
            )}
            <div className="space-y-1.5 border-t border-line pt-2.5">
              <Input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="模板名称"
                aria-label="模板名称"
              />
              <Textarea
                value={newText}
                onChange={(e) => setNewText(e.target.value)}
                rows={2}
                compact
                placeholder="模板内容（提示词，{subject} 可作占位）"
                aria-label="模板内容"
              />
              <Button
                size="sm"
                block
                disabled={!newTitle.trim() || !newText.trim()}
                onClick={() => void addCustom()}
              >
                保存为自定义模板
              </Button>
            </div>
          </div>
        )}

        {tab === "inspire" && (
          <div className="flex flex-col items-center gap-3 py-2">
            <div className="w-full rounded-btn bg-fill px-4 py-3 text-center text-subhead leading-relaxed text-primary">
              {inspiration}
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                icon={<IconSparkle size={13} />}
                onClick={() => setInspiration(rollInspiration())}
              >
                再掷一次
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => applyText(inspiration)}
              >
                使用这条
              </Button>
            </div>
          </div>
        )}

        {tab === "reverse" && (
          <div className="space-y-2.5">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) doReverse(f);
                e.target.value = "";
              }}
            />
            {!reverseImg ? (
              <button
                onClick={() => fileRef.current?.click()}
                className="pressable flex w-full flex-col items-center gap-2 rounded-btn border border-dashed border-line py-6 text-tertiary transition-colors hover:bg-hover hover:text-secondary"
              >
                <IconImage size={22} strokeWidth={1.4} />
                <span className="text-footnote">上传图片，反推绘制提示词</span>
              </button>
            ) : (
              <div className="flex gap-2.5">
                <SafeImg
                  src={reverseImg}
                  alt="反推对象"
                  className="h-16 w-16 shrink-0 rounded-xl border border-line object-cover"
                />
                <div className="min-w-0 flex-1">
                  {reverseBusy ? (
                    <div className="flex h-16 items-center gap-2 text-footnote text-tertiary">
                      <span className="flex gap-1">
                        <span className="thinking-dot h-1.5 w-1.5 rounded-pill bg-accent" />
                        <span className="thinking-dot h-1.5 w-1.5 rounded-pill bg-accent" />
                        <span className="thinking-dot h-1.5 w-1.5 rounded-pill bg-accent" />
                      </span>
                      正在反推…
                    </div>
                  ) : reverseError ? (
                    <div className="text-footnote leading-snug text-danger">
                      {adapterErrorTitle(reverseError)}
                      <div className="mt-0.5 break-all text-caption text-tertiary">
                        {reverseError.message}
                      </div>
                    </div>
                  ) : (
                    <Textarea
                      value={reverseResult}
                      onChange={(e) => setReverseResult(e.target.value)}
                      rows={3}
                      compact
                      aria-label="反推结果"
                    />
                  )}
                </div>
              </div>
            )}
            {reverseResult && !reverseBusy && (
              <div className="flex justify-end gap-2">
                <Button size="sm" onClick={() => fileRef.current?.click()}>
                  换一张
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => applyText(reverseResult)}
                >
                  填入输入框
                </Button>
              </div>
            )}
          </div>
        )}

        {tab === "favorites" && (
          <div className="space-y-2.5">
            <div className="flex items-center gap-1.5">
              <Input
                value={favTags}
                onChange={(e) => setFavTags(e.target.value)}
                placeholder="标签，逗号分隔（可选）"
                aria-label="收藏标签"
              />
              <Button
                size="sm"
                variant="primary"
                disabled={!draft.trim()}
                onClick={() => void addFavorite()}
              >
                收藏当前
              </Button>
            </div>
            {allTags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                <button
                  onClick={() => setFavTagFilter("")}
                  className={`pressable rounded-pill px-2 py-0.5 text-caption transition-colors ${
                    favTagFilter === ""
                      ? "bg-accent-soft text-accent-text"
                      : "bg-fill text-tertiary hover:text-secondary"
                  }`}
                >
                  全部
                </button>
                {allTags.map((tag) => (
                  <button
                    key={tag}
                    onClick={() =>
                      setFavTagFilter(favTagFilter === tag ? "" : tag)
                    }
                    className={`pressable rounded-pill px-2 py-0.5 text-caption transition-colors ${
                      favTagFilter === tag
                        ? "bg-accent-soft text-accent-text"
                        : "bg-fill text-tertiary hover:text-secondary"
                    }`}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}
            <div className="space-y-1.5">
              {visibleFavorites.map((f) => (
                <div
                  key={f.id}
                  className="group flex items-start gap-2 rounded-btn border border-line px-3 py-2"
                >
                  <button
                    onClick={() => applyText(f.text)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="line-clamp-2 text-footnote leading-snug text-primary">
                      {f.text}
                    </div>
                    {f.tags.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {f.tags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded-pill bg-fill px-1.5 py-0.5 text-caption text-tertiary"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </button>
                  <IconButton
                    label={`删除收藏：${f.text.slice(0, 20)}`}
                    icon={<IconTrash size={13} />}
                    size="sm"
                    tooltip={false}
                    className="text-tertiary hover:text-danger"
                    onClick={() =>
                      void usePromptAssetsStore.getState().removeFavorite(f.id)
                    }
                  />
                </div>
              ))}
              {visibleFavorites.length === 0 && (
                <div className="py-4 text-center text-footnote text-tertiary">
                  {favorites.length === 0
                    ? "还没有收藏，先在输入框写好提示词"
                    : "该标签下没有收藏"}
                </div>
              )}
            </div>
            <div className="flex items-center justify-between border-t border-line pt-2.5">
              <Button size="sm" onClick={exportFavorites}>
                导出 JSON
              </Button>
              <Button size="sm" onClick={() => favFileRef.current?.click()}>
                导入 JSON
              </Button>
              <input
                ref={favFileRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importFavorites(f);
                  e.target.value = "";
                }}
              />
            </div>
          </div>
        )}

        {tab === "presets" && (
          <div className="space-y-2.5">
            <div className="flex items-center gap-1.5">
              <Input
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                placeholder="预设名称"
                aria-label="预设名称"
              />
              <Button
                size="sm"
                variant="primary"
                disabled={!presetName.trim() || presetBusy}
                onClick={() => void saveCurrentPreset()}
              >
                {presetBusy ? "保存中…" : "保存当前"}
              </Button>
            </div>
            <div className="text-caption leading-snug text-tertiary">
              保存草稿、负向词、尺寸 / 比例 / 风格 / 张数，以及当前参考图（最多
              4 张）
            </div>
            <div className="space-y-1.5">
              {presets.map((p) => (
                <div
                  key={p.id}
                  className="group flex items-center gap-2 rounded-btn border border-line px-3 py-2"
                >
                  <button
                    onClick={() => void applyPreset(p)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-subhead font-medium text-primary">
                        {p.name}
                      </span>
                      <span className="shrink-0 text-caption text-tertiary">
                        {presetRefSummary(p)}
                      </span>
                    </div>
                    <div className="mt-0.5 line-clamp-1 text-footnote text-tertiary">
                      {p.prompt || "（无提示词）"}
                    </div>
                  </button>
                  <IconButton
                    label={`删除预设 ${p.name}`}
                    icon={<IconTrash size={13} />}
                    size="sm"
                    tooltip={false}
                    className="text-tertiary hover:text-danger"
                    onClick={() =>
                      void usePromptAssetsStore.getState().removePreset(p.id)
                    }
                  />
                </div>
              ))}
              {presets.length === 0 && (
                <div className="py-4 text-center text-footnote text-tertiary">
                  还没有预设，命名后点击「保存当前」
                </div>
              )}
            </div>
            <div className="flex items-center justify-between border-t border-line pt-2.5">
              <Button size="sm" onClick={() => void exportPresets()}>
                导出 JSON
              </Button>
              <Button size="sm" onClick={() => presetFileRef.current?.click()}>
                导入 JSON
              </Button>
              <input
                ref={presetFileRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importPresets(f);
                  e.target.value = "";
                }}
              />
            </div>
          </div>
        )}

        {tab === "translate" && (
          <div className="space-y-2.5">
            <div className="rounded-btn bg-fill px-3 py-2 text-footnote leading-snug text-secondary">
              {draft.trim() || "先在输入框写好提示词，再回来翻译"}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-caption text-tertiary">
                方向：{directionLabel}
                {!draft.trim() && "（需要先输入内容）"}
              </span>
              <Button
                size="sm"
                icon={<IconSparkle size={13} />}
                disabled={!draft.trim() || translateBusy}
                onClick={() => void doTranslate()}
              >
                {translateBusy ? "翻译中…" : "翻译"}
              </Button>
            </div>
            {translateError && (
              <div className="text-footnote leading-snug text-danger">
                {adapterErrorTitle(translateError)}
                <div className="mt-0.5 break-all text-caption text-tertiary">
                  {translateError.message}
                </div>
              </div>
            )}
            {translateResult && !translateBusy && (
              <>
                <Textarea
                  value={translateResult}
                  onChange={(e) => setTranslateResult(e.target.value)}
                  rows={3}
                  compact
                  aria-label="翻译结果"
                />
                <Button
                  size="sm"
                  variant="primary"
                  block
                  onClick={() => applyText(translateResult)}
                >
                  填入输入框
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}
