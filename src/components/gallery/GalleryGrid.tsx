import { useTranslation } from "react-i18next";
import type { HistoryItem } from "../../lib/api";
import { GalleryItemShell, GalleryThumb } from "./GalleryItem";
import type { GalleryActions } from "./types";

/// 超大 / 大 / 中 / 小图标：正方形缩略图 + 一行提示词
export function GalleryGrid({
  items,
  iconSize,
  cellWidth,
  selected,
  actions,
}: {
  items: HistoryItem[];
  iconSize: number;
  cellWidth: number;
  selected: Set<number>;
  actions: GalleryActions;
}) {
  const gap = 12;
  return (
    <div
      className="flex items-start px-4"
      style={{ gap, height: iconSize + 46 }}
    >
      {items.map((item) => (
        <GridCell
          key={item.history.id}
          item={item}
          iconSize={iconSize}
          cellWidth={cellWidth}
          selected={selected.has(item.history.id)}
          actions={actions}
        />
      ))}
    </div>
  );
}

function GridCell({
  item,
  iconSize,
  cellWidth,
  selected,
  actions,
}: {
  item: HistoryItem;
  iconSize: number;
  cellWidth: number;
  selected: boolean;
  actions: GalleryActions;
}) {
  const { t } = useTranslation();
  return (
    <GalleryItemShell
      item={item}
      selected={selected}
      actions={actions}
      className="flex flex-col items-start gap-1.5 pt-1"
    >
      <div style={{ width: cellWidth }}>
        <GalleryThumb
          item={item}
          size={iconSize}
          selected={selected}
          actions={actions}
        />
        <p className="mt-1.5 line-clamp-1 text-caption text-secondary">
          {item.history.prompt || t("（无提示词）")}
        </p>
      </div>
    </GalleryItemShell>
  );
}
