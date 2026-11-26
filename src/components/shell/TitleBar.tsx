import { useTranslation } from "react-i18next";
import { useAppStore, type AppView } from "../../stores/appStore";
import { useChatStore } from "../../stores/chatStore";
import { useQueueStore } from "../../stores/queueStore";
import { IconButton } from "../ui/IconButton";
import { IconPanelLeft, IconSearch } from "../Icons";
import { cn } from "../ui/cn";
import WindowControls from "./WindowControls";
import type { WindowPlatform } from "../../hooks/useWindowState";

const VIEW_TITLE = {
  chat: "创作",
  gallery: "作品",
  retouch: "修图",
  canvas: "画布",
  queue: "队列",
  settings: "设置",
} as const satisfies Record<AppView, string>;

/// 自绘标题栏：48px 纸面，整条是拖拽区。
///
/// 左侧是印章字标与面包屑，中段留白供拖拽，右侧是命令入口、队列徽标与窗口控制。
/// `data-tauri-drag-region` 只标在栏体与空白占位上，按钮不参与拖拽。
export default function TitleBar({
  isMaximized,
  platform,
}: {
  isMaximized: boolean;
  platform: WindowPlatform;
}) {
  const { t } = useTranslation();
  const view = useAppStore((s) => s.view);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const activeTitle = useChatStore(
    (s) => s.conversations.find((c) => c.id === s.activeId)?.title,
  );
  const queuePending = useQueueStore(
    (s) => (s.counts.queued ?? 0) + (s.counts.running ?? 0),
  );
  const mod = platform === "macos" ? "⌘K" : "Ctrl K";
  const crumb =
    view === "chat" && activeTitle ? activeTitle : t(VIEW_TITLE[view]);

  return (
    <header
      data-tauri-drag-region
      className="fixed inset-x-0 top-0 z-40 flex h-12 select-none items-center gap-2 border-b border-separator bg-window px-2"
    >
      <div className="flex shrink-0 items-center gap-1">
        <IconButton
          size="sm"
          label={t("切换侧栏")}
          tooltip={false}
          icon={<IconPanelLeft size={16} />}
          onClick={toggleSidebar}
        />
      </div>

      <div
        data-tauri-drag-region
        className="flex min-w-0 shrink-0 items-center gap-2.5 pl-1"
      >
        <span className="seal h-5 w-5 text-caption">墨</span>
        <span className="font-kai text-body text-primary">{t("墨灵")}</span>
        <span aria-hidden className="text-caption text-quaternary">
          /
        </span>
        <span className="max-w-72 truncate text-callout text-secondary">
          {crumb}
        </span>
      </div>

      <div data-tauri-drag-region className="h-full min-w-4 flex-1" />

      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className={cn(
            "pressable flex h-8 w-56 items-center gap-2 rounded-btn bg-fill px-2.5",
            "text-caption text-tertiary hover:text-secondary",
          )}
        >
          <IconSearch size={14} />
          <span className="flex-1 text-left">{t("搜索或跳转")}</span>
          <kbd className="text-caption text-quaternary">{mod}</kbd>
        </button>
        {queuePending > 0 && (
          <span
            aria-label={t("{{n}} 个任务待执行", { n: queuePending })}
            className="tabular rounded-pill bg-accent-soft px-2 py-0.5 text-caption text-accent-text"
          >
            {queuePending}
          </span>
        )}
      </div>

      <div className="ml-1 flex h-full items-stretch border-l border-separator">
        <WindowControls isMaximized={isMaximized} />
      </div>
    </header>
  );
}
