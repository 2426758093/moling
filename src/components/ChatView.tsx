import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useChatStore } from "../stores/chatStore";
import { useAppStore } from "../stores/appStore";
import { sizeLabel } from "../lib/types";
import { useProviderStore } from "../stores/providerStore";
import { useScrollEdge } from "../hooks/useScrollEdge";
import { useMotionTokens } from "../lib/useMotion";
import { DUR } from "../lib/motion";
import MessageItem from "./MessageItem";
import Composer from "./Composer";
import PageHeader from "./PageHeader";
import { Badge } from "./ui/Badge";
import { IconSparkle, IconCommand } from "./Icons";

const SUGGESTIONS = [
  "晨曦中的江南水乡，薄雾缭绕",
  "赛博朋克都市的雨夜街头",
  "毛茸茸的橘猫宇航员漂浮在太空舱",
  "雪山之巅的金顶古寺，云海翻腾",
];

export default function ChatView() {
  const { t } = useTranslation();
  const messages = useChatStore((s) => s.messages);
  const activeId = useChatStore((s) => s.activeId);
  const conversations = useChatStore((s) => s.conversations);
  const send = useChatStore((s) => s.send);
  const sending = useChatStore((s) => s.sending);
  const hasMore = useChatStore((s) => s.hasMore);
  const loadingOlder = useChatStore((s) => s.loadingOlder);
  const loadOlder = useChatStore((s) => s.loadOlder);
  const prefs = useAppStore((s) => s.prefs);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const providers = useProviderStore((s) => s.providers);
  const defaultProviderId = useProviderStore((s) => s.defaultProviderId);
  const motionTokens = useMotionTokens();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  useScrollEdge(scrollRef);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 320,
    overscan: 6,
  });

  const title =
    conversations.find((c) => c.id === activeId)?.title ?? t("新对话");
  const model =
    providers.find((p) => p.provider.id === defaultProviderId)?.provider
      .defaultModel ?? t("未配置模型");

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    // 接近顶部时续载更早的一页（幂等：store 内部对 hasMore/loadingOlder 去抖）
    if (el.scrollTop < 120) void loadOlder();
  };

  const prevCount = useRef(messages.length);
  const prevFirstId = useRef<number | null>(messages[0]?.id ?? null);

  // 消息数变化后决定滚动补偿：
  // - 末尾追加（发送/生成）：吸底到最新一条；
  // - 顶部插入（loadOlder 分页）：把原来第一条锚回原来的视觉位置，避免跳动。
  // 虚拟列表要等 measureElement 写入真实高度，单层 rAF 拿到的仍是估算高度，故用双层 rAF。
  // 用户上滑查看历史时 stickToBottom 为 false，不强制吸底。
  useEffect(() => {
    const count = messages.length;
    const firstId = messages[0]?.id ?? null;
    const prevFirst = prevFirstId.current;
    prevFirstId.current = firstId;
    const grown = count !== prevCount.current;
    prevCount.current = count;
    if (!grown) return;

    // 顶部插入：原首条现在的位置就是补偿后的锚点
    if (prevFirst !== null && firstId !== prevFirst) {
      const anchor = messages.findIndex((m) => m.id === prevFirst);
      if (anchor > 0) {
        let inner = 0;
        const outer = requestAnimationFrame(() => {
          inner = requestAnimationFrame(() => {
            virtualizer.scrollToIndex(anchor, { align: "start" });
          });
        });
        return () => {
          cancelAnimationFrame(outer);
          cancelAnimationFrame(inner);
        };
      }
    }

    if (count === 0) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (!stickToBottom.current) return;
        virtualizer.scrollToIndex(count - 1, { align: "end" });
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [messages, virtualizer]);

  const empty = activeId === null || messages.length === 0;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title={
          <AnimatePresence mode="wait">
            <motion.span
              key={title}
              initial={
                motionTokens.reduce ? { opacity: 1 } : { opacity: 0, y: 4 }
              }
              animate={{ opacity: 1, y: 0 }}
              exit={
                motionTokens.reduce ? { opacity: 1 } : { opacity: 0, y: -4 }
              }
              transition={motionTokens.fade(DUR.quick)}
              className="block truncate"
            >
              {title}
            </motion.span>
          </AnimatePresence>
        }
        subtitle={t("{{n}} 条消息 · {{model}}", {
          n: messages.length,
          model,
        })}
        actions={
          <>
            <Badge tone="neutral">{sizeLabel(prefs.width, prefs.height)}</Badge>
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label={t("打开命令面板")}
              className="pressable glass-inset flex h-7 items-center gap-1.5 rounded-btn px-2 text-caption text-tertiary transition-colors hover:text-secondary"
            >
              <IconCommand size={13} />
              <span className="hidden sm:inline">{t("命令")}</span>
            </button>
          </>
        }
      />

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="scroll-edge min-h-0 flex-1 overflow-y-auto"
      >
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-9 px-6 pb-14">
            <motion.div
              initial={
                motionTokens.reduce ? { opacity: 1 } : { opacity: 0, y: 14 }
              }
              animate={{ opacity: 1, y: 0 }}
              transition={motionTokens.spring("smooth")}
              className="max-w-reading text-center"
            >
              <div className="mb-3 text-caption uppercase tracking-wider text-tertiary">
                {t("AI 绘图")}
              </div>
              <h2 className="text-display text-primary">
                {t("描述画面，即刻成图")}
              </h2>
              <p className="mt-2 text-body text-tertiary">
                {t("像聊天一样描述想法，墨灵会读懂原话并绘制出来")}
              </p>
            </motion.div>
            <div className="grid w-full max-w-chat grid-cols-1 gap-2.5 wide:max-w-chat-wide sm:grid-cols-2">
              {SUGGESTIONS.map((s, i) => (
                <motion.button
                  key={s}
                  initial={
                    motionTokens.reduce ? { opacity: 1 } : { opacity: 0, y: 10 }
                  }
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    ...motionTokens.fade(DUR.slow),
                    delay: i * 0.04,
                  }}
                  whileHover={motionTokens.reduce ? undefined : { y: -2 }}
                  onClick={() => {
                    if (!sending) void send(s);
                  }}
                  className="pressable flex items-start gap-2.5 rounded-card bg-elevated px-3.5 py-3 text-left text-callout text-secondary shadow-card ring-1 ring-line transition-colors duration-150 hover:text-primary"
                >
                  <span className="mt-0.5 shrink-0 text-tertiary">
                    <IconSparkle size={14} />
                  </span>
                  {s}
                </motion.button>
              ))}
            </div>
            <div className="text-footnote text-quaternary">
              {t("拖入图片作为参考 · Ctrl K 打开命令面板")}
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-chat px-5 py-6 wide:max-w-chat-wide">
            {(hasMore || loadingOlder) && (
              <div
                className="mb-3 text-center text-footnote text-tertiary"
                role="status"
                aria-live="polite"
              >
                {loadingOlder
                  ? t("正在加载更早的消息…")
                  : t("上滑加载更早的消息")}
              </div>
            )}
            <div
              className="relative w-full"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {virtualizer.getVirtualItems().map((vi) => (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full pb-7"
                  style={{ transform: `translateY(${vi.start}px)` }}
                >
                  <MessageItem message={messages[vi.index]} />
                </div>
              ))}
            </div>
            <div className="h-2" />
          </div>
        )}
      </div>
      <Composer />
    </div>
  );
}
