import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useAppStore, AppView } from "../stores/appStore";
import { useChatStore } from "../stores/chatStore";
import { useQueueStore } from "../stores/queueStore";
import { useCompact } from "../hooks/useMediaQuery";
import { DUR, EASE } from "../lib/motion";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Tooltip } from "./ui/Tooltip";
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
  IconChevron,
} from "./Icons";

const NAV_ITEMS: { id: AppView; label: string; icon: typeof IconGrid }[] = [
  { id: "canvas", label: "画布", icon: IconCanvas },
  { id: "gallery", label: "画廊", icon: IconGrid },
  { id: "queue", label: "队列", icon: IconQueue },
  { id: "settings", label: "设置", icon: IconGear },
];

export default function Sidebar() {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const manualCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
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
  const [hoveredConvo, setHoveredConvo] = useState<number | null>(null);
  const reduce = useReducedMotion();
  // 窄窗口自动收成图标栏；用户的手动折叠仍然独立生效，两者取"或"
  const compact = useCompact();
  const collapsed = manualCollapsed || compact;

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

  return (
    <aside
      className={cn(
        "glass flex shrink-0 flex-col transition-[width] duration-300 ease-ios",
        collapsed ? "w-16" : "w-62",
      )}
    >
      {/* 品牌区：不加字距，中文标题用负字距会挤字 */}
      <div
        className={cn(
          "flex h-14 shrink-0 items-center",
          collapsed ? "justify-center" : "px-5",
        )}
      >
        <span className="text-title3 text-primary">
          {collapsed ? "墨" : "墨灵"}
        </span>
      </div>

      <div className={cn("shrink-0 pb-2", collapsed ? "px-2" : "px-3")}>
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
      </div>

      {!collapsed && (
        <div className="shrink-0 px-5 pb-1 pt-3 text-caption text-tertiary">
          对话
        </div>
      )}

      <nav
        aria-label="对话列表"
        className="scroll-edge min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 py-1"
      >
        <AnimatePresence initial={false}>
          {conversations.map((c) => {
            const active = view === "chat" && activeId === c.id;
            return (
              <motion.div
                key={c.id}
                layout
                initial={reduce ? { opacity: 1 } : { opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={reduce ? { opacity: 1 } : { opacity: 0, x: -8 }}
                transition={{ duration: reduce ? 0 : DUR.base, ease: EASE.ios }}
                className="group relative"
                onMouseEnter={() => setHoveredConvo(c.id)}
                onMouseLeave={() => setHoveredConvo(null)}
              >
                <button
                  onClick={() => pickConvo(c.id)}
                  aria-label={`打开对话：${c.title}`}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "pressable flex min-h-9 w-full items-center gap-2 rounded-btn text-left text-callout transition-colors",
                    collapsed ? "justify-center px-2" : "px-2.5 pr-8",
                    active
                      ? "bg-accent-soft font-medium text-accent"
                      : "text-secondary hover:bg-hover hover:text-primary",
                  )}
                >
                  <span className="shrink-0">
                    <IconChat size={16} />
                  </span>
                  {!collapsed && (
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  )}
                </button>
                {!collapsed && hoveredConvo === c.id && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteConvo(c.id);
                    }}
                    aria-label={`删除对话：${c.title}`}
                    className="pressable absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-chip text-tertiary hover:bg-active hover:text-danger"
                  >
                    <IconClose size={12} />
                  </button>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </nav>

      <div
        className={cn(
          "shrink-0 space-y-0.5 px-2 pt-2 pb-1",
          collapsed && "px-2",
        )}
      >
        {NAV_ITEMS.map((item) => {
          const active = view === item.id;
          const content = (
            <button
              onClick={() => setView(item.id)}
              aria-label={item.label}
              aria-current={active ? "page" : undefined}
              className={cn(
                "pressable flex min-h-9 w-full items-center gap-2.5 rounded-btn text-callout transition-colors",
                collapsed ? "justify-center px-2" : "px-2.5",
                active
                  ? "bg-accent-soft font-medium text-accent"
                  : "text-secondary hover:bg-hover hover:text-primary",
              )}
            >
              <item.icon size={16} />
              {!collapsed && (
                <span className="flex-1 text-left">{item.label}</span>
              )}
              {item.id === "queue" && queuePending > 0 && (
                <span
                  aria-label={`${queuePending} 个任务待执行`}
                  className="rounded-pill bg-accent-fill px-1.5 text-caption text-on-accent"
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

      <div className="shrink-0 space-y-0.5 px-2 pb-2">
        {collapsed ? (
          <Tooltip label={`主题：${themeLabel}`} side="right">
            <button
              onClick={cycleTheme}
              aria-label={`主题：${themeLabel}，点击切换`}
              className="pressable flex min-h-9 w-full items-center justify-center rounded-btn px-2 text-secondary hover:bg-hover hover:text-primary"
            >
              <ThemeIcon size={16} />
            </button>
          </Tooltip>
        ) : (
          <button
            onClick={cycleTheme}
            aria-label={`主题：${themeLabel}，点击切换`}
            className="pressable flex min-h-9 w-full items-center gap-2.5 rounded-btn px-2.5 text-callout text-secondary transition-colors hover:bg-hover hover:text-primary"
          >
            <ThemeIcon size={16} />
            <span className="flex-1 text-left">{themeLabel}</span>
          </button>
        )}
        {/* 窄窗口下侧栏是自动收起的，手动折叠按钮隐藏，避免出现"点了没反应" */}
        {!compact && (
          <button
            onClick={toggleSidebar}
            aria-label={collapsed ? "展开侧栏" : "折叠侧栏"}
            className={cn(
              "pressable flex min-h-8 w-full items-center gap-2.5 rounded-btn px-2.5 text-footnote text-tertiary transition-colors hover:bg-hover hover:text-secondary",
              collapsed && "justify-center px-2",
            )}
          >
            <IconChevron direction={collapsed ? "right" : "left"} size={13} />
            {!collapsed && <span>折叠</span>}
          </button>
        )}
      </div>
    </aside>
  );
}
