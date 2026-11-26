import { useTranslation } from "react-i18next";
import type { HistoryItem } from "../../lib/api";
import { formatDimensions } from "../../lib/galleryView";
import { GalleryItemShell, GalleryThumb } from "./GalleryItem";
import type { GalleryActions } from "./types";

/// 平铺：缩略图 + 两行提示词 + 模型 / 尺寸
export function GalleryTiles({
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
  return (
    <div
      className="flex items-start gap-3 px-4"
      style={{ height: iconSize + 64 }}
    >
      {items.map((item) => (
        <div key={item.history.id} style={{ width: cellWidth }}>
          <Tile
            item={item}
            iconSize={iconSize}
            selected={selected.has(item.history.id)}
            actions={actions}
          />
        </div>
      ))}
    </div>
  );
}

function Tile({
  item,
  iconSize,
  selected,
  actions,
}: {
  item: HistoryItem;
  iconSize: number;
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
      className="flex flex-col gap-1.5 pt-1"
    >
      <GalleryThumb
        item={item}
        size={iconSize}
        selected={selected}
        actions={actions}
      />
      <div className="min-w-0">
        <p className="line-clamp-2 text-caption text-secondary">
          {history.prompt || t("（无提示词）")}
        </p>
        <p className="mt-0.5 truncate text-caption text-tertiary">
          {history.model || t("未知模型")} ·{" "}
          {formatDimensions(history.width, history.height)}
        </p>
      </div>
    </GalleryItemShell>
  );
}
