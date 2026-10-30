import {
  useRef,
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useChatStore } from "../stores/chatStore";
import { useAppStore, SIZE_MIN, SIZE_MAX } from "../stores/appStore";
import { useProviderStore } from "../stores/providerStore";
import { useQueueStore } from "../stores/queueStore";
import {
  RATIO_OPTIONS,
  STYLE_PRESETS,
  REFERENCE_ROLES,
  DEFAULT_REFERENCE_STRENGTH,
  ReferenceRole,
} from "../lib/types";
import { api } from "../lib/api";
import { validateImageFile } from "../lib/file";
import { toast } from "../lib/notify";
import { maxReferenceImages, useModelCaps } from "../lib/useModelCaps";
import { DUR } from "../lib/motion";
import SafeImg from "./SafeImg";
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

// Radix Select 不接受空字符串作为选项值，空风格需要一个哨兵值
const NONE_STYLE = "none";
const STYLE_ITEMS = STYLE_PRESETS.map((s) => ({
  value: s.id || NONE_STYLE,
  label: s.label,
}));
const ROLE_ITEMS = REFERENCE_ROLES.map((r) => ({
  value: r.id,
  label: r.label,
}));

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
        自定义尺寸
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
          aria-label="宽度"
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
          aria-label="高度"
          compact
          widthClass="w-20"
        />
        <Button size="sm" variant="secondary" onClick={apply}>
          应用
        </Button>
      </div>
      <div className="mt-1.5 text-caption text-tertiary">
        512–4096，自动对齐到 8 的倍数
      </div>
    </div>
  );
}

export default function Composer() {
  // 从画布/画廊切回聊天时 Composer 才挂载，草稿需在首次渲染就进输入框
  const [text, setText] = useState(
    () => useChatStore.getState().draftPrompt ?? "",
  );
  const [assistOpen, setAssistOpen] = useState(false);
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
  const caps = useModelCaps();
  const [negOpen, setNegOpen] = useState(false);
  const draftPrompt = useChatStore((s) => s.draftPrompt);
  const setDraftPrompt = useChatStore((s) => s.setDraftPrompt);

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

  // text 变化后同步撑高输入框（草稿注入与清空都经此路径）
  useLayoutEffect(() => {
    autoGrow();
  }, [text, autoGrow]);

  const doSend = async () => {
    const value = text;
    // 直接读 store 的实时状态：渲染期闭包里的 sending 可能滞后一帧，
    // 连点/连按 Enter 会重复触发；sending 期间一律直接 return。
    if (!value.trim() || sending || useChatStore.getState().sending) return;
    setText("");
    requestAnimationFrame(autoGrow);
    await send(value);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
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
      toast("请先在「设置」中配置绘图服务商与模型", "error");
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
      setText("");
      requestAnimationFrame(autoGrow);
      toast("已加入队列");
    } catch (e) {
      toast(`加入队列失败：${String(e)}`, "error");
    } finally {
      setEnqueuing(false);
    }
  };

  const onPickFiles = async (files: FileList | null) => {
    if (!files) return;
    const all = Array.from(files);
    const limit = maxReferenceImages();
    const remaining = limit - useChatStore.getState().attachments.length;
    if (remaining <= 0) {
      toast(`最多添加 ${limit} 张参考图`, "error");
      return;
    }
    if (all.length > remaining) {
      toast(`最多添加 ${limit} 张参考图，已忽略多余文件`, "error");
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
    <div className="glass shrink-0 px-4 pb-4 pt-3">
      <div className="relative mx-auto max-w-2xl">
        <AnimatePresence>
          {assistOpen && (
            <PromptAssist draft={text} onClose={() => setAssistOpen(false)} />
          )}
        </AnimatePresence>
        <AnimatePresence>
          {attachments.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: DUR.base }}
              className="mb-2 flex flex-wrap gap-2"
            >
              {attachments.map((a) => (
                <motion.div
                  key={a.id}
                  layout
                  initial={{ scale: 0.85, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ duration: DUR.base }}
                  className="group relative"
                >
                  {/* 专家模式：角色 + 强度（提示词级近似）；简单模式只展示缩略图 */}
                  <div
                    className={
                      mode === "expert"
                        ? "w-32 rounded-card border border-line bg-elevated p-1.5 shadow-card"
                        : undefined
                    }
                  >
                    <div className="relative">
                      <SafeImg
                        src={a.dataUrl}
                        alt={a.name}
                        className={
                          mode === "expert"
                            ? "h-14 w-full rounded-btn border border-line object-cover"
                            : "h-14 w-14 rounded-xl border border-line object-cover shadow-card"
                        }
                      />
                      {a.compressed && (
                        <span className="pointer-events-none absolute bottom-0 left-0 rounded-bl-btn rounded-tr-chip border-r border-t border-line bg-elevated px-1 py-px text-caption leading-none text-tertiary">
                          已压缩
                        </span>
                      )}
                      <button
                        onClick={() => removeAttachment(a.id)}
                        aria-label={`移除附件 ${a.name}`}
                        className="pressable absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-pill border border-line bg-elevated text-secondary opacity-0 shadow-card transition-opacity hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                      >
                        <IconClose size={12} />
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
                          options={ROLE_ITEMS}
                          label={`${a.name} 的参考角色`}
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
                            label="参考强度"
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

        {mode === "expert" && caps.negative && (
          <div className="mb-1.5">
            <button
              onClick={() => setNegOpen((v) => !v)}
              aria-expanded={negOpen}
              className="pressable flex items-center gap-0.5 text-footnote text-tertiary transition-colors hover:text-secondary focus-visible:text-secondary"
            >
              <IconChevron size={10} direction={negOpen ? "down" : "right"} />
              负向提示词
              {!negOpen && prefs.negativePrompt.trim() && (
                <span className="ml-1 text-accent">已填写</span>
              )}
            </button>
            {negOpen && (
              <div className="mt-1 flex items-center gap-2 rounded-btn border border-line bg-elevated px-2.5 py-1.5">
                <input
                  value={prefs.negativePrompt}
                  onChange={(e) => setPrefs({ negativePrompt: e.target.value })}
                  placeholder="不希望出现的元素，如：模糊、水印、多余手指"
                  aria-label="负向提示词"
                  className="min-w-0 flex-1 bg-transparent text-callout text-primary outline-none placeholder:text-tertiary"
                />
              </div>
            )}
          </div>
        )}

        {/* iMessage 风格输入条：内容层材质，控件是嵌在其中的非玻璃按钮 */}
        <div className="flex items-end gap-1 rounded-panel border border-line bg-elevated p-1.5 shadow-card transition-shadow duration-200 focus-within:shadow-pop">
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
          <IconButton
            label="提示词助手"
            icon={<IconSparkle size={19} />}
            variant={assistOpen ? "secondary" : "ghost"}
            aria-expanded={assistOpen}
            onClick={() => setAssistOpen(!assistOpen)}
          />
          <IconButton
            label="参考图"
            icon={<IconImage size={19} />}
            onClick={() => fileRef.current?.click()}
          />

          <Popover
            side="top"
            align="start"
            trigger={
              <Button variant="ghost" size="md">
                {RATIO_OPTIONS.find((r) => r.id === prefs.ratio)?.label ??
                  "自定义"}
                <IconChevron size={11} direction="down" />
              </Button>
            }
          >
            <div className="w-60">
              <div className="mb-2 text-footnote font-medium text-tertiary">
                画面比例
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {RATIO_OPTIONS.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => applyRatio(r.id)}
                    className={`pressable rounded-btn border py-1.5 text-subhead transition-colors duration-150 ${
                      prefs.ratio === r.id
                        ? "border-accent bg-accent-soft font-medium text-accent"
                        : "border-line text-tertiary hover:bg-hover hover:text-secondary"
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              <div className="mb-1.5 mt-3.5 text-footnote font-medium text-tertiary">
                每次生成
              </div>
              <SegmentedControl
                value={String(prefs.count)}
                onValueChange={(v) => setPrefs({ count: Number(v) })}
                label="每次生成张数"
                size="sm"
                block
                options={[1, 2, 4].map((n) => ({
                  value: String(n),
                  label: `${n} 张`,
                }))}
              />
              {mode === "expert" && (
                <CustomSizeRow
                  width={prefs.width}
                  height={prefs.height}
                  onApply={(w, h) => applyCustomSize(w, h)}
                />
              )}
            </div>
          </Popover>

          <Select
            value={prefs.style || NONE_STYLE}
            onValueChange={(v) =>
              setPrefs({ style: v === NONE_STYLE ? "" : v })
            }
            options={STYLE_ITEMS}
            label="风格"
            variant="bare"
            widthClass="w-32"
            className="shrink-0"
          />

          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              autoGrow();
            }}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="描述你想要的画面…"
            aria-label="提示词"
            className="min-w-0 flex-1 resize-none bg-transparent px-1 py-2 text-body leading-snug outline-none placeholder:text-tertiary"
          />

          {mode === "expert" && (
            <IconButton
              label="加入队列"
              icon={<IconQueue size={18} />}
              disabled={!text.trim() || sending || enqueuing}
              onClick={() => void doEnqueue()}
            />
          )}

          {sending ? (
            <IconButton
              label="停止"
              icon={<IconStop size={14} />}
              variant="danger"
              shape="pill"
              onClick={stop}
            />
          ) : (
            <IconButton
              label="生成"
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

        <div className="mt-1.5 text-center text-footnote text-tertiary">
          {prefs.width} × {prefs.height}
          {prefs.style && " · 已选风格"}
          {mode === "expert" &&
            caps.negative &&
            prefs.negativePrompt.trim() &&
            " · 含负向词"}
          {attachments.length > 0 && ` · ${attachments.length} 张参考图`}
        </div>
      </div>
    </div>
  );
}
