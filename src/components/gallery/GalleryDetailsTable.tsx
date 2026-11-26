import { useTranslation } from "react-i18next";
import type { HistoryItem } from "../../lib/api";
import {
  DETAILS_COLUMNS,
  formatBytes,
  formatDimensions,
  formatHistoryDate,
  historyType,
  type GallerySort,
} from "../../lib/galleryView";
import type { SortOrder } from "../../lib/api";
import { IconChevron } from "../Icons";
import { cn } from "../ui/cn";
import { GalleryItemShell, RowThumb } from "./GalleryItem";
import { FavoriteStar, RowCheckbox } from "./GalleryList";
import type { GalleryActions } from "./types";

function alignClass(align: "left" | "right" | "center") {
  return align === "right"
    ? "justify-end text-right"
    : align === "center"
      ? "justify-center text-center"
      : "justify-start text-left";
}

/// 详细信息表头：点击列头切换排序，方向由同一个排序状态驱动
export function GalleryDetailsHeader({
  sort,
  order,
  onSort,
}: {
  sort: GallerySort;
  order: SortOrder;
  onSort: (sort: GallerySort) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mx-4 flex h-9 shrink-0 items-center gap-2 border-b border-line px-2">
      {DETAILS_COLUMNS.map((column) => {
        const active = column.sort === sort;
        return (
          <div key={column.key} className={column.widthClass}>
            <button
              type="button"
              onClick={() => onSort(column.sort)}
              aria-sort={
                active ? (order === "asc" ? "ascending" : "descending") : "none"
              }
              className={cn(
                "flex w-full items-center gap-0.5 truncate text-caption transition-colors",
                alignClass(column.align),
                active ? "text-primary" : "text-tertiary hover:text-secondary",
              )}
            >
              <span className="truncate">{t(column.label)}</span>
              {active && (
                <IconChevron
                  size={12}
                  direction={order === "asc" ? "up" : "down"}
                />
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/// 详细信息行：名称列带行内缩略图，其余列按表头宽度对齐
export function GalleryDetailsRow({
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
        "mx-4 flex h-full items-center gap-2 px-2",
        selected ? "bg-accent-soft" : "hover:bg-hover",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <RowCheckbox item={item} selected={selected} actions={actions} />
        <RowThumb item={item} size={thumbSize} />
        <span className="truncate text-callout text-primary">
          {history.prompt || t("（无提示词）")}
        </span>
      </div>
      <span className="tabular w-36 shrink-0 truncate text-caption text-tertiary">
        {formatHistoryDate(history.createdAt)}
      </span>
      <span className="w-16 shrink-0 truncate text-caption text-secondary">
        {historyType(item)}
      </span>
      <span className="tabular w-20 shrink-0 truncate text-right text-caption text-secondary">
        {formatBytes(history.fileSize)}
      </span>
      <span className="tabular w-28 shrink-0 truncate text-caption text-secondary">
        {formatDimensions(history.width, history.height)}
      </span>
      <span className="w-32 shrink-0 truncate text-caption text-secondary">
        {history.model || t("未知模型")}
      </span>
      <span className="w-28 shrink-0 truncate text-caption text-secondary">
        {history.style || t("未知风格")}
      </span>
      <div className="flex w-14 shrink-0 justify-center">
        <FavoriteStar item={item} actions={actions} />
      </div>
    </GalleryItemShell>
  );
}
