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
  QUALITY_OPTIONS,
  qualityLabel,
  REFERENCE_ROLES,
  DEFAULT_REFERENCE_STRENGTH,
  ReferenceRole,
  ImageQuality,
} from "../lib/types";
import { api } from "../lib/api";
import { validateImageFile } from "../lib/file";
import { toast } from "../lib/notify";
import { FOCUS_COMPOSER_EVENT, OPEN_ASSIST_EVENT } from "../lib/commands";
import { maxReferenceImages, useModelCaps } from "../lib/useModelCaps";
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
  const caps = useModelCaps();
  const [negOpen, setNegOpen] = useState(false);
  const draftPrompt = useChatStore((s) => s.draftPrompt);
  const setDraftPrompt = useChatStore((s) => s.setDraftPrompt);
  const motionTokens = useMotionTokens();

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

  const doSend = async () => {
    const value = text;
    // 直接读 store 的实时状态：渲染期闭包里的 sending 可能滞后一帧，
    // 连点/连按 Enter 会重复触发；sending 期间一律直接 return。
    if (!value.trim() || sending || useChatStore.getState().sending) return;
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
        quality: prefs.quality === "auto" ? null : prefs.quality,
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
                松开以添加参考图
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
                            已压缩
                          </span>
                        )}
                        <button
                          onClick={() => removeAttachment(a.id)}
                          aria-label={`移除附件 ${a.name}`}
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

          {/* 参数摘要：模型能力范围内的快捷入口，全部 24px */}
          <div className="flex flex-wrap items-center gap-1 px-2 pt-2">
            <Popover
              side="top"
              align="start"
              trigger={
                <button className={CHIP} aria-label="画面比例与尺寸">
                  {prefs.ratio === "auto" ? (
                    "自动"
                  ) : (
                    <>
                      {RATIO_OPTIONS.find((r) => r.id === prefs.ratio)?.label ??
                        "自定义"}
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
                  画面比例
                </div>
                <button
                  onClick={() => applyRatio("auto")}
                  className={`pressable mb-1.5 flex w-full items-center justify-between rounded-btn px-2 py-1.5 text-subhead transition-colors duration-150 ${
                    prefs.ratio === "auto"
                      ? "bg-accent-soft font-medium text-accent-text"
                      : "text-tertiary hover:bg-hover hover:text-secondary"
                  }`}
                >
                  自动
                  <span className="text-caption font-normal text-tertiary">
                    由服务商决定
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
                <button className={CHIP} aria-label="每次生成张数">
                  {prefs.count} 张
                  <IconChevron size={10} direction="down" />
                </button>
              }
            >
              <div className="w-40">
                <div className="mb-2 text-footnote font-medium text-tertiary">
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
              </div>
            </Popover>

            <Popover
              side="top"
              align="start"
              trigger={
                <button className={CHIP} aria-label="图片质量">
                  质量 · {qualityLabel(prefs.quality)}
                  <IconChevron size={10} direction="down" />
                </button>
              }
            >
              <div className="w-56">
                <div className="mb-2 text-footnote font-medium text-tertiary">
                  图片质量
                </div>
                <SegmentedControl
                  value={prefs.quality}
                  onValueChange={(v) =>
                    setPrefs({ quality: v as ImageQuality })
                  }
                  label="图片质量"
                  size="sm"
                  block
                  options={QUALITY_OPTIONS.map((q) => ({
                    value: q.id,
                    label: q.label,
                  }))}
                />
                <div className="mt-2 text-caption text-tertiary">
                  自动不发送质量参数；低 / 中 / 高需要服务商支持
                </div>
              </div>
            </Popover>

            <Select
              value={prefs.style || NONE_STYLE}
              onValueChange={(v) =>
                setPrefs({ style: v === NONE_STYLE ? "" : v })
              }
              options={STYLE_ITEMS}
              label="风格"
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
                    aria-label="负向提示词"
                    aria-expanded={negOpen}
                  >
                    负向
                    {prefs.negativePrompt.trim() && (
                      <span className="h-1 w-1 rounded-pill bg-accent-text" />
                    )}
                    <IconChevron size={10} direction="down" />
                  </button>
                }
              >
                <div className="w-64">
                  <div className="mb-1.5 text-footnote font-medium text-tertiary">
                    负向提示词
                  </div>
                  <Input
                    value={prefs.negativePrompt}
                    onChange={(e) => {
                      setNegOpen(true);
                      setPrefs({ negativePrompt: e.target.value });
                    }}
                    placeholder="不希望出现的元素，如：模糊、水印"
                    aria-label="负向提示词内容"
                    compact
                    widthClass="w-full"
                  />
                </div>
              </Popover>
            )}
          </div>

          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              autoGrow();
            }}
            onKeyDown={onKeyDown}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            rows={1}
            placeholder="描述你想要的画面…"
            aria-label="提示词"
            className="block max-h-[150px] w-full resize-none bg-transparent px-3 pb-1 pt-2 text-body leading-relaxed text-primary outline-none placeholder:text-tertiary"
          />

          <div className="flex items-center gap-1 px-1.5 pb-1.5">
            <IconButton
              label="提示词助手"
              icon={<IconSparkle size={18} />}
              variant={assistOpen ? "secondary" : "ghost"}
              aria-expanded={assistOpen}
              onClick={() => setAssistOpen(!assistOpen)}
            />
            <IconButton
              label="参考图"
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
                label="加入队列"
                icon={<IconQueue size={18} />}
                disabled={!text.trim() || sending || enqueuing}
                onClick={() => void doEnqueue()}
              />
            )}
            {sending ? (
              <IconButton
                label="停止"
                icon={<IconStop size={13} />}
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
        </div>

        <div className="mt-1.5 flex items-center justify-center gap-2 text-center text-footnote text-quaternary">
          <span>Enter 发送 · Shift Enter 换行 · / 提示词助手</span>
          {attachments.length > 0 && (
            <span className="text-tertiary">
              · {attachments.length} 张参考图
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
