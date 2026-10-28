import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAppStore, AppView } from "../stores/appStore";
import { useChatStore } from "../stores/chatStore";
import {
  IconPlus,
  IconChat,
  IconGrid,
  IconGear,
  IconClose,
  IconSun,
  IconMoon,
  IconMonitor,
  IconChevron,
} from "./Icons";

const NAV_ITEMS: { id: AppView; label: string; icon: typeof IconGrid }[] = [
  { id: "gallery", label: "画廊", icon: IconGrid },
  { id: "settings", label: "设置", icon: IconGear },
];

export default function Sidebar() {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const conversations = useChatStore((s) => s.conversations);
  const activeId = useChatStore((s) => s.activeId);
  const newConversation = useChatStore((s) => s.newConversation);
  const selectConversation = useChatStore((s) => s.selectConversation);
  const deleteConvo = useChatStore((s) => s.deleteConvo);
  const [hoveredConvo, setHoveredConvo] = useState<number | null>(null);

  const cycleTheme = () => {
    setTheme(
      theme === "system" ? "dark" : theme === "dark" ? "light" : "system",
    );
  };
  const ThemeIcon =
    theme === "dark" ? IconMoon : theme === "light" ? IconSun : IconMonitor;

  const pickConvo = async (id: number) => {
    await selectConversation(id);
    setView("chat");
  };

  return (
    <aside
      className={`bg-glass flex shrink-0 flex-col border-r border-theme transition-[width] duration-300 ease-out ${
        collapsed ? "w-16" : "w-64"
      }`}
    >
      {/* 品牌区 */}
      <div
        className={`flex h-[52px] shrink-0 items-center ${
          collapsed ? "justify-center" : "justify-between px-5"
        }`}
      >
        {!collapsed ? (
          <span className="text-[17px] font-semibold tracking-tight text-primary">
            墨灵
          </span>
        ) : (
          <span className="text-[17px] font-semibold text-primary">墨</span>
        )}
      </div>

      {/* 新对话 */}
      <div className={`shrink-0 px-3 pb-2 ${collapsed ? "px-2.5" : ""}`}>
        <button
          onClick={async () => {
            await newConversation();
            setView("chat");
          }}
          title="新对话"
          className="pressable flex w-full items-center justify-center gap-1.5 rounded-[10px] bg-accent py-[7px] text-[13px] font-medium text-white shadow-card"
        >
          <IconPlus size={15} />
          {!collapsed && <span>新对话</span>}
        </button>
      </div>

      {/* 对话列表 */}
      {!collapsed && (
        <div className="shrink-0 px-5 pb-1 pt-3 text-[11px] font-medium tracking-wide text-tertiary">
          对话
        </div>
      )}
      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2.5 py-1">
        <AnimatePresence initial={false}>
          {conversations.map((c) => {
            const active = view === "chat" && activeId === c.id;
            return (
              <motion.div
                key={c.id}
                layout
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                className="group relative"
                onMouseEnter={() => setHoveredConvo(c.id)}
                onMouseLeave={() => setHoveredConvo(null)}
              >
                <button
                  onClick={() => pickConvo(c.id)}
                  title={c.title}
                  aria-label={`打开对话：${c.title}`}
                  aria-current={active ? "page" : undefined}
                  className={`flex w-full items-center gap-2 rounded-[8px] px-2.5 py-[7px] text-left text-[13px] transition-colors duration-150 ${
                    collapsed ? "justify-center px-0" : ""
                  } ${
                    active
                      ? "bg-accent-soft text-accent font-medium"
                      : "text-secondary hover:bg-hover"
                  }`}
                >
                  <span className="shrink-0 opacity-70">
                    <IconChat size={15} />
                  </span>
                  {!collapsed && (
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  )}
                </button>
                {!collapsed && hoveredConvo === c.id && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteConvo(c.id);
                    }}
                    title="删除对话"
                    aria-label={`删除对话：${c.title}`}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-tertiary opacity-0 transition-all duration-150 hover:bg-active hover:text-danger group-hover:opacity-100"
                  >
                    <IconClose size={12} />
                  </button>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </nav>

      {/* 底部导航 */}
      <div className="shrink-0 space-y-0.5 border-t border-theme px-2.5 py-2.5">
        {NAV_ITEMS.map((item) => {
          const active = view === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setView(item.id)}
              title={item.label}
              aria-label={item.label}
              aria-current={active ? "page" : undefined}
              className={`flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-[7px] text-[13px] transition-colors duration-150 ${
                collapsed ? "justify-center px-0" : ""
              } ${
                active
                  ? "bg-accent-soft text-accent font-medium"
                  : "text-secondary hover:bg-hover"
              }`}
            >
              <item.icon size={16} />
              {!collapsed && <span>{item.label}</span>}
            </button>
          );
        })}
        <button
          onClick={cycleTheme}
          title="切换主题"
          aria-label="切换主题"
          className={`flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-[7px] text-[13px] text-secondary transition-colors duration-150 hover:bg-hover ${
            collapsed ? "justify-center px-0" : ""
          }`}
        >
          <ThemeIcon size={16} />
          {!collapsed && (
            <span>
              {theme === "system"
                ? "跟随系统"
                : theme === "dark"
                  ? "暗色"
                  : "浅色"}
            </span>
          )}
        </button>
        <button
          onClick={toggleSidebar}
          title={collapsed ? "展开侧栏" : "折叠侧栏"}
          className={`flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-1 text-[11px] text-tertiary transition-colors duration-150 hover:text-secondary ${
            collapsed ? "justify-center px-0" : ""
          }`}
        >
          <IconChevron direction={collapsed ? "right" : "left"} size={13} />
          {!collapsed && <span>折叠</span>}
        </button>
      </div>
    </aside>
  );
}
