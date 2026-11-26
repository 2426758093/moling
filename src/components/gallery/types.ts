import type { HistoryItem } from "../../lib/api";

/// 作品条目上的所有操作：由 GalleryView 注入，各视图模式与详情窗格共用
export interface GalleryActions {
  /// shift = 区间连选；additive = Ctrl/⌘ 点选追加
  select: (item: HistoryItem, shift: boolean, additive: boolean) => void;
  open: (item: HistoryItem) => void;
  toggleFavorite: (item: HistoryItem) => void;
  retouch: (item: HistoryItem) => void;
  reuse: (item: HistoryItem) => void;
  addToCanvas: (item: HistoryItem) => void;
  collectPrompt: (item: HistoryItem) => void;
  download: (item: HistoryItem) => void;
  remove: (item: HistoryItem) => void;
  openAnimation: (item: HistoryItem) => void;
}
