import { useTranslation } from "react-i18next";
import type { HistoryItem } from "../../lib/api";
import { formatHistoryDate } from "../../lib/galleryView";
import { cn } from "../ui/cn";
import { GalleryItemShell, RowThumb } from "./GalleryItem";
import { FavoriteStar, RowCheckbox } from "./GalleryList";
import type { GalleryActions } from "./types";

/// 内容：小缩略图 + 多行提示词 / 模型 / 日期
export function GalleryContent({
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
        "mx-4 flex h-full items-start gap-3 px-2 py-1.5",
        selected ? "bg-accent-soft" : "hover:bg-hover",
      )}
    >
      <div className="flex h-full items-start gap-2">
        <RowCheckbox item={item} selected={selected} actions={actions} />
        <RowThumb item={item} size={thumbSize} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-3 text-callout text-primary">
          {history.prompt || t("（无提示词）")}
        </p>
        <p className="mt-1 truncate text-caption text-tertiary">
          {history.model || t("未知模型")} ·{" "}
          {formatHistoryDate(history.createdAt)}
        </p>
      </div>
      <FavoriteStar item={item} actions={actions} />
    </GalleryItemShell>
  );
}
