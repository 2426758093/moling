import { useTranslation } from "react-i18next";
import type { HistoryItem } from "../../lib/api";
import { formatHistoryDate } from "../../lib/galleryView";
import { GalleryItemShell, RowThumb } from "./GalleryItem";
import type { GalleryActions } from "./types";
import { cn } from "../ui/cn";

/// 列表：单列，缩略图 + 一行提示词 + 模型 / 日期
export function GalleryList({
  item,
  thumbSize,
  selected,
  actions,
}: {
  item: HistoryItem;
  thumbSize: number;
  selected: boolean;
  actions: GalleryActions;
}) {
  const { t } = useTranslation();
  const history = item.history;
  return (
    <GalleryItemShell
      item={item}
      selected={selected}
      actions={actions}
      className={cn(
        "mx-4 flex h-full items-center gap-3 px-2",
        selected ? "bg-accent-soft" : "hover:bg-hover",
      )}
    >
      <RowCheckbox item={item} selected={selected} actions={actions} />
      <RowThumb item={item} size={thumbSize} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-callout text-primary">
          {history.prompt || t("（无提示词）")}
        </p>
      </div>
      <span className="hidden shrink-0 text-caption text-tertiary sm:block">
        {history.model || t("未知模型")}
      </span>
      <span className="tabular hidden shrink-0 text-caption text-quaternary md:block">
        {formatHistoryDate(history.createdAt)}
      </span>
      <FavoriteStar item={item} actions={actions} />
    </GalleryItemShell>
  );
}

export function RowCheckbox({
  item,
  selected,
  actions,
}: {
  item: HistoryItem;
  selected: boolean;
  actions: GalleryActions;
}) {
  const { t } = useTranslation();
  return (
    <input
      type="checkbox"
      aria-label={t("选择作品：{{prompt}}", { prompt: item.history.prompt })}
      checked={selected}
      onChange={() => actions.select(item, false, true)}
      onClick={(e) => {
        e.stopPropagation();
        if (e.shiftKey) {
          e.preventDefault();
          actions.select(item, true, false);
        }
      }}
      className="size-3.5 shrink-0 cursor-pointer accent-accent-fill"
    />
  );
}

export function FavoriteStar({
  item,
  actions,
}: {
  item: HistoryItem;
  actions: GalleryActions;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        actions.toggleFavorite(item);
      }}
      aria-label={item.history.favorite ? t("取消收藏") : t("收藏该作品")}
      className="pressable flex h-7 w-7 shrink-0 items-center justify-center rounded-pill text-callout text-tertiary hover:bg-hover hover:text-primary"
    >
      {item.history.favorite ? "★" : "☆"}
    </button>
  );
}
