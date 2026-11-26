/// 作品页（Windows 11 资源管理器式）的纯逻辑：
/// 视图/缩放映射、排序与分组、详情列定义、分页游标与查询构造。
/// 组件只负责渲染，所有可测的判定都收敛在这里。
import type {
  HistoryItem,
  HistoryQueryArgs,
  HistorySort,
  SortOrder,
} from "./api";
import { dayKey, dayLabel } from "./date";
import { extOf } from "./image";
import i18n from "../i18n";

/* ============================================================================
   视图与缩放
   ============================================================================ */

export type ViewMode =
  | "xlarge"
  | "large"
  | "medium"
  | "small"
  | "list"
  | "details"
  | "tiles"
  | "content";

export const VIEW_MODES: ViewMode[] = [
  "xlarge",
  "large",
  "medium",
  "small",
  "list",
  "details",
  "tiles",
  "content",
];

/** 图标模式：缩略图为正方形，缩放直接改边长 */
const ICON_MODES = new Set<ViewMode>(["xlarge", "large", "medium", "small"]);

export function isIconMode(mode: ViewMode): boolean {
  return ICON_MODES.has(mode);
}

export const ICON_SIZE_MIN = 64;
export const ICON_SIZE_MAX = 320;
export const ICON_SIZE_STEP = 16;
export const DEFAULT_ICON_SIZE = 160;

/** 列表 / 详细信息行内缩略图区间（由 iconSize 线性映射而来） */
export const ROW_THUMB_MIN = 16;
export const ROW_THUMB_MAX = 96;

/** 缩放值对齐到 16 的步长并夹在合法区间内 */
export function snapIconSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ICON_SIZE;
  const clamped = Math.min(ICON_SIZE_MAX, Math.max(ICON_SIZE_MIN, value));
  const steps = Math.round((clamped - ICON_SIZE_MIN) / ICON_SIZE_STEP);
  return ICON_SIZE_MIN + steps * ICON_SIZE_STEP;
}

/** Ctrl + 滚轮：每格 ±16；正数放大 */
export function zoomIconSize(current: number, steps: number): number {
  return snapIconSize(snapIconSize(current) + steps * ICON_SIZE_STEP);
}

/** 跨阈值切换模式标签：<80 小 / <128 中 / <192 大 / ≥192 超大 */
export function iconModeForSize(size: number): ViewMode {
  if (!Number.isFinite(size)) return "large";
  if (size < 80) return "small";
  if (size < 128) return "medium";
  if (size < 192) return "large";
  return "xlarge";
}

/** 行内缩略图边长：iconSize 64–320 → 16–96 */
export function rowThumbSize(iconSize: number): number {
  const value = snapIconSize(iconSize);
  const ratio = (value - ICON_SIZE_MIN) / (ICON_SIZE_MAX - ICON_SIZE_MIN); // 0..1
  return Math.min(
    ROW_THUMB_MAX,
    Math.max(ROW_THUMB_MIN, Math.round(ROW_THUMB_MIN + ratio * 80)),
  );
}

/** 切换到某个视图时给一个代表性的图标尺寸 */
export function defaultIconSizeForMode(mode: ViewMode): number {
  switch (mode) {
    case "xlarge":
      return 256;
    case "large":
      return 160;
    case "medium":
      return 112;
    case "small":
      return 64;
    case "tiles":
      return 160;
    case "content":
      return 96;
    default:
      return DEFAULT_ICON_SIZE;
  }
}

/* ============================================================================
   偏好持久化
   ============================================================================ */

export type GroupBy = "none" | "date" | "model" | "style" | "favorite" | "size";

/** 排序键与服务端 HistorySort 一一对应（含类型/风格） */
export type GallerySort = HistorySort;

export interface GalleryPrefs {
  mode: ViewMode;
  iconSize: number;
  sort: GallerySort;
  order: SortOrder;
  group: GroupBy;
  detailsPane: boolean;
}

export const GALLERY_PREFS_KEY = "moling.gallery.view";

export const DEFAULT_PREFS: GalleryPrefs = {
  mode: "large",
  iconSize: DEFAULT_ICON_SIZE,
  sort: "date",
  order: "desc",
  group: "date",
  detailsPane: false,
};

const SORTS: GallerySort[] = [
  "date",
  "name",
  "type",
  "size",
  "dimensions",
  "model",
  "style",
  "favorite",
];

const GROUPS: GroupBy[] = [
  "none",
  "date",
  "model",
  "style",
  "favorite",
  "size",
];

export function isViewMode(value: unknown): value is ViewMode {
  return typeof value === "string" && VIEW_MODES.includes(value as ViewMode);
}

export function isGallerySort(value: unknown): value is GallerySort {
  return typeof value === "string" && SORTS.includes(value as GallerySort);
}

export function isGroupBy(value: unknown): value is GroupBy {
  return typeof value === "string" && GROUPS.includes(value as GroupBy);
}

/** 容错解析：旧版本 / 手改坏的数据都回退默认值，不让页面崩 */
export function parseGalleryPrefs(raw: string | null): GalleryPrefs {
  if (!raw) return { ...DEFAULT_PREFS };
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return { ...DEFAULT_PREFS };
    const obj = value as Record<string, unknown>;
    const mode = isViewMode(obj.mode) ? obj.mode : DEFAULT_PREFS.mode;
    const iconSize = Number.isFinite(Number(obj.iconSize))
      ? snapIconSize(Number(obj.iconSize))
      : DEFAULT_PREFS.iconSize;
    return {
      mode,
      iconSize,
      sort: isGallerySort(obj.sort) ? obj.sort : DEFAULT_PREFS.sort,
      order: obj.order === "asc" ? "asc" : "desc",
      group: isGroupBy(obj.group) ? obj.group : DEFAULT_PREFS.group,
      detailsPane: obj.detailsPane === true,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function serializeGalleryPrefs(prefs: GalleryPrefs): string {
  return JSON.stringify(prefs);
}

/* ============================================================================
   排序
   ============================================================================ */

export const SORT_OPTIONS = [
  { value: "name", label: "名称" },
  { value: "date", label: "修改日期" },
  { value: "type", label: "类型" },
  { value: "size", label: "大小" },
  { value: "dimensions", label: "尺寸" },
  { value: "model", label: "模型" },
  { value: "style", label: "风格" },
  { value: "favorite", label: "收藏" },
] as const;

export const GROUP_OPTIONS = [
  { value: "none", label: "无分组" },
  { value: "date", label: "按日期" },
  { value: "model", label: "按模型" },
  { value: "style", label: "按风格" },
  { value: "favorite", label: "按收藏" },
  { value: "size", label: "按大小" },
] as const;

export const VIEW_OPTIONS = [
  { value: "xlarge", label: "超大图标" },
  { value: "large", label: "大图标" },
  { value: "medium", label: "中图标" },
  { value: "small", label: "小图标" },
  { value: "list", label: "列表" },
  { value: "details", label: "详细信息" },
  { value: "tiles", label: "平铺" },
  { value: "content", label: "内容" },
] as const;

/** 服务端已覆盖全部排序键；保留函数是为了集中契约，方便以后调整 */
export function serverSortFor(sort: GallerySort): HistorySort {
  return sort;
}

export function serverOrderFor(
  _sort: GallerySort,
  order: SortOrder,
): SortOrder {
  return order;
}

function createdAtOf(item: HistoryItem): number {
  const value = Number(item.history.createdAt);
  return Number.isFinite(value) ? value : 0;
}

function compareBy(a: HistoryItem, b: HistoryItem, sort: GallerySort): number {
  switch (sort) {
    case "name":
      return a.history.prompt.localeCompare(b.history.prompt, "zh");
    case "date":
      return createdAtOf(a) - createdAtOf(b);
    case "type":
      return extOf(a.history.filePath).localeCompare(extOf(b.history.filePath));
    case "size":
      return (a.history.fileSize ?? 0) - (b.history.fileSize ?? 0);
    case "dimensions": {
      const areaA = Number(a.history.width) * Number(a.history.height);
      const areaB = Number(b.history.width) * Number(b.history.height);
      return areaA - areaB;
    }
    case "model":
      return a.history.model.localeCompare(b.history.model, "zh");
    case "style":
      return a.history.style.localeCompare(b.history.style, "zh");
    case "favorite":
      return Number(a.history.favorite) - Number(b.history.favorite);
    default:
      return 0;
  }
}

/** 稳定排序：同值时按 id 升序，翻页追加不会来回跳 */
export function sortHistoryItems(
  items: HistoryItem[],
  sort: GallerySort,
  order: SortOrder,
): HistoryItem[] {
  const direction = order === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    const diff = compareBy(a, b, sort);
    if (diff !== 0) return diff * direction;
    return a.history.id - b.history.id;
  });
}

/** 点表头：同列切升降序，换列时日期默认降序、其余升序 */
export function nextSortState(
  sort: GallerySort,
  currentSort: GallerySort,
  currentOrder: SortOrder,
): { sort: GallerySort; order: SortOrder } {
  if (sort === currentSort) {
    return { sort, order: currentOrder === "asc" ? "desc" : "asc" };
  }
  return { sort, order: sort === "date" ? "desc" : "asc" };
}

/* ============================================================================
   分组
   ============================================================================ */

const MB = 1024 * 1024;

const SIZE_BUCKETS = [
  { max: 1, key: "empty", label: "未知大小" },
  { max: 1 * MB, key: "lt1", label: "小于 1 MB" },
  { max: 5 * MB, key: "1to5", label: "1–5 MB" },
  { max: 20 * MB, key: "5to20", label: "5–20 MB" },
  { max: Number.POSITIVE_INFINITY, key: "gt20", label: "大于 20 MB" },
] as const;

export interface GallerySection {
  key: string;
  /** 空串表示不渲染组头（分组=无） */
  label: string;
  items: HistoryItem[];
}

function sizeBucketLabel(bytes: number) {
  return (
    SIZE_BUCKETS.find((b) => bytes < b.max) ??
    SIZE_BUCKETS[SIZE_BUCKETS.length - 1]
  );
}

/** 按当前排序流切组：同组必须相邻（组头插在流里） */
export function groupHistoryItems(
  items: HistoryItem[],
  group: GroupBy,
): GallerySection[] {
  if (items.length === 0) return [];
  if (group === "none") return [{ key: "all", label: "", items }];

  const out: GallerySection[] = [];
  for (const item of items) {
    const { key, label } = sectionKeyOf(item, group);
    const last = out[out.length - 1];
    if (last && last.key === key) last.items.push(item);
    else out.push({ key, label, items: [item] });
  }
  return out;
}

function sectionKeyOf(
  item: HistoryItem,
  group: GroupBy,
): { key: string; label: string } {
  const history = item.history;
  switch (group) {
    case "date": {
      const createdAt = Number(history.createdAt);
      if (!Number.isFinite(createdAt)) {
        return { key: "unknown", label: i18n.t("更早") };
      }
      return {
        key: `d-${dayKey(createdAt)}`,
        label: dayLabel(createdAt),
      };
    }
    case "model":
      return {
        key: `m-${history.model || "unknown"}`,
        label: history.model || i18n.t("未知模型"),
      };
    case "style":
      return {
        key: `s-${history.style || "none"}`,
        label: history.style || i18n.t("未知风格"),
      };
    case "favorite":
      return history.favorite
        ? { key: "fav-yes", label: i18n.t("已收藏") }
        : { key: "fav-no", label: i18n.t("未收藏") };
    default: {
      const bucket = sizeBucketLabel(history.fileSize ?? 0);
      return { key: `z-${bucket.key}`, label: i18n.t(bucket.label) };
    }
  }
}

/* ============================================================================
   行结构（虚拟化输入）
   ============================================================================ */

export type GalleryRow =
  | { type: "header"; key: string; label: string; count: number }
  | { type: "items"; key: string; items: HistoryItem[] };

export const GROUP_HEADER_HEIGHT = 40;
const GRID_GAP = 12;

export function buildGalleryRows(
  sections: GallerySection[],
  columns: number,
): GalleryRow[] {
  const cols = Math.max(1, Math.floor(columns));
  const rows: GalleryRow[] = [];
  for (const section of sections) {
    if (section.label) {
      rows.push({
        type: "header",
        key: `h-${section.key}`,
        label: section.label,
        count: section.items.length,
      });
    }
    for (let start = 0; start < section.items.length; start += cols) {
      rows.push({
        type: "items",
        key: `i-${section.key}-${start}`,
        items: section.items.slice(start, start + cols),
      });
    }
  }
  return rows;
}

/** 每行高度：图标/平铺由缩略图边长决定，其余按行类型固定 */
export function rowHeightForMode(mode: ViewMode, iconSize: number): number {
  const size = snapIconSize(iconSize);
  switch (mode) {
    case "xlarge":
    case "large":
    case "medium":
    case "small":
      return size + 46;
    case "tiles":
      return size + 64;
    case "list":
      return Math.max(56, rowThumbSize(size) + 24);
    case "details":
      return Math.max(36, rowThumbSize(size) + 12);
    case "content":
      return Math.max(76, rowThumbSize(size) + 44);
    default:
      return 72;
  }
}

export interface GalleryLayout {
  columns: number;
  cellWidth: number;
}

/** 根据容器可用宽度算列数与单元格宽度 */
export function layoutForMode(
  mode: ViewMode,
  availableWidth: number,
  iconSize: number,
): GalleryLayout {
  const width = Math.max(120, availableWidth);
  if (!isIconMode(mode) && mode !== "tiles") {
    return { columns: 1, cellWidth: width };
  }
  const size = snapIconSize(iconSize);
  // 平铺视图需要容纳两行文字，卡片略宽
  const baseCell = mode === "tiles" ? Math.max(176, size + 16) : size + 16;
  const columns = Math.max(
    1,
    Math.floor((width + GRID_GAP) / (baseCell + GRID_GAP)),
  );
  const cellWidth = Math.max(
    baseCell,
    Math.floor((width - GRID_GAP * (columns - 1)) / columns),
  );
  return { columns, cellWidth };
}

/* ============================================================================
   查询与格式化
   ============================================================================ */

export const GALLERY_PAGE_SIZE = 90;
export const SEARCH_DEBOUNCE_MS = 250;

export interface GalleryQueryInput {
  limit?: number;
  cursor?: string | null;
  query?: string;
  model?: string;
  style?: string;
  favoriteOnly?: boolean;
  sort: GallerySort;
  order: SortOrder;
}

/** 组装 list_history 参数：空筛选不传，游标首页为 null */
export function buildHistoryQuery(input: GalleryQueryInput): HistoryQueryArgs {
  const query = input.query?.trim();
  return {
    limit: input.limit ?? GALLERY_PAGE_SIZE,
    cursor: input.cursor ?? null,
    model: input.model || undefined,
    style: input.style || undefined,
    favoriteOnly: input.favoriteOnly || undefined,
    query: query || undefined,
    sort: serverSortFor(input.sort),
    order: serverOrderFor(input.sort, input.order),
  };
}

/** 翻页去重：删除/新增会制造重复 id */
export function appendHistoryItems(
  prev: HistoryItem[],
  page: HistoryItem[],
): HistoryItem[] {
  const seen = new Set(prev.map((item) => item.history.id));
  return [...prev, ...page.filter((item) => !seen.has(item.history.id))];
}

/** 原图字节数：旧数据未回填时为 0，显示「—」 */
export function formatBytes(bytes: number): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

export function formatDimensions(width: number, height: number): string {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return "—";
  if (w <= 0 && h <= 0) return "—";
  return `${w} × ${h}`;
}

export function formatHistoryDate(createdAt: string): string {
  const value = Number(createdAt);
  if (!Number.isFinite(value) || value <= 0) return "—";
  const d = new Date(value * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export function historyType(item: HistoryItem): string {
  return extOf(item.history.filePath).toUpperCase();
}

export interface DetailsColumn {
  key:
    | "name"
    | "date"
    | "type"
    | "size"
    | "dimensions"
    | "model"
    | "style"
    | "favorite";
  label: string;
  sort: GallerySort;
  align: "left" | "right" | "center";
  widthClass: string;
}

export const DETAILS_COLUMNS = [
  {
    key: "name",
    label: "名称",
    sort: "name",
    align: "left",
    widthClass: "min-w-0 flex-1",
  },
  {
    key: "date",
    label: "修改日期",
    sort: "date",
    align: "left",
    widthClass: "w-36 shrink-0",
  },
  {
    key: "type",
    label: "类型",
    sort: "type",
    align: "left",
    widthClass: "w-16 shrink-0",
  },
  {
    key: "size",
    label: "大小",
    sort: "size",
    align: "right",
    widthClass: "w-20 shrink-0",
  },
  {
    key: "dimensions",
    label: "尺寸",
    sort: "dimensions",
    align: "left",
    widthClass: "w-28 shrink-0",
  },
  {
    key: "model",
    label: "模型",
    sort: "model",
    align: "left",
    widthClass: "w-32 shrink-0",
  },
  {
    key: "style",
    label: "风格",
    sort: "style",
    align: "left",
    widthClass: "w-28 shrink-0",
  },
  {
    key: "favorite",
    label: "收藏",
    sort: "favorite",
    align: "center",
    widthClass: "w-14 shrink-0",
  },
] as const satisfies readonly DetailsColumn[];
