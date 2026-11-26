import { MouseEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { HistoryItem } from "../../lib/api";
import { isGifPath } from "../../lib/image";
import { cn } from "../ui/cn";
import { ContextMenu, MenuItem } from "../ui/Menu";
import SafeImg from "../SafeImg";
import {
  IconCanvas,
  IconDownload,
  IconExpand,
  IconImage,
  IconQuote,
  IconSparkle,
  IconStar,
  IconTrash,
} from "../Icons";
import type { GalleryActions } from "./types";

/** 右键菜单：各视图模式共用一份，保证动作入口不重复也不缺失 */
// eslint-disable-next-line react-refresh/only-export-components -- 菜单 hook 与条目组件同文件复用，避免拆文件后循环依赖
export function useGalleryMenu(
  item: HistoryItem,
  actions: GalleryActions,
): MenuItem[] {
  const { t } = useTranslation();
  const gif = isGifPath(item.history.filePath);
  const menu: MenuItem[] = [
    {
      id: "open",
      label: t("打开"),
      icon: <IconExpand size={14} />,
      onSelect: () => actions.open(item),
    },
    {
      id: "retouch",
      label: t("修图"),
      icon: <IconSparkle size={14} />,
      onSelect: () => actions.retouch(item),
    },
    {
      id: "reuse",
      label: t("复用参数"),
      icon: <IconQuote size={14} />,
      onSelect: () => actions.reuse(item),
    },
    {
      id: "canvas",
      label: t("加入画布"),
      icon: <IconCanvas size={14} />,
      onSelect: () => actions.addToCanvas(item),
    },
    {
      id: "prompt",
      label: t("收藏提示词"),
      icon: <IconStar size={14} />,
      onSelect: () => actions.collectPrompt(item),
    },
    {
      id: "download",
      label: t("下载原图与参数"),
      icon: <IconDownload size={14} />,
      onSelect: () => actions.download(item),
    },
    {
      id: "favorite",
      label: item.history.favorite ? t("取消收藏") : t("收藏该作品"),
      icon: <IconStar size={14} />,
      onSelect: () => actions.toggleFavorite(item),
    },
  ];
  if (gif) {
    menu.push({
      id: "animation",
      label: t("打开动图编辑器"),
      icon: <IconImage size={14} />,
      onSelect: () => actions.openAnimation(item),
    });
  }
  menu.push({
    id: "delete",
    label: t("删除"),
    icon: <IconTrash size={14} />,
    danger: true,
    separatorBefore: true,
    onSelect: () => actions.remove(item),
  });
  return menu;
}

/** 条目外壳：点击选择、双击打开、右键菜单 */
export function GalleryItemShell({
  item,
  selected,
  actions,
  className,
  children,
}: {
  item: HistoryItem;
  selected: boolean;
  actions: GalleryActions;
  className?: string;
  children: ReactNode;
}) {
  const menu = useGalleryMenu(item, actions);
  return (
    <ContextMenu items={menu}>
      <div
        role="option"
        aria-selected={selected}
        tabIndex={-1}
        onClick={(e) =>
          actions.select(item, e.shiftKey, e.ctrlKey || e.metaKey)
        }
        onDoubleClick={() => actions.open(item)}
        className={cn(
          "group relative cursor-default select-none rounded-card outline-none",
          className,
        )}
      >
        {children}
      </div>
    </ContextMenu>
  );
}

/** 缩略图：正方形、object-contain 不裁切；选中环与角标都在这一层 */
export function GalleryThumb({
  item,
  size,
  selected,
  actions,
}: {
  item: HistoryItem;
  size: number;
  selected: boolean;
  actions: GalleryActions;
}) {
  const { t } = useTranslation();
  const showControls = size >= 48;
  return (
    <div
      className={cn(
        "relative shrink-0 overflow-hidden rounded-card bg-sunken",
        selected && "ring-2 ring-accent",
      )}
      style={{ width: size, height: size }}
    >
      {item.thumbUrl ? (
        <SafeImg
          src={item.thumbUrl}
          alt={item.history.prompt}
          className="h-full w-full object-contain"
          loading="lazy"
          decoding="async"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center px-2 text-center text-caption text-tertiary">
          {t("缩略图生成中")}
        </div>
      )}

      {showControls && (
        <>
          <label
            className={cn(
              "glass-media absolute left-1.5 top-1.5 flex h-5 w-5 cursor-pointer items-center justify-center rounded-chip transition-opacity",
              selected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="checkbox"
              aria-label={t("选择作品：{{prompt}}", {
                prompt: item.history.prompt,
              })}
              checked={selected}
              onChange={() => actions.select(item, false, true)}
              onClick={(e) => {
                e.stopPropagation();
                if (e.shiftKey) {
                  e.preventDefault();
                  actions.select(item, true, false);
                }
              }}
              className="size-3.5 cursor-pointer accent-accent-fill"
            />
          </label>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              actions.toggleFavorite(item);
            }}
            aria-label={item.history.favorite ? t("取消收藏") : t("收藏该作品")}
            className="glass-media pressable absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-pill text-caption text-on-accent transition-opacity hover:bg-on-accent/15"
          >
            {item.history.favorite ? "★" : "☆"}
          </button>
        </>
      )}

      <ItemBadges item={item} compact={size < 96} />
      {showControls && size >= 128 && (
        <HoverActions item={item} actions={actions} />
      )}
    </div>
  );
}

function ItemBadges({
  item,
  compact,
}: {
  item: HistoryItem;
  compact: boolean;
}) {
  const { t } = useTranslation();
  const gif = isGifPath(item.history.filePath);
  const derived = item.history.parentId;
  if (!gif && derived == null) return null;
  return (
    <div className="pointer-events-none absolute bottom-1.5 left-1.5 flex flex-col items-start gap-1">
      {gif && (
        <span className="glass-media rounded-pill px-2 py-0.5 text-caption text-on-accent">
          {compact
            ? t("动图")
            : item.animation
              ? t("动图 · {{n}} 帧", { n: item.animation.frames })
              : t("动图")}
        </span>
      )}
      {derived != null && !compact && (
        <span className="glass-media rounded-pill px-2 py-0.5 text-caption text-on-accent">
          {t("派生 #{{id}}", { id: derived })}
        </span>
      )}
    </div>
  );
}

function HoverActions({
  item,
  actions,
}: {
  item: HistoryItem;
  actions: GalleryActions;
}) {
  const { t } = useTranslation();
  const btn =
    "pressable flex h-7 w-7 items-center justify-center rounded-pill text-on-accent hover:bg-on-accent/15";
  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-1.5 opacity-0 transition-opacity duration-200 group-focus-within:opacity-100 group-hover:opacity-100">
      <div className="glass-media pointer-events-auto flex items-center gap-0.5 rounded-pill p-0.5">
        <button
          type="button"
          onClick={stop(() => actions.retouch(item))}
          aria-label={t("修图")}
          title={t("修图")}
          className={btn}
        >
          <IconSparkle size={13} />
        </button>
        <button
          type="button"
          onClick={stop(() => actions.reuse(item))}
          aria-label={t("复用参数")}
          title={t("复用参数")}
          className={btn}
        >
          <IconQuote size={13} />
        </button>
        <button
          type="button"
          onClick={stop(() => actions.addToCanvas(item))}
          aria-label={t("加入画布")}
          title={t("加入画布")}
          className={btn}
        >
          <IconCanvas size={13} />
        </button>
        {isGifPath(item.history.filePath) && (
          <button
            type="button"
            onClick={stop(() => actions.openAnimation(item))}
            aria-label={t("打开动图编辑器")}
            title={t("打开动图编辑器")}
            className={btn}
          >
            <IconImage size={13} />
          </button>
        )}
        <button
          type="button"
          onClick={stop(() => actions.download(item))}
          aria-label={t("下载原图与参数")}
          title={t("下载原图与参数")}
          className={btn}
        >
          <IconDownload size={13} />
        </button>
        <button
          type="button"
          onClick={stop(() => actions.remove(item))}
          aria-label={t("删除")}
          title={t("删除")}
          className={btn}
        >
          <IconTrash size={13} />
        </button>
      </div>
    </div>
  );
}

/** 行内小缩略图（列表 / 详细信息 / 内容共用） */
export function RowThumb({ item, size }: { item: HistoryItem; size: number }) {
  return (
    <div
      className="shrink-0 overflow-hidden rounded-chip bg-sunken"
      style={{ width: size, height: size }}
    >
      {item.thumbUrl ? (
        <SafeImg
          src={item.thumbUrl}
          alt={item.history.prompt}
          className="h-full w-full object-contain"
          loading="lazy"
          decoding="async"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-caption text-tertiary">
          —
        </div>
      )}
    </div>
  );
}
