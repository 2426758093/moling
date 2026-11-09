import { useTranslation } from "react-i18next";
import { useAppStore, type AppView } from "../../stores/appStore";
import { useQueueStore } from "../../stores/queueStore";
import { IconButton } from "../ui/IconButton";
import { IconPanelLeft, IconSearch } from "../Icons";
import { cn } from "../ui/cn";
import WindowControls from "./WindowControls";
import type { WindowPlatform } from "../../hooks/useWindowState";

const VIEW_TITLE = {
  chat: "聊天",
  gallery: "画廊",
  canvas: "画布",
  queue: "队列",
  settings: "设置",
} as const satisfies Record<AppView, string>;

/// 自绘标题栏：48px 功能玻璃，整条是拖拽区。
///
/// `data-tauri-drag-region` 只标在栏体与中间的空白占位上 —— 按钮自己没这个
/// 属性，所以点按钮不会触发拖拽。双击最大化交给 Tauri 内建
/// （allow-internal-toggle-maximize），不写 onDoubleClick，否则会和拖拽抢事件。
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
  const queuePending = useQueueStore(
    (s) => (s.counts.queued ?? 0) + (s.counts.running ?? 0),
  );
  // 快捷键文案跟随平台：mac 用 ⌘，其余用 Ctrl
  const mod = platform === "macos" ? "⌘K" : "Ctrl K";

  return (
    <header
      data-tauri-drag-region
      className="glass-titlebar fixed inset-x-0 top-0 z-40 flex h-12 select-none items-center"
    >
      <div className="flex shrink-0 items-center gap-1 pl-2">
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
        className="ml-1.5 flex min-w-0 shrink-0 items-baseline gap-2"
      >
        <span className="text-callout font-semibold text-primary">墨灵</span>
        <span aria-hidden className="text-caption text-quaternary">
          ·
        </span>
        <span className="truncate text-callout text-secondary">
          {t(VIEW_TITLE[view])}
        </span>
      </div>

      {/* 中段空白：只这里拖拽，避免误拖文字 */}
      <div data-tauri-drag-region className="h-full min-w-4 flex-1" />

      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className={cn(
            "glass-inset pressable flex h-7 w-60 items-center gap-2 rounded-btn px-2.5",
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
            className="tabular rounded-pill bg-accent-fill px-1.5 py-0.5 text-caption text-on-accent"
          >
            {queuePending}
          </span>
        )}
      </div>

      <div className="ml-2 flex h-full items-stretch border-l border-separator">
        <WindowControls isMaximized={isMaximized} />
      </div>
    </header>
  );
}
