import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  COMMANDS,
  Command,
  CommandIcon,
  filterCommands,
} from "../../lib/commands";
import { useAppStore } from "../../stores/appStore";
import {
  IconCanvas,
  IconChat,
  IconCommand,
  IconGear,
  IconGrid,
  IconInfo,
  IconKeyboard,
  IconMonitor,
  IconMoon,
  IconPanelLeft,
  IconPlus,
  IconQueue,
  IconSearch,
  IconSparkle,
  IconSun,
} from "../Icons";
import { Kbd } from "./Kbd";
import { cn } from "./cn";

const RECENT_KEY = "moling.recentCommands";
const RECENT_LIMIT = 5;

const ICONS: Record<CommandIcon, typeof IconGrid> = {
  chat: IconChat,
  gallery: IconGrid,
  canvas: IconCanvas,
  queue: IconQueue,
  gear: IconGear,
  plus: IconPlus,
  search: IconSearch,
  sparkle: IconSparkle,
  command: IconCommand,
  sun: IconSun,
  moon: IconMoon,
  monitor: IconMonitor,
  panel: IconPanelLeft,
  keyboard: IconKeyboard,
  info: IconInfo,
};

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

function writeRecent(ids: string[]) {
  try {
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify(ids.slice(0, RECENT_LIMIT)),
    );
  } catch {
    // 无存储权限时只影响"最近使用"排序
  }
}

type Row =
  | { type: "group"; key: string; label: string }
  | { type: "command"; key: string; command: Command; index: number };

export function CommandPalette() {
  const open = useAppStore((s) => s.paletteOpen);
  const setOpen = useAppStore((s) => s.setPaletteOpen);
  // 只在打开时挂载：每次打开都是干净状态，不需要用 effect 重置查询与高亮
  return open ? <PaletteContent onClose={() => setOpen(false)} /> : null;
}

function PaletteContent({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>(readRecent);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo(
    () =>
      filterCommands(
        COMMANDS.filter((c) => !c.when || c.when()),
        query,
        recent,
      ),
    [query, recent],
  );
  // 过滤后结果变少时高亮可能越界：派生出当前项，不写回 state
  const current = items.length === 0 ? -1 : Math.min(active, items.length - 1);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let group: string | null = null;
    items.forEach((command, index) => {
      if (!query.trim() && command.group !== group) {
        group = command.group;
        out.push({ type: "group", key: `g-${group}`, label: group });
      }
      out.push({ type: "command", key: command.id, command, index });
    });
    return out;
  }, [items, query]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${current}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const close = () => onClose();

  const run = (command: Command) => {
    close();
    const next = [
      command.id,
      ...recent.filter((id) => id !== command.id),
    ].slice(0, RECENT_LIMIT);
    setRecent(next);
    writeRecent(next);
    try {
      void command.run();
    } catch {
      // 命令内部各自负责 toast
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length > 0) setActive((current + 1) % items.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length > 0)
        setActive((current - 1 + items.length) % items.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const command = items[current];
      if (command) run(command);
    }
  };

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[59] bg-scrim" />
        <DialogPrimitive.Content
          className="glass fixed left-1/2 top-[15vh] z-[60] flex w-[min(640px,calc(100vw-32px))] -translate-x-1/2 flex-col overflow-hidden rounded-pop shadow-sheet outline-none"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
          }}
        >
          <DialogPrimitive.Title className="sr-only">
            命令面板
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            输入关键词搜索命令，方向键选择，回车执行。
          </DialogPrimitive.Description>

          <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-separator px-3.5">
            <span className="text-tertiary">
              <IconSearch size={16} />
            </span>
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              role="combobox"
              aria-expanded
              aria-controls="command-list"
              aria-autocomplete="list"
              aria-activedescendant={
                current >= 0 ? `command-${items[current].id}` : undefined
              }
              placeholder="搜索命令、页面或设置…"
              aria-label="搜索命令"
              className="h-full min-w-0 flex-1 bg-transparent text-body text-primary outline-none placeholder:text-tertiary"
            />
            <Kbd>Esc</Kbd>
          </div>

          <div
            ref={listRef}
            id="command-list"
            role="listbox"
            aria-label="命令"
            className="max-h-[min(420px,55vh)] overflow-y-auto p-1.5"
          >
            {items.length === 0 ? (
              <div className="px-3 py-10 text-center text-footnote text-tertiary">
                没有匹配的命令
              </div>
            ) : (
              rows.map((row) =>
                row.type === "group" ? (
                  <div
                    key={row.key}
                    role="presentation"
                    className="px-2 pt-2 pb-1 text-caption text-tertiary"
                  >
                    {row.label}
                  </div>
                ) : (
                  <button
                    key={row.key}
                    type="button"
                    role="option"
                    id={`command-${row.command.id}`}
                    aria-selected={row.index === current}
                    data-index={row.index}
                    onPointerEnter={() => setActive(row.index)}
                    onClick={() => run(row.command)}
                    className={cn(
                      "flex h-9 w-full items-center gap-2.5 rounded-btn px-2.5 text-left text-callout transition-colors",
                      row.index === current
                        ? "bg-accent-soft text-accent-text"
                        : "text-secondary hover:bg-hover hover:text-primary",
                    )}
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center opacity-80">
                      {row.command.icon
                        ? ICONS[row.command.icon]({ size: 15 })
                        : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {row.command.title}
                    </span>
                    {row.command.hint && (
                      <span className="hidden shrink-0 text-footnote text-tertiary compact:block">
                        {row.command.hint}
                      </span>
                    )}
                    {row.command.shortcut && <Kbd>{row.command.shortcut}</Kbd>}
                  </button>
                ),
              )
            )}
          </div>

          <div className="flex shrink-0 items-center gap-3 border-t border-separator px-3.5 py-2 text-caption text-tertiary">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              选择
            </span>
            <span className="flex items-center gap-1">
              <Kbd>Enter</Kbd>
              执行
            </span>
            <span className="ml-auto">Esc 关闭</span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
