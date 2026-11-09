import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import { DisplayMessage, useChatStore } from "../stores/chatStore";
import { api, adapterErrorTitle, isUnconfirmedError } from "../lib/api";
import { DUR, EASE } from "../lib/motion";
import { toast } from "../lib/notify";
import ImageCard from "./ImageCard";
import SafeImg from "./SafeImg";
import { Button } from "./ui/Button";
import { ConfirmDialog } from "./ui/Dialog";
import { IconButton } from "./ui/IconButton";
import { IconAlert, IconBrain, IconChevron, IconCopy, IconEdit } from "./Icons";

/// 思考卡是内容层：标准材质（不透明底 + 描边），不加模糊。
/// 折叠态压到 28px —— 它是附属信息，不该抢走生成结果的注意力。
function ThinkingCard({ message }: { message: DisplayMessage }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!message.thinkingUsed || !message.refined) return null;
  return (
    <div className="mb-2.5 overflow-hidden rounded-btn bg-elevated shadow-card ring-1 ring-line">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="pressable flex h-7 w-full items-center gap-1.5 px-2.5 text-footnote text-tertiary"
      >
        <span className="text-accent">
          <IconBrain size={14} />
        </span>
        <span>{t("思考模型已优化提示词")}</span>
        <motion.span
          animate={{ rotate: open ? 90 : 0 }}
          transition={{ duration: DUR.quick, ease: EASE.ios }}
          className="ml-auto"
        >
          <IconChevron size={13} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: DUR.base, ease: EASE.ios }}
          >
            <div className="space-y-1.5 border-t border-separator px-3.5 py-3">
              <div className="text-footnote font-medium text-tertiary">
                {t("你的描述")}
              </div>
              <div className="text-subhead leading-relaxed text-secondary">
                {message.content}
              </div>
              <div className="pt-1 text-footnote font-medium text-tertiary">
                {t("优化后的提示词")}
              </div>
              <div className="text-subhead leading-relaxed text-primary">
                {message.refined}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function PendingCard({ label }: { label: string }) {
  return (
    <div className="skeleton-pulse relative aspect-square overflow-hidden rounded-card bg-elevated ring-1 ring-line">
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
        <div className="flex gap-1">
          <span className="thinking-dot h-1.5 w-1.5 rounded-pill bg-accent" />
          <span className="thinking-dot h-1.5 w-1.5 rounded-pill bg-accent" />
          <span className="thinking-dot h-1.5 w-1.5 rounded-pill bg-accent" />
        </div>
        <span className="text-footnote text-tertiary">{label}</span>
      </div>
    </div>
  );
}

export default memo(function MessageItem({
  message,
}: {
  message: DisplayMessage;
}) {
  const { t } = useTranslation();
  const isUser = message.role === "user";
  const sending = useChatStore((s) => s.sending);
  const retryLast = useChatStore((s) => s.retryLast);
  const setDraftPrompt = useChatStore((s) => s.setDraftPrompt);
  // 可能已计费的失败：重试会再次扣费，必须先确认
  const [confirmRetry, setConfirmRetry] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const unconfirmed =
    message.status === "error" && message.error
      ? isUnconfirmedError(message.error)
      : false;
  const requestId =
    message.error?.type === "unconfirmed"
      ? message.error.request_id
      : undefined;

  const requestRetry = () => {
    if (unconfirmed) setConfirmRetry(true);
    else void retryLast(message.id);
  };

  const recover = async () => {
    if (!requestId) return;
    setRecovering(true);
    try {
      const out = await api.recoverImageRequestByClient(requestId);
      toast(
        t("已恢复 {{n}} 张到画廊", { n: out.recovered }) +
          (out.failed ? t("（{{n}} 张仍失败）", { n: out.failed }) : ""),
      );
      await useChatStore.getState().loadConversations();
    } catch (e) {
      toast(
        t("恢复失败：{{error}}", {
          error: String(e).replace(/^Error:\s*/, ""),
        }),
        "error",
      );
    } finally {
      setRecovering(false);
    }
  };

  // 占位只在生成中有效；终态即使数据异常带有 pendingImages 也不渲染骨架
  const showPending = message.status === "generating";
  const pendingCount = showPending ? message.pendingImages : 0;
  const multi = message.images.length + pendingCount > 1;

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DUR.base, ease: EASE.ios }}
      className={`flex ${isUser ? "justify-end" : "justify-start"}`}
    >
      <div className={`${isUser ? "max-w-[75%]" : "w-full max-w-[85%]"}`}>
        {isUser ? (
          <div className="group space-y-2">
            {message.attachments.length > 0 && (
              <div className="flex justify-end gap-2">
                {message.attachments.map((a) => (
                  <SafeImg
                    key={a.id}
                    src={a.dataUrl}
                    alt={a.name}
                    className="h-16 w-16 rounded-btn object-cover shadow-card ring-1 ring-line"
                  />
                ))}
              </div>
            )}
            {/* 提示词卡：中性材质，强调色留给操作与当前状态 */}
            <div className="flex items-start justify-end gap-1">
              <div className="min-w-0 whitespace-pre-wrap rounded-card bg-elevated px-3.5 py-2.5 text-body text-primary shadow-card ring-1 ring-line">
                {message.content}
              </div>
              <div className="flex shrink-0 items-center gap-0.5 pt-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <IconButton
                  size="sm"
                  label={t("复制提示词")}
                  icon={<IconCopy size={14} />}
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(message.content)
                      .then(() => toast(t("已复制提示词")))
                      .catch(() => toast(t("复制失败"), "error"));
                  }}
                />
                <IconButton
                  size="sm"
                  label={t("编辑提示词")}
                  icon={<IconEdit size={14} />}
                  onClick={() => setDraftPrompt(message.content)}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="w-full">
            <ThinkingCard message={message} />
            {message.status === "generating" && (
              <div className="mb-2.5 flex items-center gap-2 text-footnote text-tertiary">
                <span className="flex gap-1">
                  <span className="thinking-dot h-1.5 w-1.5 rounded-pill bg-accent" />
                  <span className="thinking-dot h-1.5 w-1.5 rounded-pill bg-accent" />
                  <span className="thinking-dot h-1.5 w-1.5 rounded-pill bg-accent" />
                </span>
                {message.progress
                  ? t("正在绘制 · {{done}}/{{total}}", {
                      done: message.progress.done,
                      total: message.progress.total,
                    })
                  : t("正在绘制 · 剩余 {{n}} 张", {
                      n: message.pendingImages,
                    })}
              </div>
            )}
            {/* 单图不在聊天区铺满整列，限制展示尺寸；查看原图仍走大图预览 */}
            <div
              className={`grid gap-3 ${
                multi ? "grid-cols-2" : "max-w-[min(420px,100%)] grid-cols-1"
              }`}
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
                <PendingCard key={`pending-${i}`} label={t("绘制中")} />
              ))}
            </div>
            {message.status === "stopped" && message.images.length === 0 && (
              <div className="mt-2.5 flex items-center justify-between gap-3 text-footnote text-tertiary">
                <span>{t("已停止生成")}</span>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void retryLast(message.id)}
                  disabled={sending}
                >
                  {t("重试")}
                </Button>
              </div>
            )}
            {message.status === "error" && message.error && (
              <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: DUR.base, ease: EASE.ios }}
                className="mt-2.5 flex items-start gap-2 text-footnote"
              >
                <span className="mt-px shrink-0 text-danger">
                  <IconAlert size={14} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-danger">
                    {adapterErrorTitle(message.error)}
                  </div>
                  <div className="mt-0.5 max-h-24 overflow-y-auto break-all text-tertiary">
                    {message.error.message}
                  </div>
                  {unconfirmed && (
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-tertiary">
                      <span>{t("可能已计费，重试会再次扣费")}</span>
                      {requestId && (
                        <button
                          className="pressable font-mono text-[11px] underline decoration-dotted"
                          onClick={() => {
                            void navigator.clipboard
                              .writeText(requestId)
                              .then(() => toast(t("已复制请求 ID")))
                              .catch(() => toast(t("复制失败"), "error"));
                          }}
                          title={t("复制请求 ID（对账用）")}
                        >
                          {requestId}
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  {unconfirmed && requestId && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void recover()}
                      disabled={recovering}
                    >
                      {recovering ? t("恢复中…") : t("尝试恢复")}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={requestRetry}
                    disabled={sending}
                  >
                    {t("重试")}
                  </Button>
                </div>
              </motion.div>
            )}
            <ConfirmDialog
              open={confirmRetry}
              onOpenChange={setConfirmRetry}
              title={t("确认重新生成？")}
              description={t(
                "这次请求可能已在服务商侧计费。重新生成会再次扣费，请先到服务商后台确认没有出图。",
              )}
              confirmLabel={t("仍然重新生成")}
              danger
              onConfirm={() => void retryLast(message.id)}
            />
          </div>
        )}
      </div>
    </motion.div>
  );
});
