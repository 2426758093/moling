import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useChatStore } from "../stores/chatStore";
import MessageItem from "./MessageItem";
import Composer from "./Composer";
import { IconSparkle } from "./Icons";

const SUGGESTIONS = [
  "晨曦中的江南水乡，薄雾缭绕",
  "赛博朋克都市的雨夜街头",
  "毛茸茸的橘猫宇航员漂浮在太空舱",
  "雪山之巅的金顶古寺，云海翻腾",
];

export default function ChatView() {
  const messages = useChatStore((s) => s.messages);
  const activeId = useChatStore((s) => s.activeId);
  const conversations = useChatStore((s) => s.conversations);
  const send = useChatStore((s) => s.send);
  const sending = useChatStore((s) => s.sending);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 320,
    overscan: 6,
  });

  const title = conversations.find((c) => c.id === activeId)?.title ?? "新对话";

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const empty = activeId === null || messages.length === 0;

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-base">
      {/* Large Title 导航栏（毛玻璃） */}
      <header className="bg-glass z-10 flex h-[52px] shrink-0 items-end border-b border-theme px-6 pb-2">
        <AnimatePresence mode="wait">
          <motion.h1
            key={title}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
            className="truncate text-[17px] font-semibold tracking-tight text-primary"
          >
            {title}
          </motion.h1>
        </AnimatePresence>
      </header>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-10 px-6 pb-16">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
              className="text-center"
            >
              <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-[20px] bg-accent-soft text-accent">
                <IconSparkle size={26} strokeWidth={1.4} />
              </div>
              <h2 className="text-[26px] font-bold tracking-tight text-primary">
                描述画面，即刻成图
              </h2>
              <p className="mt-2 text-[14px] text-tertiary">
                像聊天一样描述想法，墨灵会思考、优化并绘制出来
              </p>
            </motion.div>
            <div className="grid w-full max-w-md grid-cols-1 gap-2.5 sm:grid-cols-2">
              {SUGGESTIONS.map((s, i) => (
                <motion.button
                  key={s}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: 0.1 + i * 0.06 }}
                  onClick={() => !sending && send(s)}
                  className="pressable rounded-[var(--radius-card)] border border-theme bg-elevated px-4 py-3 text-left text-[13px] text-secondary shadow-card transition-colors duration-150 hover:text-primary"
                >
                  {s}
                </motion.button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-2xl px-5 py-6">
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
