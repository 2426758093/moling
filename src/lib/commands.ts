import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { ParseKeysWithoutVariables } from "i18next";
import i18n from "../i18n";
import { api } from "./api";
import { toast } from "./notify";
import { useAppStore } from "../stores/appStore";
import { useChatStore } from "../stores/chatStore";
import { useQueueStore } from "../stores/queueStore";

export type CommandGroup = "导航" | "对话" | "队列" | "外观" | "工具";

export type CommandIcon =
  | "chat"
  | "gallery"
  | "canvas"
  | "queue"
  | "gear"
  | "plus"
  | "search"
  | "sparkle"
  | "command"
  | "sun"
  | "moon"
  | "monitor"
  | "panel"
  | "keyboard"
  | "info";

export interface Command {
  id: string;
  /// 中文原文，也就是词典 key：展示前由 commandTitle 翻译
  title: string;
  hint?: string;
  group: CommandGroup;
  icon?: CommandIcon;
  shortcut?: string;
  keywords?: string[];
  /// 当前状态下是否可用（不可用的命令不出现在面板里）
  when?: () => boolean;
  run: () => void | Promise<void>;
}

/// 跨组件的一次性意图：键盘与命令面板只发事件，具体组件自己处理焦点。
export const FOCUS_COMPOSER_EVENT = "moling:focus-composer";
export const FOCUS_SIDEBAR_SEARCH_EVENT = "moling:focus-sidebar-search";
export const OPEN_ASSIST_EVENT = "moling:open-assist";

function emit(name: string) {
  window.dispatchEvent(new CustomEvent(name));
}

const app = () => useAppStore.getState();
const chat = () => useChatStore.getState();
const queue = () => useQueueStore.getState();

export const COMMANDS: Command[] = [
  {
    id: "nav.chat",
    title: "打开聊天",
    group: "导航",
    icon: "chat",
    shortcut: "Ctrl 1",
    keywords: ["对话", "生成", "chat"],
    run: () => app().setView("chat"),
  },
  {
    id: "nav.gallery",
    title: "打开画廊",
    group: "导航",
    icon: "gallery",
    shortcut: "Ctrl 2",
    keywords: ["作品", "历史", "gallery"],
    run: () => app().setView("gallery"),
  },
  {
    id: "nav.canvas",
    title: "打开画布",
    group: "导航",
    icon: "canvas",
    shortcut: "Ctrl 3",
    keywords: ["无限画布", "canvas"],
    run: () => app().setView("canvas"),
  },
  {
    id: "nav.queue",
    title: "打开队列",
    group: "导航",
    icon: "queue",
    shortcut: "Ctrl 4",
    keywords: ["任务", "queue"],
    run: () => app().setView("queue"),
  },
  {
    id: "nav.retouch",
    title: "打开修图",
    group: "导航",
    icon: "sparkle",
    shortcut: "Ctrl 5",
    keywords: ["修图", "美化", "retouch", "photo"],
    run: () => app().setView("retouch"),
  },
  {
    id: "nav.settings",
    title: "打开设置",
    group: "导航",
    icon: "gear",
    shortcut: "Ctrl ,",
    keywords: ["偏好", "配置", "settings"],
    run: () => app().setView("settings"),
  },
  {
    id: "chat.new",
    title: "新建对话",
    group: "对话",
    icon: "plus",
    shortcut: "Ctrl N",
    keywords: ["新会话", "new"],
    run: async () => {
      app().setView("chat");
      await chat().newConversation();
    },
  },
  {
    id: "chat.focus",
    title: "聚焦提示词输入框",
    group: "对话",
    icon: "sparkle",
    keywords: ["输入", "composer"],
    run: () => {
      app().setView("chat");
      emit(FOCUS_COMPOSER_EVENT);
    },
  },
  {
    id: "chat.assist",
    title: "打开提示词助手",
    group: "对话",
    icon: "command",
    keywords: ["模板", "灵感", "反推", "翻译"],
    run: () => {
      app().setView("chat");
      emit(OPEN_ASSIST_EVENT);
    },
  },
  {
    id: "chat.search",
    title: "搜索对话",
    group: "对话",
    icon: "search",
    shortcut: "Ctrl F",
    keywords: ["查找", "search"],
    run: () => emit(FOCUS_SIDEBAR_SEARCH_EVENT),
  },
  {
    id: "queue.start",
    title: "开始队列",
    group: "队列",
    icon: "queue",
    hint: "执行暂停中的生成任务",
    when: () => queue().paused,
    run: async () => {
      app().setView("queue");
      await queue().start();
    },
  },
  {
    id: "queue.clear",
    title: "清空已完成的队列任务",
    group: "队列",
    icon: "queue",
    when: () =>
      queue().jobs.some(
        (job) =>
          job.status === "done" ||
          job.status === "failed" ||
          job.status === "canceled" ||
          job.status === "interrupted",
      ),
    run: async () => {
      app().setView("queue");
      await queue().clearFinished();
    },
  },
  {
    id: "appearance.theme.system",
    title: "主题：跟随系统",
    group: "外观",
    icon: "monitor",
    when: () => app().theme !== "system",
    run: () => app().setTheme("system"),
  },
  {
    id: "appearance.theme.light",
    title: "主题：浅色",
    group: "外观",
    icon: "sun",
    when: () => app().theme !== "light",
    run: () => app().setTheme("light"),
  },
  {
    id: "appearance.theme.dark",
    title: "主题：暗色",
    group: "外观",
    icon: "moon",
    when: () => app().theme !== "dark",
    run: () => app().setTheme("dark"),
  },
  {
    id: "appearance.glass.clear",
    title: "玻璃质感：清晰",
    group: "外观",
    icon: "sparkle",
    when: () => app().glass !== "clear",
    run: () => app().setGlass("clear"),
  },
  {
    id: "appearance.glass.standard",
    title: "玻璃质感：标准",
    group: "外观",
    icon: "sparkle",
    when: () => app().glass !== "standard",
    run: () => app().setGlass("standard"),
  },
  {
    id: "appearance.glass.tinted",
    title: "玻璃质感：着色",
    group: "外观",
    icon: "sparkle",
    when: () => app().glass !== "tinted",
    run: () => app().setGlass("tinted"),
  },
  {
    id: "appearance.transparency",
    title: "减少透明效果",
    hint: "关闭玻璃模糊，换取更低的绘制开销",
    group: "外观",
    icon: "panel",
    when: () => !app().reduceTransparency,
    run: () => app().setReduceTransparency(true),
  },
  {
    id: "appearance.transparency.off",
    title: "恢复玻璃透明效果",
    group: "外观",
    icon: "sparkle",
    when: () => app().reduceTransparency,
    run: () => app().setReduceTransparency(false),
  },
  {
    id: "appearance.sidebar",
    title: "折叠 / 展开侧栏",
    group: "外观",
    icon: "panel",
    shortcut: "Ctrl B",
    run: () => app().toggleSidebar(),
  },
  {
    id: "tools.shortcuts",
    title: "快捷键一览",
    group: "工具",
    icon: "keyboard",
    shortcut: "F1",
    run: () => app().setShortcutsOpen(true),
  },
  {
    id: "tools.logs",
    title: "打开日志目录",
    group: "工具",
    icon: "info",
    run: async () => {
      try {
        const dir = await api.getLogsDir();
        await revealItemInDir(dir);
      } catch (e) {
        toast(
          i18n.t("打开日志目录失败：{{error}}", { error: String(e) }),
          "error",
        );
      }
    },
  },
];

/// 标题是中文原文（词典 key）：展示与搜索都按当前语言取文案。
function commandTitle(command: Command): string {
  return i18n.t(command.title as ParseKeysWithoutVariables);
}

/// 前缀 > 词首 > 子串 > 关键词；同分保持原顺序，空查询把最近使用提到最前。
export function filterCommands(
  commands: Command[],
  query: string,
  recentIds: string[] = [],
): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    const ids = [...new Set(recentIds)];
    const recent = ids
      .map((id) => commands.find((c) => c.id === id))
      .filter((c): c is Command => c != null);
    const rest = commands.filter((c) => !ids.includes(c.id));
    return [...recent, ...rest];
  }
  return commands
    .map((command) => ({ command, score: score(command, q) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.command);
}

function score(command: Command, query: string): number {
  // 原文与译文都参与匹配：英文界面下能按可见英文标题搜到，中文仍可搜
  const titles = [command.title, commandTitle(command)].map((text) =>
    text.toLowerCase(),
  );
  if (titles.some((title) => title.startsWith(query))) return 100;
  if (titles.some((title) => title.includes(query))) return 60;
  if (command.keywords?.some((k) => k.toLowerCase().startsWith(query)))
    return 40;
  if (command.keywords?.some((k) => k.toLowerCase().includes(query))) return 25;
  if (titles.some((title) => isSubsequence(query, title))) return 10;
  return 0;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i += 1;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}
