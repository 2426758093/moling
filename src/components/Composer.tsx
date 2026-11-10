import {
  useRef,
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import { useChatStore } from "../stores/chatStore";
import {
  useAppStore,
  SIZE_MIN,
  SIZE_MAX,
  type GenPrefs,
} from "../stores/appStore";
import { useProviderStore } from "../stores/providerStore";
import { useQueueStore } from "../stores/queueStore";
import {
  RATIO_OPTIONS,
  COMPLEXITY_OPTIONS,
  GIF_FRAME_MIN,
  GIF_FRAME_MAX,
  GIF_FRAME_MS_MIN,
  GIF_FRAME_MS_MAX,
  qualityLabel,
  qualityOptionsFor,
  REFERENCE_ROLES,
  DEFAULT_REFERENCE_STRENGTH,
  ReferenceRole,
  ImageQuality,
  OutputFormat,
  GifComplexity,
} from "../lib/types";
import { api } from "../lib/api";
import { validateImageFile } from "../lib/file";
import { toast } from "../lib/notify";
import { FOCUS_COMPOSER_EVENT, OPEN_ASSIST_EVENT } from "../lib/commands";
import { maxReferenceImages, useModelCaps } from "../lib/useModelCaps";
import {
  MAX_REGIONS,
  REGION_ITEMS,
  writeRegionPrompt,
  type RegionArea,
  type RegionHint,
} from "../lib/regionPrompt";
import { useMotionTokens } from "../lib/useMotion";
import { DUR } from "../lib/motion";
import SafeImg from "./SafeImg";
import { cn } from "./ui/cn";
import { IconButton } from "./ui/IconButton";
import { Button } from "./ui/Button";
import { Popover } from "./ui/Popover";
import { Select } from "./ui/Select";
import { SegmentedControl } from "./ui/SegmentedControl";
import { Slider } from "./ui/Slider";
import {
  IconImage,
  IconClose,
  IconSend,
  IconStop,
  IconChevron,
  IconSparkle,
  IconQueue,
} from "./Icons";
import PromptAssist from "./PromptAssist";
import { Input } from "./ui/Field";
import { useStylePresets } from "../stores/stylePresetStore";

// Radix Select 不接受空字符串作为选项值，空风格需要一个哨兵值
const NONE_STYLE = "none";
const ROLE_ITEMS = REFERENCE_ROLES.map((r) => ({
  value: r.id,
  label: r.label,
}));

/// 输入坞参数行胶囊：24px，文本 11px，只在 hover 时升一档底色
const CHIP =
  "pressable flex h-6 items-center gap-1 rounded-chip px-2 text-caption text-secondary transition-colors hover:bg-hover hover:text-primary";

/// 自定义尺寸行：`Popover` 关闭即卸载，每次打开都从当前 prefs 初始化
function CustomSizeRow({
  width,
  height,
  onApply,
}: {
  width: number;
  height: number;
  onApply: (w: number, h: number) => void;
}) {
  const { t } = useTranslation();
  const [w, setW] = useState(String(width));
  const [h, setH] = useState(String(height));
  const apply = () => {
    const nw = Number(w);
    const nh = Number(h);
    if (!Number.isFinite(nw) || !Number.isFinite(nh)) return;
    onApply(nw, nh);
  };
  return (
    <div>
      <div className="mb-1.5 mt-3.5 text-footnote font-medium text-tertiary">
        {t("自定义尺寸")}
      </div>
      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          inputMode="numeric"
          min={SIZE_MIN}
          max={SIZE_MAX}
          step={8}
          value={w}
          onChange={(e) => setW(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") apply();
          }}
          aria-label={t("宽度")}
          compact
          widthClass="w-20"
        />
        <span className="text-footnote text-tertiary">×</span>
        <Input
          type="number"
          inputMode="numeric"
          min={SIZE_MIN}
          max={SIZE_MAX}
          step={8}
          value={h}
          onChange={(e) => setH(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") apply();
          }}
          aria-label={t("高度")}
          compact
          widthClass="w-20"
        />
        <Button size="sm" variant="secondary" onClick={apply}>
          {t("应用")}
        </Button>
      </div>
      <div className="mt-1.5 text-caption text-tertiary">
        {t("512–4096，自动对齐到 8 的倍数")}
      </div>
    </div>
  );
}

/// 动图参数：帧数 / 逐帧时长 / 复杂度，只在「动图」输出时展开
function GifPanel({
  prefs,
  maxFrames,
  onChange,
}: {
  prefs: GenPrefs;
  maxFrames: number;
  onChange: (patch: Partial<GenPrefs>) => void;
}) {
  const { t } = useTranslation();
  const framesMax = Math.min(
    GIF_FRAME_MAX,
    Math.max(GIF_FRAME_MIN, maxFrames || GIF_FRAME_MAX),
  );
  return (
    <div className="mt-3 space-y-2.5 border-t border-separator pt-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-subhead text-secondary">{t("帧数")}</span>
        <Input
          type="number"
          inputMode="numeric"
          min={GIF_FRAME_MIN}
          max={framesMax}
          step={1}
          value={prefs.frameCount}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!Number.isFinite(n)) return;
            onChange({
              frameCount: Math.min(
                framesMax,
                Math.max(GIF_FRAME_MIN, Math.round(n)),
              ),
            });
          }}
          aria-label={t("动图帧数")}
          compact
          widthClass="w-16"
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-subhead text-secondary">{t("每帧时长")}</span>
        <div className="flex items-center gap-1">
          <Input
            type="number"
            inputMode="numeric"
            min={GIF_FRAME_MS_MIN}
            max={GIF_FRAME_MS_MAX}
            step={10}
            value={prefs.frameDurationMs}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (!Number.isFinite(n)) return;
              const clamped = Math.min(
                GIF_FRAME_MS_MAX,
                Math.max(GIF_FRAME_MS_MIN, n),
              );
              onChange({ frameDurationMs: Math.round(clamped / 10) * 10 });
            }}
            aria-label={t("每帧时长（毫秒）")}
            compact
            widthClass="w-16"
          />
          <span className="text-caption text-tertiary">ms</span>
        </div>
      </div>
      <div>
        <div className="mb-1.5 text-subhead text-secondary">{t("复杂度")}</div>
        <SegmentedControl
          value={prefs.complexity}
          onValueChange={(v) => onChange({ complexity: v as GifComplexity })}
          label={t("动图复杂度")}
          size="sm"
          block
          options={COMPLEXITY_OPTIONS.map((c) => ({
            value: c.id,
            label: t(c.label, c.label),
          }))}
        />
      </div>
      <p className="text-caption text-tertiary">
        {t(
          "20–2000ms，按 10ms 取整；GIF 按 token 计费，需模型开通预览权限，且不支持蒙版编辑。",
        )}
      </p>
    </div>
  );
}

/// 透传参数是自由 JSON：解析失败按空对象处理，避免损坏的配置卡住界面
function parseExtraParams(
  raw: string | null | undefined,
): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const SAMPLING_KEYS = ["guidance", "steps", "seed"] as const;

/// 高级采样参数：写入所选服务商的 extraParams（走既有透传通道，不改标准请求体）
function SamplingPanel({
  raw,
  onSave,
}: {
  raw: string | null | undefined;
  onSave: (next: Record<string, unknown>) => Promise<void>;
}) {
  const current = parseExtraParams(raw);
  const { t } = useTranslation();
  const text = (key: string) =>
    current[key] === undefined ? "" : String(current[key]);
  const [guidance, setGuidance] = useState(() => text("guidance"));
  const [steps, setSteps] = useState(() => text("steps"));
  const [seed, setSeed] = useState(() => text("seed"));
  const [busy, setBusy] = useState(false);

  const apply = async (clear: boolean) => {
    const next = { ...current };
    for (const key of SAMPLING_KEYS) delete next[key];
    if (!clear) {
      const g = guidance.trim();
      const s = steps.trim();
      const sd = seed.trim();
      if (g) {
        const n = Number(g);
        if (!Number.isFinite(n) || n < 0 || n > 30) {
          toast(t("Guidance 应为 0–30 的数字"), "error");
          return;
        }
        next.guidance = n;
      }
      if (s) {
        const n = Number(s);
        if (!Number.isInteger(n) || n < 1 || n > 150) {
          toast(t("Steps 应为 1–150 的整数"), "error");
          return;
        }
        next.steps = n;
      }
      if (sd) {
        const n = Number(sd);
        if (!Number.isInteger(n) || n < 0) {
          toast(t("Seed 应为非负整数"), "error");
          return;
        }
        next.seed = n;
      }
    }
    setBusy(true);
    try {
      await onSave(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-64 space-y-2">
      <div className="text-footnote font-medium text-tertiary">
        {t("高级采样参数")}
      </div>
      <Input
        label="Guidance"
        value={guidance}
        onChange={(e) => setGuidance(e.target.value)}
        placeholder={t("如 7.5（留空不发送）")}
        compact
      />
      <Input
        label="Steps"
        value={steps}
        onChange={(e) => setSteps(e.target.value)}
        placeholder={t("如 30（留空不发送）")}
        compact
      />
      <Input
        label="Seed"
        value={seed}
        onChange={(e) => setSeed(e.target.value)}
        placeholder={t("固定随机种子可复现")}
        compact
      />
      <p className="text-caption text-tertiary">
        {t(
          "写入所选服务商的透传参数，影响该服务商全部请求；部分模型不支持这些字段。",
        )}
      </p>
      <div className="flex justify-end gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void apply(true)}
        >
          {t("清除")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => void apply(false)}
        >
          {t("保存")}
        </Button>
      </div>
    </div>
  );
}

export default function Composer() {
  const { t } = useTranslation();
  // 从画布/画廊切回聊天时 Composer 才挂载，草稿需在首次渲染就进输入框
  const [text, setText] = useState(
    () => useChatStore.getState().draftPrompt ?? "",
  );
  const [assistOpen, setAssistOpen] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [enqueuing, setEnqueuing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const attachments = useChatStore((s) => s.attachments);
  const addFileAttachment = useChatStore((s) => s.addFileAttachment);
  const removeAttachment = useChatStore((s) => s.removeAttachment);
  const updateAttachment = useChatStore((s) => s.updateAttachment);
  const sending = useChatStore((s) => s.sending);
  const stop = useChatStore((s) => s.stop);
  const send = useChatStore((s) => s.send);
  const prefs = useAppStore((s) => s.prefs);
  const setPrefs = useAppStore((s) => s.setPrefs);
  const applyRatio = useAppStore((s) => s.applyRatio);
  const applyCustomSize = useAppStore((s) => s.applyCustomSize);
  const mode = useAppStore((s) => s.mode);
  const stylePresets = useStylePresets();
  const qualityText = qualityLabel(prefs.quality);
  const [samplingOpen, setSamplingOpen] = useState(false);
  const providers = useProviderStore((s) => s.providers);
  const defaultProviderId = useProviderStore((s) => s.defaultProviderId);
  const selectedProvider = providers.find(
    (p) => p.provider.id === defaultProviderId,
  );
  const modelName = selectedProvider?.provider.defaultModel ?? "";
  // 极高 / 最高只有 GPT-Image-2.6 认，其余模型保持四档
  const qualityChoices = qualityOptionsFor(modelName);
  const qualityValue = qualityChoices.some((q) => q.id === prefs.quality)
    ? prefs.quality
    : "auto";
  const samplingAvailable = selectedProvider?.provider.kind === "openai";
  const samplingActive = SAMPLING_KEYS.some(
    (k) =>
      parseExtraParams(selectedProvider?.provider.extraParams)[k] !== undefined,
  );
  const saveSampling = async (next: Record<string, unknown>) => {
    const store = useProviderStore.getState();
    const item = store.providers.find(
      (p) => p.provider.id === store.defaultProviderId,
    );
    if (!item?.provider.id) {
      toast(t("请先选择绘图服务商"), "error");
      return;
    }
    try {
      await store.save({
        ...item.provider,
        extraParams: Object.keys(next).length ? JSON.stringify(next) : null,
      });
      toast(t("已更新采样参数"));
    } catch (e) {
      toast(t("保存失败：{{error}}", { error: String(e) }), "error");
    }
  };
  const caps = useModelCaps();
  const [negOpen, setNegOpen] = useState(false);
  const [regionOpen, setRegionOpen] = useState(false);
  const [regions, setRegions] = useState<RegionHint[]>([
    { area: "left", description: "" },
  ]);
  // 上次写入的区域段：再次写入时先移除旧段，避免重复追加同一块
  const regionBlockRef = useRef<string | null>(null);
  const draftPrompt = useChatStore((s) => s.draftPrompt);
  const setDraftPrompt = useChatStore((s) => s.setDraftPrompt);
  const motionTokens = useMotionTokens();
  // 失焦自动翻译：600ms 去抖，只处理含中文且自上次翻译后未变化的文本
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);
  const translateTimer = useRef<number | null>(null);
  const lastTranslatedSource = useRef<string | null>(null);
  const [autoTranslated, setAutoTranslated] = useState<{
    from: string;
    to: string;
  } | null>(null);

  useEffect(
    () => () => {
      if (translateTimer.current !== null) {
        window.clearTimeout(translateTimer.current);
      }
    },
    [],
  );

  const cancelAutoTranslate = () => {
    if (translateTimer.current !== null) {
      window.clearTimeout(translateTimer.current);
      translateTimer.current = null;
    }
  };

  const runAutoTranslate = async (source: string) => {
    if (useChatStore.getState().sending) return;
    const cfg = await api.getThinkingConfig().catch(() => null);
    if (!cfg?.enabled || !cfg.autoTranslateOnBlur) return;
    if (textRef.current.trim() !== source) return;
    const r = await api.translatePrompt(source).catch(() => null);
    if (!r?.ok || !r.translated) return;
    const translated = r.translated.trim();
    if (!translated || translated === source) return;
    // 翻译期间用户又改了输入：放弃这次结果，避免覆盖新内容
    if (textRef.current.trim() !== source) return;
    lastTranslatedSource.current = source;
    setText(translated);
    setAutoTranslated({ from: source, to: translated });
  };

  const scheduleAutoTranslate = (value: string) => {
    cancelAutoTranslate();
    const source = value.trim();
    if (!source || !/[\u4e00-\u9fff]/.test(source)) return;
    if (lastTranslatedSource.current === source) return;
    translateTimer.current = window.setTimeout(() => {
      translateTimer.current = null;
      void runAutoTranslate(source);
    }, 600);
  };

  const undoAutoTranslate = () => {
    if (!autoTranslated) return;
    // 撤销后同一段文本不再自动翻译，避免失焦又立刻翻回去
    lastTranslatedSource.current = autoTranslated.from;
    setText(autoTranslated.from);
    setAutoTranslated(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 150) + "px";
  }, []);

  // 外部写入的草稿（画廊"复用参数"等）在渲染期间同步进输入框，
  // 替代「effect 内 setState」的反模式（react-hooks/set-state-in-effect）
  const [appliedDraft, setAppliedDraft] = useState(draftPrompt);
  if (draftPrompt !== appliedDraft) {
    setAppliedDraft(draftPrompt);
    if (draftPrompt) {
      setText(draftPrompt);
      setDraftPrompt(null);
    }
  }

  // 挂载时已把草稿写进输入框：清空 store，避免下次切回聊天重复回填
  useEffect(() => {
    if (useChatStore.getState().draftPrompt) {
      useChatStore.getState().setDraftPrompt(null);
    }
  }, []);

  // 命令面板 / 全局快捷键：聚焦输入框、打开提示词助手
  useEffect(() => {
    const focus = () => textareaRef.current?.focus();
    const assist = () => {
      setAssistOpen(true);
      textareaRef.current?.focus();
    };
    window.addEventListener(FOCUS_COMPOSER_EVENT, focus);
    window.addEventListener(OPEN_ASSIST_EVENT, assist);
    return () => {
      window.removeEventListener(FOCUS_COMPOSER_EVENT, focus);
      window.removeEventListener(OPEN_ASSIST_EVENT, assist);
    };
  }, []);

  // text 变化后同步撑高输入框（草稿注入与清空都经此路径）
  useLayoutEffect(() => {
    autoGrow();
  }, [text, autoGrow]);

  const updateRegion = (index: number, patch: Partial<RegionHint>) => {
    setRegions((list) =>
      list.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
  };

  // 区域提示只是把区位描述追加进草稿，不改变请求协议
  const applyRegions = () => {
    const { text: next, block } = writeRegionPrompt(
      text,
      regions,
      regionBlockRef.current,
    );
    if (!block) {
      toast(t("请先填写区域描述"), "error");
      return;
    }
    regionBlockRef.current = block;
    setText(next);
    setDraftPrompt(next);
    setRegionOpen(false);
  };

  const doSend = async () => {
    const value = text;
    // 直接读 store 的实时状态：渲染期闭包里的 sending 可能滞后一帧，
    // 连点/连按 Enter 会重复触发；sending 期间一律直接 return。
    if (!value.trim() || sending || useChatStore.getState().sending) return;
    cancelAutoTranslate();
    lastTranslatedSource.current = null;
    setAutoTranslated(null);
    setText("");
    requestAnimationFrame(autoGrow);
    const accepted = await send(value);
    // 未受理（未配置服务商 / 参考图落盘失败 / 被中止）：回填原文，避免草稿丢失。
    // 用函数式写入，避免覆盖用户在这段 await 期间新输入的内容。
    if (!accepted) {
      setText((current) => current || value);
      requestAnimationFrame(autoGrow);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 中文输入法组合期 Enter 是"上屏"而不是"发送"：必须同时看 isComposing 与
    // keyCode 229（部分 Windows IME 在 compositionend 之前不设 isComposing）。
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // 空输入时 `/` 直接打开提示词助手（Linear/Notion 的斜杠习惯）
    if (e.key === "/" && !text.trim()) {
      e.preventDefault();
      setAssistOpen(true);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  };

  /// 加入队列：快照当前输入与参数；参考图先落盘到 refs/，入队只传路径
  const doEnqueue = async () => {
    const value = text.trim();
    if (!value || enqueuing) return;
    const atts = useChatStore.getState().attachments.slice(0, 4);
    const { providers, defaultProviderId } = useProviderStore.getState();
    const provider = providers.find((p) => p.provider.id === defaultProviderId);
    const model = provider?.provider.defaultModel;
    if (!provider || defaultProviderId == null || !model) {
      toast(t("请先在「设置」中配置绘图服务商与模型"), "error");
      return;
    }
    if (prefs.outputFormat === "gif" && !caps.gif) {
      toast(t("当前模型未开通 GIF 输出，请切换模型或改回静态图"), "error");
      return;
    }
    setEnqueuing(true);
    try {
      const referencePaths = await Promise.all(
        atts.map((a) => api.saveReferenceImage(a.dataUrl)),
      );
      await useQueueStore.getState().enqueue({
        providerId: defaultProviderId,
        prompt: value,
        negativePrompt: prefs.negativePrompt.trim() || null,
        model,
        style: prefs.style,
        width: prefs.width,
        height: prefs.height,
        count: prefs.count,
        quality: prefs.quality === "auto" ? null : prefs.quality,
        outputFormat: prefs.outputFormat === "gif" ? "gif" : null,
        frameCount: prefs.outputFormat === "gif" ? prefs.frameCount : null,
        frameDurationMs:
          prefs.outputFormat === "gif" ? prefs.frameDurationMs : null,
        complexity: prefs.outputFormat === "gif" ? prefs.complexity : null,
        referencePaths,
        references:
          mode === "expert" && atts.length > 0
            ? atts.map((a) => ({
                role: a.role ?? ("composition" as ReferenceRole),
                strength: a.strength ?? DEFAULT_REFERENCE_STRENGTH,
              }))
            : undefined,
      });
      useChatStore.getState().clearAttachments();
      cancelAutoTranslate();
      lastTranslatedSource.current = null;
      setAutoTranslated(null);
      setText("");
      requestAnimationFrame(autoGrow);
      toast(t("已加入队列"));
    } catch (e) {
      toast(t("加入队列失败：{{error}}", { error: String(e) }), "error");
    } finally {
      setEnqueuing(false);
    }
  };

  /// 直接拖到输入框：只认文件类型，事件不冒泡到 App 的全局拖放，
  /// 避免同一次投放被添加两遍（全局拖放仍负责窗口其他区域）
  const dragDepth = useRef(0);
  const [dropActive, setDropActive] = useState(false);
  const isFileDrag = (e: React.DragEvent) =>
    e.dataTransfer.types.includes("Files");

  const onComposerDragEnter = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current += 1;
    setDropActive(true);
  };

  const onComposerDragOver = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  };

  const onComposerDragLeave = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.stopPropagation();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropActive(false);
  };

  const onComposerDrop = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = 0;
    setDropActive(false);
    void onPickFiles(e.dataTransfer.files);
  };

  const onPickFiles = async (files: FileList | null) => {
    if (!files) return;
    const all = Array.from(files);
    const limit = maxReferenceImages();
    const remaining = limit - useChatStore.getState().attachments.length;
    if (remaining <= 0) {
      toast(t("最多添加 {{n}} 张参考图", { n: limit }), "error");
      return;
    }
    if (all.length > remaining) {
      toast(
        t("最多添加 {{n}} 张参考图，已忽略多余文件", { n: limit }),
        "error",
      );
    }
    for (const file of all.slice(0, remaining)) {
      const invalid = await validateImageFile(file);
      if (invalid) {
        toast(invalid, "error");
        continue;
      }
      if (!(await addFileAttachment(file))) break;
    }
  };

  return (
    <div className="shrink-0 px-3 pb-3 pt-1.5">
      <div className="relative mx-auto max-w-chat wide:max-w-chat-wide">
        <AnimatePresence>
          {assistOpen && (
            <PromptAssist draft={text} onClose={() => setAssistOpen(false)} />
          )}
        </AnimatePresence>

        {/* 浮动输入坞：玻璃浮在消息流之上，内部控件全部不透明；
            焦点环画在输入坞上，文本域本身不画——全宽描边会被圆角卡片裁成横条 */}
        <div
          data-dropzone="composer"
          onDragEnter={onComposerDragEnter}
          onDragOver={onComposerDragOver}
          onDragLeave={onComposerDragLeave}
          onDrop={onComposerDrop}
          className={cn(
            // 焦点环用 outline：.glass 自己的 box-shadow 会压过 ring-* 工具类
            "glass relative overflow-hidden rounded-card shadow-pop",
            dropActive
              ? "outline-2 outline-dashed outline-accent/50"
              : inputFocused
                ? "outline-2 outline-accent/25"
                : "outline-none",
          )}
        >
          {dropActive && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-card bg-scrim/30">
              <span className="rounded-pill bg-elevated px-3 py-1 text-footnote text-primary shadow-card">
                {t("松开以添加参考图")}
              </span>
            </div>
          )}
          <AnimatePresence initial={false}>
            {attachments.length > 0 && (
              <motion.div
                initial={
                  motionTokens.reduce
                    ? { opacity: 1 }
                    : { opacity: 0, height: 0 }
                }
                animate={{ opacity: 1, height: "auto" }}
                exit={
                  motionTokens.reduce
                    ? { opacity: 1 }
                    : { opacity: 0, height: 0 }
                }
                transition={motionTokens.fade(DUR.base)}
                className="flex gap-2 overflow-x-auto px-2 pt-2"
              >
                {attachments.map((a) => (
                  <motion.div
                    key={a.id}
                    layout
                    initial={
                      motionTokens.reduce
                        ? { scale: 1 }
                        : { scale: 0.85, opacity: 0 }
                    }
                    animate={{ scale: 1, opacity: 1 }}
                    transition={motionTokens.spring("snappy")}
                    className="group relative shrink-0"
                  >
                    {/* 专家模式：角色 + 强度（提示词级近似）；简单模式只展示缩略图 */}
                    <div
                      className={
                        mode === "expert"
                          ? "w-32 rounded-btn bg-elevated p-1.5 shadow-card ring-1 ring-line"
                          : undefined
                      }
                    >
                      <div className="relative">
                        <SafeImg
                          src={a.dataUrl}
                          alt={a.name}
                          className={
                            mode === "expert"
                              ? "h-14 w-full rounded-chip object-cover ring-1 ring-line"
                              : "h-14 w-14 rounded-btn object-cover shadow-card ring-1 ring-line"
                          }
                        />
                        {a.compressed && (
                          <span className="pointer-events-none absolute bottom-0 left-0 rounded-bl-chip rounded-tr-chip bg-elevated px-1 py-px text-caption leading-none text-tertiary ring-1 ring-line">
                            {t("已压缩")}
                          </span>
                        )}
                        <button
                          onClick={() => removeAttachment(a.id)}
                          aria-label={t("移除附件 {{name}}", { name: a.name })}
                          className="pressable absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-pill bg-elevated text-secondary opacity-0 shadow-card ring-1 ring-line transition-opacity hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                        >
                          <IconClose size={10} />
                        </button>
                      </div>
                      {mode === "expert" && (
                        <>
                          <Select
                            value={a.role ?? "composition"}
                            onValueChange={(v) =>
                              updateAttachment(a.id, {
                                role: v as ReferenceRole,
                              })
                            }
                            options={ROLE_ITEMS.map((r) => ({
                              value: r.value,
                              label: t(r.label, r.label),
                            }))}
                            label={t("{{name}} 的参考角色", { name: a.name })}
                            variant="bare"
                            widthClass="w-full"
                            className="mt-0.5"
                          />
                          <div className="flex items-center gap-1 px-0.5">
                            <Slider
                              value={a.strength ?? DEFAULT_REFERENCE_STRENGTH}
                              onValueChange={(v) =>
                                updateAttachment(a.id, { strength: v })
                              }
                              label={t("参考强度")}
                              className="flex-1"
                            />
                            <span className="w-5 shrink-0 text-right text-caption tabular-nums text-tertiary">
                              {a.strength ?? DEFAULT_REFERENCE_STRENGTH}
                            </span>
                          </div>
                        </>
                      )}
                    </div>
                  </motion.div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>

          {/* 参数摘要：模型能力范围内的快捷入口，全部 24px */}
          <div className="flex flex-wrap items-center gap-1 px-2 pt-2">
            <Popover
              side="top"
              align="start"
              trigger={
                <button className={CHIP} aria-label={t("画面比例与尺寸")}>
                  {prefs.ratio === "auto" ? (
                    t("自动")
                  ) : (
                    <>
                      {RATIO_OPTIONS.find((r) => r.id === prefs.ratio)?.label ??
                        t("自定义")}
                      <span className="text-quaternary">·</span>
                      <span className="tabular-nums">
                        {prefs.width}×{prefs.height}
                      </span>
                    </>
                  )}
                  <IconChevron size={10} direction="down" />
                </button>
              }
            >
              <div className="w-60">
                <div className="mb-2 text-footnote font-medium text-tertiary">
                  {t("画面比例")}
                </div>
                <button
                  onClick={() => applyRatio("auto")}
                  className={`pressable mb-1.5 flex w-full items-center justify-between rounded-btn px-2 py-1.5 text-subhead transition-colors duration-150 ${
                    prefs.ratio === "auto"
                      ? "bg-accent-soft font-medium text-accent-text"
                      : "text-tertiary hover:bg-hover hover:text-secondary"
                  }`}
                >
                  {t("自动")}
                  <span className="text-caption font-normal text-tertiary">
                    {t("由服务商决定")}
                  </span>
                </button>
                <div className="grid grid-cols-4 gap-1.5">
                  {RATIO_OPTIONS.filter((r) => r.id !== "auto").map((r) => (
                    <button
                      key={r.id}
                      onClick={() => applyRatio(r.id)}
                      className={`pressable rounded-btn py-1.5 text-subhead transition-colors duration-150 ${
                        prefs.ratio === r.id
                          ? "bg-accent-soft font-medium text-accent-text"
                          : "text-tertiary hover:bg-hover hover:text-secondary"
                      }`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
                {mode === "expert" && (
                  <CustomSizeRow
                    width={prefs.width}
                    height={prefs.height}
                    onApply={(w, h) => applyCustomSize(w, h)}
                  />
                )}
              </div>
            </Popover>

            <Popover
              side="top"
              align="start"
              trigger={
                <button className={CHIP} aria-label={t("每次生成张数")}>
                  {t("{{n}} 张", { n: prefs.count })}
                  <IconChevron size={10} direction="down" />
                </button>
              }
            >
              <div className="w-40">
                <div className="mb-2 text-footnote font-medium text-tertiary">
                  {t("每次生成")}
                </div>
                <SegmentedControl
                  value={String(prefs.count)}
                  onValueChange={(v) => setPrefs({ count: Number(v) })}
                  label={t("每次生成张数")}
                  size="sm"
                  block
                  options={[1, 2, 4].map((n) => ({
                    value: String(n),
                    label: t("{{n}} 张", { n }),
                  }))}
                />
                {prefs.outputFormat === "gif" && prefs.count > 1 && (
                  <div className="mt-2 text-caption text-tertiary">
                    {t("动图模式下每个数量都会单独调用一次，费用 ×{{n}}", {
                      n: prefs.count,
                    })}
                  </div>
                )}
              </div>
            </Popover>

            {caps.gif && (
              <Popover
                side="top"
                align="start"
                trigger={
                  <button className={CHIP} aria-label={t("输出格式")}>
                    {prefs.outputFormat === "gif" ? t("动图") : t("静态图")}
                    {prefs.outputFormat === "gif" && (
                      <span className="text-quaternary">·</span>
                    )}
                    {prefs.outputFormat === "gif" && (
                      <span className="tabular-nums">
                        {prefs.frameCount}×{prefs.frameDurationMs}ms
                      </span>
                    )}
                    <IconChevron size={10} direction="down" />
                  </button>
                }
              >
                <div className="w-64">
                  <div className="mb-2 text-footnote font-medium text-tertiary">
                    {t("输出格式")}
                  </div>
                  <SegmentedControl
                    value={prefs.outputFormat}
                    onValueChange={(v) =>
                      setPrefs({ outputFormat: v as OutputFormat })
                    }
                    label={t("输出格式")}
                    size="sm"
                    block
                    options={[
                      { value: "png", label: t("静态图") },
                      { value: "gif", label: t("动图") },
                    ]}
                  />
                  {prefs.outputFormat === "gif" && (
                    <GifPanel
                      prefs={prefs}
                      maxFrames={caps.gifMaxFrames}
                      onChange={(patch) => setPrefs(patch)}
                    />
                  )}
                </div>
              </Popover>
            )}

            <Popover
              side="top"
              align="start"
              trigger={
                <button className={CHIP} aria-label={t("图片质量")}>
                  {t("质量")} · {t(qualityText, qualityText)}
                  <IconChevron size={10} direction="down" />
                </button>
              }
            >
              <div className="w-56">
                <div className="mb-2 text-footnote font-medium text-tertiary">
                  {t("图片质量")}
                </div>
                <SegmentedControl
                  value={qualityValue}
                  onValueChange={(v) =>
                    setPrefs({ quality: v as ImageQuality })
                  }
                  label={t("图片质量")}
                  size="sm"
                  block
                  options={qualityChoices.map((q) => ({
                    value: q.id,
                    label: t(q.label, q.label),
                  }))}
                />
                <div className="mt-2 text-caption text-tertiary">
                  {t(
                    "自动不发送质量参数；低 / 中 / 高 / 极高 / 最高需要服务商支持",
                  )}
                </div>
              </div>
            </Popover>

            {mode === "expert" && samplingAvailable && (
              <Popover
                side="top"
                align="start"
                open={samplingOpen}
                onOpenChange={setSamplingOpen}
                trigger={
                  <button
                    className={CHIP}
                    aria-label={t("高级采样参数")}
                    aria-expanded={samplingOpen}
                  >
                    {t("采样")}
                    {samplingActive && (
                      <span className="h-1 w-1 rounded-pill bg-accent-text" />
                    )}
                    <IconChevron size={10} direction="down" />
                  </button>
                }
              >
                <SamplingPanel
                  raw={selectedProvider?.provider.extraParams}
                  onSave={saveSampling}
                />
              </Popover>
            )}

            <Select
              value={prefs.style || NONE_STYLE}
              onValueChange={(v) =>
                setPrefs({ style: v === NONE_STYLE ? "" : v })
              }
              options={[
                { value: NONE_STYLE, label: t("无风格") },
                ...stylePresets.map((p) => ({
                  value: p.prompt,
                  label: p.label,
                })),
              ]}
              label={t("风格")}
              variant="chip"
              widthClass="w-24"
            />

            {mode === "expert" && caps.negative && (
              <Popover
                side="top"
                align="start"
                trigger={
                  <button
                    className={CHIP}
                    aria-label={t("负向提示词")}
                    aria-expanded={negOpen}
                  >
                    {t("负向")}
                    {prefs.negativePrompt.trim() && (
                      <span className="h-1 w-1 rounded-pill bg-accent-text" />
                    )}
                    <IconChevron size={10} direction="down" />
                  </button>
                }
              >
                <div className="w-64">
                  <div className="mb-1.5 text-footnote font-medium text-tertiary">
                    {t("负向提示词")}
                  </div>
                  <Input
                    value={prefs.negativePrompt}
                    onChange={(e) => {
                      setNegOpen(true);
                      setPrefs({ negativePrompt: e.target.value });
                    }}
                    placeholder={t("不希望出现的元素，如：模糊、水印")}
                    aria-label={t("负向提示词内容")}
                    compact
                    widthClass="w-full"
                  />
                </div>
              </Popover>
            )}

            {mode === "expert" && (
              <Popover
                side="top"
                align="start"
                open={regionOpen}
                onOpenChange={setRegionOpen}
                trigger={
                  <button
                    className={CHIP}
                    aria-label={t("区域提示")}
                    aria-expanded={regionOpen}
                  >
                    {t("区域")}
                    {regions.some((r) => r.description.trim()) && (
                      <span className="h-1 w-1 rounded-pill bg-accent-text" />
                    )}
                    <IconChevron size={10} direction="down" />
                  </button>
                }
              >
                <div className="w-72 space-y-2">
                  <div className="text-footnote font-medium text-tertiary">
                    {t("区域提示（最多 {{n}} 个）", { n: MAX_REGIONS })}
                  </div>
                  {regions.map((region, index) => (
                    <div key={index} className="flex items-center gap-1.5">
                      <Select
                        value={region.area}
                        onValueChange={(v) =>
                          updateRegion(index, { area: v as RegionArea })
                        }
                        options={REGION_ITEMS.map((item) => ({
                          value: item.value,
                          label: t(item.label),
                        }))}
                        label={t("区域 {{n}} 位置", { n: index + 1 })}
                        variant="chip"
                        widthClass="w-20"
                      />
                      <Input
                        value={region.description}
                        onChange={(e) =>
                          updateRegion(index, { description: e.target.value })
                        }
                        placeholder={t("该区域画什么")}
                        aria-label={t("区域 {{n}} 描述", { n: index + 1 })}
                        compact
                        widthClass="w-full"
                      />
                      {regions.length > 1 && (
                        <IconButton
                          label={t("删除区域 {{n}}", { n: index + 1 })}
                          icon={<IconClose size={12} />}
                          onClick={() =>
                            setRegions((list) =>
                              list.filter((_, i) => i !== index),
                            )
                          }
                        />
                      )}
                    </div>
                  ))}
                  <div className="flex items-center justify-between gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={regions.length >= MAX_REGIONS}
                      onClick={() =>
                        setRegions((list) => [
                          ...list,
                          { area: "center", description: "" },
                        ])
                      }
                    >
                      {t("添加区域")}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={applyRegions}
                    >
                      {t("写入提示词")}
                    </Button>
                  </div>
                  <p className="text-caption text-tertiary">
                    {t(
                      "按区域逐个描述，模型可能不完全遵循；需要精确改图请用局部重绘。",
                    )}
                  </p>
                </div>
              </Popover>
            )}
          </div>

          {autoTranslated && (
            <div className="flex items-center gap-2 px-3 pt-2 text-caption text-tertiary">
              <span>{t("已自动翻译为英文")}</span>
              <button
                type="button"
                className="pressable text-accent-text"
                onClick={undoAutoTranslate}
              >
                {t("撤销")}
              </button>
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (autoTranslated) setAutoTranslated(null);
              autoGrow();
            }}
            onKeyDown={onKeyDown}
            onFocus={() => setInputFocused(true)}
            onBlur={(e) => {
              setInputFocused(false);
              const to = e.relatedTarget;
              // 失焦到提示词助手不算离开输入：不要在用户挑模板时偷偷翻译
              if (
                to instanceof Element &&
                to.closest("[data-assist-toggle], [data-assist-panel]")
              ) {
                return;
              }
              if (assistOpen) return;
              scheduleAutoTranslate(textRef.current);
            }}
            rows={1}
            placeholder={t("描述你想要的画面…")}
            aria-label={t("提示词")}
            className="block max-h-[150px] w-full resize-none bg-transparent px-3 pb-1 pt-2 text-body leading-relaxed text-primary outline-none placeholder:text-tertiary"
          />

          <div className="flex items-center gap-1 px-1.5 pb-1.5">
            <IconButton
              label={t("提示词助手")}
              icon={<IconSparkle size={18} />}
              variant={assistOpen ? "secondary" : "ghost"}
              aria-expanded={assistOpen}
              data-assist-toggle
              onClick={() => setAssistOpen(!assistOpen)}
            />
            <IconButton
              label={t("参考图")}
              icon={<IconImage size={18} />}
              onClick={() => fileRef.current?.click()}
            />
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                onPickFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <span className="flex-1" />
            {mode === "expert" && (
              <IconButton
                label={t("加入队列")}
                icon={<IconQueue size={18} />}
                disabled={!text.trim() || sending || enqueuing}
                onClick={() => void doEnqueue()}
              />
            )}
            {sending ? (
              <IconButton
                label={t("停止")}
                icon={<IconStop size={13} />}
                variant="danger"
                shape="pill"
                onClick={stop}
              />
            ) : (
              <IconButton
                label={t("生成")}
                icon={
                  <IconSend
                    size={15}
                    className="-translate-x-px translate-y-px"
                  />
                }
                variant="primary"
                shape="pill"
                disabled={!text.trim()}
                onClick={() => void doSend()}
              />
            )}
          </div>
        </div>

        <div className="mt-1.5 flex items-center justify-center gap-2 text-center text-footnote text-quaternary">
          <span>{t("Enter 发送 · Shift Enter 换行 · / 提示词助手")}</span>
          {attachments.length > 0 && (
            <span className="text-tertiary">
              · {t("{{n}} 张参考图", { n: attachments.length })}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
