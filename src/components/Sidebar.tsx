import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useAppStore, AppView } from "../stores/appStore";
import { useChatStore } from "../stores/chatStore";
import { useQueueStore } from "../stores/queueStore";
import { useCompact } from "../hooks/useMediaQuery";
import { useMotionTokens } from "../lib/useMotion";
import { DUR } from "../lib/motion";
import { FOCUS_SIDEBAR_SEARCH_EVENT } from "../lib/commands";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Tooltip } from "./ui/Tooltip";
import { Kbd } from "./ui/Kbd";
import { cn } from "./ui/cn";
import {
  IconPlus,
  IconChat,
  IconGrid,
  IconCanvas,
  IconQueue,
  IconGear,
  IconClose,
  IconSun,
  IconMoon,
  IconMonitor,
  IconCommand,
  IconSearch,
  IconChevron,
} from "./Icons";

const NAV_ITEMS: { id: AppView; label: string; icon: typeof IconGrid }[] = [
  { id: "canvas", label: "画布", icon: IconCanvas },
  { id: "gallery", label: "画廊", icon: IconGrid },
  { id: "queue", label: "队列", icon: IconQueue },
  { id: "settings", label: "设置", icon: IconGear },
];

const ROW_BASE =
  "pressable relative flex h-8 w-full items-center gap-2 rounded-btn text-callout transition-colors";

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="px-4 pb-1 pt-3 text-subhead text-tertiary">{children}</div>
  );
}

export default function Sidebar() {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const manualCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const conversations = useChatStore((s) => s.conversations);
  const activeId = useChatStore((s) => s.activeId);
  const newConversation = useChatStore((s) => s.newConversation);
  const selectConversation = useChatStore((s) => s.selectConversation);
  const deleteConvo = useChatStore((s) => s.deleteConvo);
  const queuePending = useQueueStore(
    (s) => (s.counts.queued ?? 0) + (s.counts.running ?? 0),
  );
  const [query, setQuery] = useState("");
  const motionTokens = useMotionTokens();
  // 窄窗口自动收成图标栏；用户的手动折叠仍然独立生效，两者取"或"
  const compact = useCompact();
  const collapsed = manualCollapsed || compact;
  const searchRef = useRef<HTMLInputElement>(null);

  // Ctrl F / 命令面板"搜索对话"：收起的侧栏先展开，再聚焦搜索框
  useEffect(() => {
    const focusSearch = () => {
      if (manualCollapsed) toggleSidebar();
      if (compact) {
        setPaletteOpen(true);
        return;
      }
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

  const cycleTheme = () => {
    setTheme(
      theme === "system" ? "dark" : theme === "dark" ? "light" : "system",
    );
  };
  const ThemeIcon =
    theme === "dark" ? IconMoon : theme === "light" ? IconSun : IconMonitor;
  const themeLabel =
    theme === "system" ? "跟随系统" : theme === "dark" ? "暗色" : "浅色";

  const pickConvo = async (id: number) => {
    await selectConversation(id);
    setView("chat");
  };

  // 选中竖条：同 layoutId 在对话/导航之间迁移，切换视图时是滑动而不是闪现
  const rail = (on: boolean) =>
    on ? (
      <motion.span
        layoutId="sidebar-active"
        transition={motionTokens.spring("snappy")}
        className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-pill bg-accent"
      />
    ) : null;

  return (
    <motion.aside
      animate={{ width: collapsed ? 56 : 256 }}
      transition={motionTokens.spring("gentle")}
      className="glass flex shrink-0 flex-col overflow-hidden"
    >
      <div
        className={cn(
          "shrink-0 space-y-1.5 pb-1 pt-2",
          collapsed ? "px-2" : "px-2.5",
        )}
      >
        {collapsed ? (
          <IconButton
            label="新对话"
            icon={<IconPlus size={16} />}
            variant="secondary"
            className="w-full"
            onClick={async () => {
              await newConversation();
              setView("chat");
            }}
          />
        ) : (
          <Button
            variant="primary"
            block
            icon={<IconPlus size={15} />}
            onClick={async () => {
              await newConversation();
              setView("chat");
            }}
          >
            新对话
          </Button>
        )}
        {!collapsed && (
          <div className="relative">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-tertiary">
              <IconSearch size={13} />
            </span>
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索对话"
              aria-label="搜索对话"
              className="h-7 w-full rounded-btn bg-fill pl-7 pr-2 text-callout text-primary outline-none transition-shadow placeholder:text-tertiary focus:ring-2 focus:ring-accent/25"
            />
          </div>
        )}
      </div>

      {!collapsed && <SectionLabel>对话</SectionLabel>}

      <nav
        aria-label="对话列表"
        className="min-h-0 flex-1 space-y-px overflow-y-auto px-2 py-0.5"
      >
        <AnimatePresence initial={false}>
          {visible.map((c) => {
            const active = view === "chat" && activeId === c.id;
            return (
              <motion.div
                key={c.id}
                layout
                initial={motionTokens.reduce ? { opacity: 1 } : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={motionTokens.reduce ? { opacity: 1 } : { opacity: 0 }}
                transition={motionTokens.fade(DUR.base)}
                className="group relative"
              >
                <button
                  onClick={() => pickConvo(c.id)}
                  aria-label={`打开对话：${c.title}`}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    ROW_BASE,
                    collapsed ? "justify-center px-2" : "pl-3 pr-8",
                    active
                      ? "bg-accent-soft font-medium text-accent-text"
                      : "text-secondary hover:bg-hover hover:text-primary",
                  )}
                >
                  {rail(active && !collapsed)}
                  <span className="shrink-0">
                    <IconChat size={15} />
                  </span>
                  {!collapsed && (
                    <span className="min-w-0 flex-1 truncate text-left">
                      {c.title}
                    </span>
                  )}
                </button>
                {!collapsed && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteConvo(c.id);
                    }}
                    aria-label={`删除对话：${c.title}`}
                    tabIndex={-1}
                    className="pressable absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-chip text-tertiary opacity-0 transition-opacity hover:bg-active hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <IconClose size={11} />
                  </button>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
        {visible.length === 0 && !collapsed && (
          <div className="px-2.5 py-4 text-footnote text-tertiary">
            {query ? "没有匹配的对话" : "还没有对话"}
          </div>
        )}
      </nav>

      {!collapsed && <SectionLabel>导航</SectionLabel>}
      <div className={cn("shrink-0 space-y-px px-2 pb-1", collapsed && "pt-1")}>
        {NAV_ITEMS.map((item) => {
          const active = view === item.id;
          const content = (
            <button
              onClick={() => setView(item.id)}
              aria-label={item.label}
              aria-current={active ? "page" : undefined}
              className={cn(
                ROW_BASE,
                collapsed ? "justify-center px-2" : "px-2.5",
                active
                  ? "bg-accent-soft font-medium text-accent-text"
                  : "text-secondary hover:bg-hover hover:text-primary",
              )}
            >
              {rail(active && !collapsed)}
              <item.icon size={15} />
              {!collapsed && (
                <span className="flex-1 text-left">{item.label}</span>
              )}
              {item.id === "queue" && queuePending > 0 && (
                <span
                  aria-label={`${queuePending} 个任务待执行`}
                  className="tabular rounded-pill bg-accent-fill px-1.5 text-caption leading-4 text-on-accent"
                >
                  {queuePending}
                </span>
              )}
            </button>
          );
          return collapsed ? (
            <Tooltip key={item.id} label={item.label} side="right">
              {content}
            </Tooltip>
          ) : (
            <div key={item.id}>{content}</div>
          );
        })}
      </div>

      {!collapsed && <SectionLabel>系统</SectionLabel>}
      <div className={cn("shrink-0 space-y-px px-2 pb-2", collapsed && "pt-1")}>
        <Tooltip
          label={`主题：${themeLabel}`}
          side={collapsed ? "right" : "top"}
        >
          <button
            onClick={cycleTheme}
            aria-label={`主题：${themeLabel}，点击切换`}
            className={cn(
              ROW_BASE,
              collapsed ? "justify-center px-2" : "px-2.5",
              "text-secondary hover:bg-hover hover:text-primary",
            )}
          >
            <ThemeIcon size={15} />
            {!collapsed && (
              <span className="flex-1 text-left">{themeLabel}</span>
            )}
          </button>
        </Tooltip>
        <Tooltip label="命令面板" side={collapsed ? "right" : "top"}>
          <button
            onClick={() => setPaletteOpen(true)}
            aria-label="打开命令面板"
            className={cn(
              ROW_BASE,
              collapsed ? "justify-center px-2" : "px-2.5",
              "text-secondary hover:bg-hover hover:text-primary",
            )}
          >
            <IconCommand size={15} />
            {!collapsed && (
              <>
                <span className="flex-1 text-left">命令</span>
                <Kbd>Ctrl K</Kbd>
              </>
            )}
          </button>
        </Tooltip>
        {/* 窄窗口下侧栏是自动收起的，手动折叠按钮隐藏，避免出现"点了没反应" */}
        {!compact && (
          <button
            onClick={toggleSidebar}
            aria-label={collapsed ? "展开侧栏" : "折叠侧栏"}
            className={cn(
              "pressable flex h-7 w-full items-center gap-2.5 rounded-btn px-2.5 text-footnote text-tertiary transition-colors hover:bg-hover hover:text-secondary",
              collapsed && "justify-center px-2",
            )}
          >
            <IconChevron direction={collapsed ? "right" : "left"} size={13} />
            {!collapsed && <span>折叠侧栏</span>}
          </button>
        )}
      </div>
    </motion.aside>
  );
}
