import { useRef, useState, useCallback, useLayoutEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useChatStore } from "../stores/chatStore";
import { useAppStore } from "../stores/appStore";
import { useProviderStore } from "../stores/providerStore";
import { useQueueStore } from "../stores/queueStore";
import { RATIO_OPTIONS, STYLE_PRESETS } from "../lib/types";
import {
  readFileAsDataUrl,
  genAttachmentId,
  validateImageFile,
} from "../lib/file";
import { toast } from "../lib/notify";
import { MAX_REFERENCE_IMAGES } from "../lib/image";
import SafeImg from "./SafeImg";
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

export default function Composer() {
  const [text, setText] = useState("");
  const [ratioOpen, setRatioOpen] = useState(false);
  const [assistOpen, setAssistOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const attachments = useChatStore((s) => s.attachments);
  const addAttachment = useChatStore((s) => s.addAttachment);
  const removeAttachment = useChatStore((s) => s.removeAttachment);
  const sending = useChatStore((s) => s.sending);
  const stop = useChatStore((s) => s.stop);
  const send = useChatStore((s) => s.send);
  const prefs = useAppStore((s) => s.prefs);
  const setPrefs = useAppStore((s) => s.setPrefs);
  const applyRatio = useAppStore((s) => s.applyRatio);
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

  /// 加入队列：快照当前输入与参数，串行执行（v1 不支持参考图）
  const doEnqueue = async () => {
    const value = text.trim();
    if (!value) return;
    if (useChatStore.getState().attachments.length > 0) {
      toast("队列暂不支持参考图，请先移除附件或直接发送", "error");
      return;
    }
    const { providers, defaultProviderId } = useProviderStore.getState();
    const provider = providers.find((p) => p.provider.id === defaultProviderId);
    const model = provider?.provider.defaultModel;
    if (!provider || defaultProviderId == null || !model) {
      toast("请先在「设置」中配置绘图服务商与模型", "error");
      return;
    }
    try {
      await useQueueStore.getState().enqueue({
        providerId: defaultProviderId,
        prompt: value,
        model,
        style: prefs.style,
        width: prefs.width,
        height: prefs.height,
        count: prefs.count,
      });
      setText("");
      requestAnimationFrame(autoGrow);
      toast("已加入队列");
    } catch (e) {
      toast(`加入队列失败：${String(e)}`, "error");
    }
  };

  const onPickFiles = async (files: FileList | null) => {
    if (!files) return;
    const all = Array.from(files);
    const remaining =
      MAX_REFERENCE_IMAGES - useChatStore.getState().attachments.length;
    if (remaining <= 0) {
      toast(`最多添加 ${MAX_REFERENCE_IMAGES} 张参考图`, "error");
      return;
    }
    if (all.length > remaining) {
      toast(
        `最多添加 ${MAX_REFERENCE_IMAGES} 张参考图，已忽略多余文件`,
        "error",
      );
    }
    for (const file of all.slice(0, remaining)) {
      const invalid = await validateImageFile(file);
      if (invalid) {
        toast(invalid, "error");
        continue;
      }
      const dataUrl = await readFileAsDataUrl(file);
      if (
        !addAttachment({
          id: genAttachmentId(),
          dataUrl,
          name: file.name,
        })
      ) {
        break;
      }
    }
  };

  return (
    <div className="bg-glass shrink-0 border-t border-theme px-4 pb-4 pt-3">
      <div className="relative mx-auto max-w-2xl">
        <AnimatePresence>
          {assistOpen && <PromptAssist onClose={() => setAssistOpen(false)} />}
        </AnimatePresence>
        <AnimatePresence>
          {attachments.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.2 }}
              className="mb-2 flex flex-wrap gap-2"
            >
              {attachments.map((a) => (
                <motion.div
                  key={a.id}
                  layout
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: "spring", stiffness: 500, damping: 30 }}
                  className="group relative"
                >
                  <SafeImg
                    src={a.dataUrl}
                    alt={a.name}
                    className="h-14 w-14 rounded-[10px] border border-theme object-cover shadow-card"
                  />
                  <button
                    onClick={() => removeAttachment(a.id)}
                    aria-label={`移除附件 ${a.name}`}
                    className="absolute -right-1.5 -top-1.5 flex h-4.5 w-4.5 items-center justify-center rounded-full bg-elevated text-tertiary shadow-card transition-opacity group-hover:flex hidden"
                  >
                    <IconClose size={10} />
                  </button>
                </motion.div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* iMessage 风格输入条 */}
        <div className="flex items-end gap-2 rounded-[22px] border border-theme bg-elevated p-1.5 shadow-card transition-shadow duration-200 focus-within:shadow-pop">
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
          <button
            onClick={() => setAssistOpen(!assistOpen)}
            title="提示词助手"
            className={`pressable flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${
              assistOpen
                ? "bg-accent-soft text-accent"
                : "text-tertiary hover:bg-hover hover:text-secondary"
            }`}
          >
            <IconSparkle size={19} />
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            title="参考图"
            className="pressable flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-tertiary transition-colors hover:bg-hover hover:text-secondary"
          >
            <IconImage size={19} />
          </button>

          <div className="relative shrink-0">
            <button
              onClick={() => setRatioOpen(!ratioOpen)}
              title="画面比例与数量"
              className="pressable flex h-9 items-center gap-1 rounded-full px-2.5 text-[13px] text-tertiary transition-colors hover:bg-hover hover:text-secondary"
            >
              {RATIO_OPTIONS.find((r) => r.id === prefs.ratio)?.label}
              <IconChevron direction={ratioOpen ? "down" : "right"} size={11} />
            </button>
            <AnimatePresence>
              {ratioOpen && (
                <>
                  <div
                    className="fixed inset-0 z-20"
                    onClick={() => setRatioOpen(false)}
                  />
                  <motion.div
                    initial={{ opacity: 0, y: 10, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 10, scale: 0.96 }}
                    transition={{ duration: 0.18, ease: [0.25, 0.1, 0.25, 1] }}
                    className="absolute bottom-full left-0 z-30 mb-2 w-60 rounded-[var(--radius-pop)] border border-theme bg-elevated p-4 shadow-pop"
                  >
                    <div className="mb-2 text-[11px] font-medium tracking-wide text-tertiary">
                      画面比例
                    </div>
                    <div className="grid grid-cols-4 gap-1.5">
                      {RATIO_OPTIONS.map((r) => (
                        <button
                          key={r.id}
                          onClick={() => {
                            applyRatio(r.id);
                            setRatioOpen(false);
                          }}
                          className={`pressable rounded-[8px] border py-1.5 text-[12px] transition-colors duration-150 ${
                            prefs.ratio === r.id
                              ? "border-accent bg-accent-soft text-accent font-medium"
                              : "border-theme text-tertiary hover:text-secondary"
                          }`}
                        >
                          {r.label}
                        </button>
                      ))}
                    </div>
                    <div className="mb-1.5 mt-3.5 text-[11px] font-medium tracking-wide text-tertiary">
                      每次生成
                    </div>
                    <div className="flex gap-1.5">
                      {[1, 2, 4].map((n) => (
                        <button
                          key={n}
                          onClick={() => setPrefs({ count: n })}
                          className={`pressable flex-1 rounded-[8px] border py-1.5 text-[12px] transition-colors duration-150 ${
                            prefs.count === n
                              ? "border-accent bg-accent-soft text-accent font-medium"
                              : "border-theme text-tertiary hover:text-secondary"
                          }`}
                        >
                          {n} 张
                        </button>
                      ))}
                    </div>
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>

          <select
            value={prefs.style}
            onChange={(e) => setPrefs({ style: e.target.value })}
            title="风格"
            className="h-9 shrink-0 cursor-pointer rounded-full border-none bg-transparent px-1 text-[13px] text-tertiary outline-none transition-colors hover:text-secondary"
          >
            {STYLE_PRESETS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>

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
            className="min-w-0 flex-1 resize-none bg-transparent px-1 py-2 text-[15px] leading-snug outline-none placeholder:text-tertiary"
          />

          <button
            onClick={() => void doEnqueue()}
            disabled={!text.trim() || sending}
            title="加入队列（串行执行）"
            aria-label="加入队列"
            className={`pressable flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors duration-150 ${
              text.trim() && !sending
                ? "text-tertiary hover:bg-hover hover:text-accent"
                : "text-tertiary opacity-40"
            }`}
          >
            <IconQueue size={18} />
          </button>

          {sending ? (
            <button
              onClick={stop}
              title="停止"
              className="pressable flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-danger text-white"
            >
              <IconStop size={14} />
            </button>
          ) : (
            <button
              onClick={doSend}
              disabled={!text.trim()}
              title="生成"
              className={`pressable flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white transition-colors duration-150 ${
                text.trim() ? "bg-accent" : "bg-sunken text-tertiary"
              }`}
            >
              <IconSend size={15} className="-translate-x-px translate-y-px" />
            </button>
          )}
        </div>

        <div className="mt-1.5 text-center text-[11px] text-tertiary">
          {prefs.width} × {prefs.height}
          {prefs.style && " · 已选风格"}
          {attachments.length > 0 && ` · ${attachments.length} 张参考图`}
        </div>
      </div>
    </div>
  );
}
