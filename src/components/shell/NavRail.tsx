import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { useAppStore, type AppView } from "../../stores/appStore";
import { useQueueStore } from "../../stores/queueStore";
import { useMotionTokens } from "../../lib/useMotion";
import { Tooltip } from "../ui/Tooltip";
import { cn } from "../ui/cn";
import {
  IconCanvas,
  IconChat,
  IconCommand,
  IconGear,
  IconGrid,
  IconMonitor,
  IconMoon,
  IconPanelLeft,
  IconQueue,
  IconSparkle,
  IconSun,
} from "../Icons";

const NAV_ITEMS = [
  { id: "chat", label: "创作", icon: IconChat },
  { id: "gallery", label: "作品", icon: IconGrid },
  { id: "canvas", label: "画布", icon: IconCanvas },
  { id: "retouch", label: "修图", icon: IconSparkle },
  { id: "queue", label: "队列", icon: IconQueue },
  { id: "settings", label: "设置", icon: IconGear },
] as const satisfies readonly {
  id: AppView;
  label: string;
  icon: typeof IconGrid;
}[];

/// 64px 导航轨：所有工作区共用。图标 + 悬停提示，选中态是左侧一道靛青短竖线。
/// 二级内容（会话列表 / 设置分区）交给 Sidebar，不再挤在同一个面板里。
export default function NavRail() {
  const { t } = useTranslation();
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const motionTokens = useMotionTokens();
  const queuePending = useQueueStore(
    (s) => (s.counts.queued ?? 0) + (s.counts.running ?? 0),
  );

  const cycleTheme = () => {
    setTheme(
      theme === "system" ? "dark" : theme === "dark" ? "light" : "system",
    );
  };
  const ThemeIcon =
    theme === "dark" ? IconMoon : theme === "light" ? IconSun : IconMonitor;
  const themeLabel =
    theme === "system"
      ? t("跟随系统")
      : theme === "dark"
        ? t("暗色")
        : t("浅色");

  const rail = (on: boolean) =>
    on ? (
      <motion.span
        layoutId="nav-rail-active"
        transition={motionTokens.spring("snappy")}
        className="absolute -left-3 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-pill bg-accent"
      />
    ) : null;

  return (
    <aside
      aria-label={t("主导航")}
      className="flex w-16 shrink-0 flex-col items-center gap-1 border-r border-separator bg-window py-2"
    >
      {NAV_ITEMS.map((item) => {
        const active = view === item.id;
        return (
          <Tooltip key={item.id} label={t(item.label)} side="right">
            <button
              type="button"
              onClick={() => setView(item.id)}
              aria-label={t(item.label)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "pressable relative flex h-10 w-10 items-center justify-center rounded-btn transition-colors",
                active
                  ? "bg-accent-soft text-accent-text"
                  : "text-tertiary hover:bg-hover hover:text-primary",
              )}
            >
              {rail(active)}
              <item.icon size={18} />
              {item.id === "queue" && queuePending > 0 && (
                <span
                  aria-label={t("{{n}} 个任务待执行", { n: queuePending })}
                  className="tabular absolute right-1 top-1 min-w-4 rounded-pill bg-accent-fill px-1 text-center text-caption leading-4 text-on-accent"
                >
                  {queuePending}
                </span>
              )}
            </button>
          </Tooltip>
        );
      })}

      <span className="flex-1" />

      <Tooltip label={t("切换侧栏")} side="right">
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={t("切换侧栏")}
          className="pressable flex h-10 w-10 items-center justify-center rounded-btn text-tertiary transition-colors hover:bg-hover hover:text-primary"
        >
          <IconPanelLeft size={17} />
        </button>
      </Tooltip>
      <Tooltip label={t("命令面板")} side="right">
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          aria-label={t("打开命令面板")}
          className="pressable flex h-10 w-10 items-center justify-center rounded-btn text-tertiary transition-colors hover:bg-hover hover:text-primary"
        >
          <IconCommand size={17} />
        </button>
      </Tooltip>
      <Tooltip label={t("主题：{{theme}}", { theme: themeLabel })} side="right">
        <button
          type="button"
          onClick={cycleTheme}
          aria-label={t("主题：{{theme}}，点击切换", { theme: themeLabel })}
          className="pressable flex h-10 w-10 items-center justify-center rounded-btn text-tertiary transition-colors hover:bg-hover hover:text-primary"
        >
          <ThemeIcon size={17} />
        </button>
      </Tooltip>
    </aside>
  );
}
