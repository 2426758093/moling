import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/appStore";
import { useChatStore } from "../stores/chatStore";
import { useCompact } from "../hooks/useMediaQuery";
import { useMotionTokens } from "../lib/useMotion";
import { DUR } from "../lib/motion";
import { FOCUS_SIDEBAR_SEARCH_EVENT } from "../lib/commands";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import {
  IconChat,
  IconChevron,
  IconClose,
  IconPlus,
  IconSearch,
} from "./Icons";
import { cn } from "./ui/cn";

const ROW_BASE =
  "pressable relative flex h-8 w-full items-center gap-2 rounded-btn text-callout transition-colors";

/// 二级面板：只在创作页显示会话列表。导航已移到 NavRail，这里不再承担「去哪」，
/// 只回答「在这个工作区里，我正在做哪一件」。
export default function Sidebar() {
  const { t } = useTranslation();
  const manualCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const conversations = useChatStore((s) => s.conversations);
  const activeId = useChatStore((s) => s.activeId);
  const newConversation = useChatStore((s) => s.newConversation);
  const selectConversation = useChatStore((s) => s.selectConversation);
  const deleteConvo = useChatStore((s) => s.deleteConvo);
  const [query, setQuery] = useState("");
  const motionTokens = useMotionTokens();
  const compact = useCompact();
  const collapsed = manualCollapsed || compact;
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focusSearch = () => {
      if (compact) {
        setPaletteOpen(true);
        return;
      }
      if (manualCollapsed) toggleSidebar();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => searchRef.current?.focus());
      });
    };
    window.addEventListener(FOCUS_SIDEBAR_SEARCH_EVENT, focusSearch);
    return () =>
      window.removeEventListener(FOCUS_SIDEBAR_SEARCH_EVENT, focusSearch);
  }, [compact, manualCollapsed, setPaletteOpen, toggleSidebar]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, query]);

  const rail = (on: boolean) =>
    on ? (
      <motion.span
        layoutId="conversation-active"
        transition={motionTokens.spring("snappy")}
        className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-pill bg-accent"
      />
    ) : null;

  return (
    <motion.aside
      animate={{ width: collapsed ? 0 : 248 }}
      transition={motionTokens.spring("gentle")}
      aria-hidden={collapsed}
      className="relative shrink-0 overflow-hidden border-r border-separator bg-window"
    >
      <div
        className={cn(
          "flex h-full w-[248px] flex-col",
          collapsed && "pointer-events-none opacity-0",
        )}
        style={{ visibility: collapsed ? "hidden" : "visible" }}
      >
        <div className="shrink-0 space-y-1.5 px-3 pb-1 pt-3">
          <Button
            variant="primary"
            block
            icon={<IconPlus size={15} />}
            onClick={() => {
              void newConversation();
            }}
          >
            {t("新对话")}
          </Button>
          <div className="relative">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-tertiary">
              <IconSearch size={13} />
            </span>
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("搜索对话")}
              aria-label={t("搜索对话")}
              className="h-8 w-full rounded-btn bg-fill pl-7 pr-2 text-callout text-primary outline-none transition-shadow placeholder:text-tertiary focus:ring-2 focus:ring-accent/25"
            />
          </div>
        </div>

        <div className="px-5 pb-1 pt-3 text-caption text-quaternary">
          {t("对话")}
        </div>

        <nav
          aria-label={t("对话列表")}
          className="min-h-0 flex-1 space-y-px overflow-y-auto px-2 pb-2"
        >
          <AnimatePresence initial={false}>
            {visible.map((c) => {
              const active = activeId === c.id;
              return (
                <motion.div
                  key={c.id}
                  layout
                  initial={
                    motionTokens.reduce ? { opacity: 1 } : { opacity: 0 }
                  }
                  animate={{ opacity: 1 }}
                  exit={motionTokens.reduce ? { opacity: 1 } : { opacity: 0 }}
                  transition={motionTokens.fade(DUR.base)}
                  className="group relative"
                >
                  <button
                    onClick={() => void selectConversation(c.id)}
                    aria-label={t("打开对话：{{title}}", { title: c.title })}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      ROW_BASE,
                      "pl-3 pr-8",
                      active
                        ? "bg-accent-soft font-medium text-accent-text"
                        : "text-secondary hover:bg-hover hover:text-primary",
                    )}
                  >
                    {rail(active)}
                    <span className="shrink-0">
                      <IconChat size={15} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-left">
                      {c.title}
                    </span>
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteConvo(c.id);
                    }}
                    aria-label={t("删除对话：{{title}}", { title: c.title })}
                    tabIndex={-1}
                    className="pressable absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-chip text-tertiary opacity-0 transition-opacity hover:bg-active hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <IconClose size={11} />
                  </button>
                </motion.div>
              );
            })}
          </AnimatePresence>
          {visible.length === 0 && (
            <div className="px-2.5 py-4 text-footnote text-tertiary">
              {query ? t("没有匹配的对话") : t("还没有对话")}
            </div>
          )}
        </nav>

        <div className="flex shrink-0 items-center justify-between border-t border-separator px-3 py-2">
          <span className="text-caption text-quaternary">
            {t("留白，是画面的一部分")}
          </span>
          <IconButton
            label={t("折叠侧栏")}
            size="sm"
            tooltip={false}
            icon={<IconChevron direction="left" size={13} />}
            onClick={toggleSidebar}
          />
        </div>
      </div>
    </motion.aside>
  );
}
