import { memo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { DisplayMessage, useChatStore } from "../stores/chatStore";
import { adapterErrorTitle } from "../lib/api";
import ImageCard from "./ImageCard";
import SafeImg from "./SafeImg";
import { IconBrain, IconChevron } from "./Icons";

function ThinkingCard({ message }: { message: DisplayMessage }) {
  const [open, setOpen] = useState(false);
  if (!message.thinkingUsed || !message.refined) return null;
  return (
    <div className="mb-2.5 overflow-hidden rounded-[var(--radius-card)] border border-theme bg-elevated">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="pressable flex w-full items-center gap-2 px-3.5 py-2.5 text-[13px] text-tertiary"
      >
        <span className="text-accent">
          <IconBrain size={15} />
        </span>
        <span>思考模型已优化提示词</span>
        <motion.span
          animate={{ rotate: open ? 90 : 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="ml-auto"
        >
          <IconChevron size={14} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.25, 0.1, 0.25, 1] }}
          >
            <div className="space-y-1.5 border-t border-theme px-3.5 py-3">
              <div className="text-[11px] font-medium tracking-wide text-tertiary">
                你的描述
              </div>
              <div className="text-[13px] leading-relaxed text-secondary">
                {message.content}
              </div>
              <div className="pt-1 text-[11px] font-medium tracking-wide text-tertiary">
                优化后的提示词
              </div>
              <div className="text-[13px] leading-relaxed text-primary">
                {message.refined}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function StreamingThinkingCard({ text }: { text: string }) {
  return (
    <div className="mb-2.5 rounded-[var(--radius-card)] border border-theme bg-elevated px-3.5 py-2.5">
      <div className="flex items-center gap-2 text-[11px] font-medium tracking-wide text-tertiary">
        <span className="text-accent">
          <IconBrain size={14} />
        </span>
        <span>思考模型优化中</span>
      </div>
      <div
        className="mt-1.5 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-secondary"
        aria-live="polite"
      >
        {text}
        <span className="thinking-caret" aria-hidden="true" />
      </div>
    </div>
  );
}

function PendingCard({ label }: { label: string }) {
  return (
    <div className="shimmer relative aspect-square overflow-hidden rounded-[var(--radius-card)]">
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
        <div className="flex gap-1">
          <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-accent" />
          <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-accent" />
          <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-accent" />
        </div>
        <span className="text-xs text-tertiary">{label}</span>
      </div>
    </div>
  );
}

export default memo(function MessageItem({
  message,
}: {
  message: DisplayMessage;
}) {
  const isUser = message.role === "user";
  const sending = useChatStore((s) => s.sending);
  const retryLast = useChatStore((s) => s.retryLast);
  // 占位只在生成中有效；终态即使数据异常带有 pendingImages 也不渲染骨架
  const showPending =
    message.status === "thinking" || message.status === "generating";
  const pendingCount = showPending ? message.pendingImages : 0;
  const multi = message.images.length + pendingCount > 1;

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.26, ease: [0.25, 0.1, 0.25, 1] }}
      className={`flex ${isUser ? "justify-end" : "justify-start"}`}
    >
      <div className={`${isUser ? "max-w-[75%]" : "w-full max-w-[85%]"}`}>
        {isUser ? (
          <div className="space-y-2">
            {message.attachments.length > 0 && (
              <div className="flex justify-end gap-2">
                {message.attachments.map((a) => (
                  <SafeImg
                    key={a.id}
                    src={a.dataUrl}
                    alt={a.name}
                    className="h-16 w-16 rounded-[10px] border border-theme object-cover shadow-card"
                  />
                ))}
              </div>
            )}
            {/* iMessage 风格气泡 */}
            <div className="rounded-[18px] rounded-br-[6px] bg-accent px-4 py-2.5 text-[15px] leading-relaxed text-white">
              {message.content}
            </div>
          </div>
        ) : (
          <div className="w-full">
            {message.status === "thinking" && message.streamText ? (
              <StreamingThinkingCard text={message.streamText} />
            ) : (
              <ThinkingCard message={message} />
            )}
            {(message.status === "thinking" ||
              message.status === "generating") && (
              <div className="mb-2.5 flex items-center gap-2 text-[13px] text-tertiary">
                <span className="flex gap-1">
                  <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-accent" />
                  <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-accent" />
                  <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-accent" />
                </span>
                {message.status === "thinking"
                  ? "正在思考…"
                  : `正在绘制 · 剩余 ${message.pendingImages} 张`}
              </div>
            )}
            <div
              className={`grid gap-3 ${multi ? "grid-cols-2" : "grid-cols-1"}`}
            >
              {message.images.map((img) => (
                <ImageCard
                  key={img.historyId}
                  image={img}
                  siblings={message.images}
                  prompt={message.refined || message.content}
                  messageId={message.id}
                />
              ))}
              {Array.from({ length: pendingCount }).map((_, i) => (
                <PendingCard
                  key={`pending-${i}`}
                  label={message.status === "thinking" ? "准备中" : "绘制中"}
                />
              ))}
            </div>
            {message.status === "stopped" && message.images.length === 0 && (
              <div className="mt-2.5 flex items-center justify-between gap-3 rounded-[var(--radius-card)] border border-theme bg-elevated px-3.5 py-2.5 text-[13px] text-tertiary">
                <span>已停止生成</span>
                <button
                  onClick={() => void retryLast()}
                  disabled={sending}
                  className="rounded-[8px] border border-theme px-2.5 py-1 text-[12px] text-secondary transition-opacity hover:text-accent disabled:opacity-50"
                >
                  重试
                </button>
              </div>
            )}
            {message.status === "error" && message.error && (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
                className="mt-2.5 rounded-[var(--radius-card)] border border-danger/25 bg-elevated px-3.5 py-2.5"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[13px] font-medium text-danger">
                    {adapterErrorTitle(message.error)}
                  </div>
                  <button
                    onClick={() => void retryLast()}
                    disabled={sending}
                    className="shrink-0 rounded-[8px] border border-theme px-2.5 py-1 text-[12px] text-secondary transition-opacity hover:text-accent disabled:opacity-50"
                  >
                    重试
                  </button>
                </div>
                <div className="mt-0.5 max-h-24 overflow-y-auto break-all text-[12px] text-secondary">
                  {message.error.message}
                </div>
              </motion.div>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
});
