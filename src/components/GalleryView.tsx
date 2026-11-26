import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api } from "../lib/api";
import type { HistoryItem } from "../lib/api";
import { exportHistoryZip, saveHistoryImage } from "../lib/save";
import { extOf } from "../lib/image";
import { HISTORY_CHANGED_EVENT } from "../lib/historyEvents";
import { toast } from "../lib/notify";
import {
  DEFAULT_ICON_SIZE,
  DEFAULT_PREFS,
  GALLERY_PAGE_SIZE,
  GALLERY_PREFS_KEY,
  GROUP_HEADER_HEIGHT,
  SEARCH_DEBOUNCE_MS,
  appendHistoryItems,
  buildGalleryRows,
  buildHistoryQuery,
  defaultIconSizeForMode,
  groupHistoryItems,
  iconModeForSize,
  isIconMode,
  layoutForMode,
  nextSortState,
  parseGalleryPrefs,
  rowHeightForMode,
  rowThumbSize,
  serializeGalleryPrefs,
  snapIconSize,
  zoomIconSize,
  type GalleryRow,
  type GallerySort,
  type GalleryPrefs,
  type GroupBy,
  type ViewMode,
} from "../lib/galleryView";
import type { SortOrder } from "../lib/api";
import PageHeader from "./PageHeader";
import CompareDialog from "./CompareDialog";
import ImageViewer, { ViewerImage } from "./ImageViewer";
import { useScrollEdge } from "../hooks/useScrollEdge";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { EmptyState } from "./ui/EmptyState";
import { useAppStore } from "../stores/appStore";
import { useChatStore } from "../stores/chatStore";
import { useStylePresets } from "../stores/stylePresetStore";
import { usePromptAssetsStore } from "../stores/promptAssetsStore";
import { useCanvasStore } from "../stores/canvasStore";
import { IconClose } from "./Icons";
import { GalleryToolbar } from "./gallery/GalleryToolbar";
import { GalleryStatusBar } from "./gallery/GalleryStatusBar";
import { GalleryDetailsPane } from "./gallery/GalleryDetailsPane";
import { GalleryGrid } from "./gallery/GalleryGrid";
import { GalleryTiles } from "./gallery/GalleryTiles";
import { GalleryList } from "./gallery/GalleryList";
import {
  GalleryDetailsHeader,
  GalleryDetailsRow,
} from "./gallery/GalleryDetailsTable";
import { GalleryContent } from "./gallery/GalleryContent";
import type { GalleryActions } from "./gallery/types";

function paramsOf(item: HistoryItem) {
  const h = item.history;
  const auto = Number(h.width) === 0 && Number(h.height) === 0;
  return {
    prompt: h.prompt,
    negativePrompt: h.negativePrompt,
    ratio: auto ? ("auto" as const) : ("custom" as const),
    width: Number(h.width),
    height: Number(h.height),
    guidance: Number(h.guidance),
    steps: Number(h.steps),
    seed: h.seed !== null ? Number(h.seed) : null,
    style: h.style,
    count: 1,
  };
}

/** 打包导出：zip 在 Rust 侧生成（列表只持有缩略图，按 id 读原图）。
 *  null 表示用户取消保存。 */
async function exportZip(
  items: HistoryItem[],
): Promise<{ saved: number; skipped: number } | null> {
  const entries = items.map((item) => ({
    historyId: item.history.id,
    params: paramsOf(item) as Record<string, unknown>,
  }));
  return exportHistoryZip(entries, `moling_export_${Date.now()}.zip`);
}

async function downloadOne(
  item: HistoryItem,
  withParams: boolean,
  savedToast: string,
) {
  const h = item.history;
  const ext = extOf(h.filePath);
  const p = paramsOf(item);
  const paramsText = withParams
    ? `prompt: ${p.prompt}\nnegative: ${p.negativePrompt}\nmodel: ${h.model}\nseed: ${p.seed}\nsize: ${p.ratio === "auto" ? "auto" : `${p.width}x${p.height}`}\nguidance: ${p.guidance}\nsteps: ${p.steps}\n`
    : undefined;
  const saved = await saveHistoryImage(
    h.id,
    `moling_${h.id}.${ext}`,
    paramsText,
  );
  if (saved) toast(savedToast);
}

function readPrefs(): GalleryPrefs {
  try {
    return parseGalleryPrefs(localStorage.getItem(GALLERY_PREFS_KEY));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable
  );
}

export default function GalleryView() {
  const { t } = useTranslation();
  const openAnimation = useAppStore((s) => s.openAnimation);
  const stylePresets = useStylePresets();

  const [prefs, setPrefs] = useState<GalleryPrefs>(readPrefs);
  const { mode, iconSize, sort, order, group, detailsPane } = prefs;

  const [items, setItems] = useState<HistoryItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [modelFilter, setModelFilter] = useState("");
  const [styleFilter, setStyleFilter] = useState("");
  const [favOnly, setFavOnly] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [activeId, setActiveId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [containerWidth, setContainerWidth] = useState(960);
  const [wide, setWide] = useState(true);
  const [viewer, setViewer] = useState<ViewerImage | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const parentRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Shift 连选的锚点：上一次单独点选的 id
  const anchorRef = useRef<number | null>(null);
  const loadSeq = useRef(0);
  // 下一页游标由后端返回；首页为 null
  const cursorRef = useRef<string | null>(null);
  const fetchingRef = useRef(false);
  useScrollEdge(parentRef);

  useEffect(() => {
    try {
      localStorage.setItem(GALLERY_PREFS_KEY, serializeGalleryPrefs(prefs));
    } catch {
      // 隐私模式写不进去不影响当前会话
    }
  }, [prefs]);

  // 搜索 250ms 防抖：输入过程中不打断列表
  useEffect(() => {
    const timer = window.setTimeout(
      () => setQuery(searchText.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [searchText]);

  const load = useCallback(
    async (cursor: string | null) => {
      // 翻页请求同一时刻只允许一个；筛选/搜索触发的首页请求可以抢占旧请求
      if (cursor !== null && fetchingRef.current) return;
      fetchingRef.current = true;
      const seq = ++loadSeq.current;
      setLoading(true);
      setLoadError(false);
      try {
        const page = await api.listHistory(
          buildHistoryQuery({
            limit: GALLERY_PAGE_SIZE,
            cursor,
            query,
            model: modelFilter,
            style: styleFilter,
            favoriteOnly: favOnly,
            sort,
            order,
          }),
        );
        if (seq !== loadSeq.current) return;
        const pageItems = page?.items ?? [];
        setHasMore(page?.hasMore ?? false);
        cursorRef.current = page?.nextCursor ?? null;
        setItems((prev) =>
          cursor === null ? pageItems : appendHistoryItems(prev, pageItems),
        );
      } catch {
        // 失败后停止自动触底，由用户点「重试」；避免无限重试刷屏
        if (seq === loadSeq.current) setLoadError(true);
      } finally {
        if (seq === loadSeq.current) {
          setLoading(false);
          fetchingRef.current = false;
        }
      }
    },
    [query, modelFilter, styleFilter, favOnly, sort, order],
  );

  const reload = useCallback(() => {
    cursorRef.current = null;
    void load(null);
  }, [load]);

  // 筛选 / 搜索 / 排序变化：清空列表与选择，从首页重新拉
  useEffect(() => {
    cursorRef.current = null;
    setItems([]);
    setSelected(new Set());
    setActiveId(null);
    void load(null);
  }, [load]);

  // 编辑器 / 动图导出等常驻在画廊之上：新记录落库后重载列表
  useEffect(() => {
    window.addEventListener(HISTORY_CHANGED_EVENT, reload);
    return () => window.removeEventListener(HISTORY_CHANGED_EVENT, reload);
  }, [reload]);

  // 容器宽度决定列数；根宽度决定详情窗格是否可用
  useEffect(() => {
    const el = parentRef.current;
    const root = rootRef.current;
    if (!el || !root) return;
    const update = () => {
      setContainerWidth(el.clientWidth);
      setWide(root.clientWidth >= 980);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const models = useMemo(
    () =>
      Array.from(new Set(items.map((i) => i.history.model).filter(Boolean))),
    [items],
  );

  // 风格选项：预设 + 当前已加载数据里出现的未知风格（筛选由后端执行）
  const styles = useMemo(() => {
    const map = new Map<string, string>();
    for (const preset of stylePresets) {
      if (preset.prompt) map.set(preset.prompt, preset.label);
    }
    for (const item of items) {
      const style = item.history.style;
      if (style && !map.has(style)) map.set(style, style);
    }
    return Array.from(map, ([id, label]) => ({ id, label }));
  }, [items, stylePresets]);

  // 服务端排序 + 前端补齐类型/风格；分组按排序流切片
  // 服务端已按 sort/order 全局排序；这里不再二次排序，避免中文 collation 与 SQL 不一致
  const displayItems = items;

  const availableWidth = Math.max(120, containerWidth - 32);
  const layout = useMemo(
    () => layoutForMode(mode, availableWidth, iconSize),
    [mode, availableWidth, iconSize],
  );

  const sections = useMemo(
    () => groupHistoryItems(displayItems, group),
    [displayItems, group],
  );

  const rows = useMemo(
    () => buildGalleryRows(sections, layout.columns),
    [sections, layout.columns],
  );

  const itemRowHeight = rowHeightForMode(mode, iconSize);
  const thumbSize = rowThumbSize(iconSize);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) =>
      rows[index]?.type === "header" ? GROUP_HEADER_HEIGHT : itemRowHeight,
    overscan: 6,
  });

  // 模式 / 缩放 / 列数 / 数据变化后让虚拟器丢掉旧估算
  useEffect(() => {
    virtualizer.measure();
  }, [rows, itemRowHeight, layout.columns, virtualizer]);

  const selectedItems = useMemo(
    () => displayItems.filter((item) => selected.has(item.history.id)),
    [displayItems, selected],
  );

  const activeItem = useMemo(
    () =>
      displayItems.find((item) => item.history.id === activeId) ??
      selectedItems[0] ??
      null,
    [displayItems, activeId, selectedItems],
  );

  const changePrefs = useCallback((patch: Partial<GalleryPrefs>) => {
    setPrefs((prev) => ({ ...prev, ...patch }));
  }, []);

  const changeMode = useCallback((next: ViewMode) => {
    setPrefs((prev) => ({
      ...prev,
      mode: next,
      iconSize: defaultIconSizeForMode(next),
    }));
  }, []);

  const changeIconSize = useCallback((value: number) => {
    setPrefs((prev) => {
      const next = snapIconSize(value);
      return {
        ...prev,
        iconSize: next,
        mode: isIconMode(prev.mode) ? iconModeForSize(next) : prev.mode,
      };
    });
  }, []);

  const changeSort = useCallback((next: GallerySort) => {
    setPrefs((prev) => {
      const state = nextSortState(next, prev.sort, prev.order);
      return { ...prev, sort: state.sort, order: state.order };
    });
  }, []);

  // Ctrl + 滚轮缩放；输入框聚焦时不拦截
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) {
        return;
      }
      e.preventDefault();
      setPrefs((prev) => {
        const next = zoomIconSize(prev.iconSize, e.deltaY < 0 ? 1 : -1);
        return {
          ...prev,
          iconSize: next,
          mode: isIconMode(prev.mode) ? iconModeForSize(next) : prev.mode,
        };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  /// 单选 / Shift 区间 / Ctrl 追加
  const toggleSelect = useCallback(
    (item: HistoryItem, shift: boolean, additive: boolean) => {
      const id = item.history.id;
      setActiveId(id);
      setSelected((prev) => {
        const next = new Set(prev);
        const anchor = anchorRef.current;
        if (shift && anchor !== null) {
          const from = displayItems.findIndex((i) => i.history.id === anchor);
          const to = displayItems.findIndex((i) => i.history.id === id);
          if (from >= 0 && to >= 0) {
            const [lo, hi] = from < to ? [from, to] : [to, from];
            for (let i = lo; i <= hi; i += 1) {
              next.add(displayItems[i].history.id);
            }
            return next;
          }
        }
        if (additive) {
          if (next.has(id)) next.delete(id);
          else next.add(id);
          anchorRef.current = id;
          return next;
        }
        if (next.has(id) && next.size === 1) {
          next.delete(id);
          return next;
        }
        anchorRef.current = id;
        return new Set([id]);
      });
    },
    [displayItems],
  );

  // Esc 清空选择；Ctrl/⌘ A 全选；Ctrl+0 复位缩放
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "0") {
        e.preventDefault();
        setPrefs((prev) => ({
          ...prev,
          iconSize: DEFAULT_ICON_SIZE,
          mode: isIconMode(prev.mode) ? "large" : prev.mode,
        }));
        return;
      }
      if (e.key === "Escape" && selected.size > 0) {
        setSelected(new Set());
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        if (displayItems.length === 0) return;
        e.preventDefault();
        setSelected(new Set(displayItems.map((i) => i.history.id)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [displayItems, selected.size]);

  const toggleFav = async (item: HistoryItem) => {
    const next = !item.history.favorite;
    try {
      await api.setFavorite(item.history.id, next);
      setItems((prev) =>
        favOnly && !next
          ? prev.filter((i) => i.history.id !== item.history.id)
          : prev.map((i) =>
              i.history.id === item.history.id
                ? { ...i, history: { ...i.history, favorite: next } }
                : i,
            ),
      );
      if (favOnly && !next) {
        setSelected((prev) => {
          if (!prev.has(item.history.id)) return prev;
          const copy = new Set(prev);
          copy.delete(item.history.id);
          return copy;
        });
        if (activeId === item.history.id) setActiveId(null);
      }
    } catch {
      toast(t("收藏操作失败，请稍后重试"), "error");
    }
  };

  const remove = async (item: HistoryItem) => {
    try {
      await api.deleteHistory(item.history.id);
      setItems((prev) => prev.filter((i) => i.history.id !== item.history.id));
      setSelected((prev) => {
        if (!prev.has(item.history.id)) return prev;
        const copy = new Set(prev);
        copy.delete(item.history.id);
        return copy;
      });
      if (activeId === item.history.id) setActiveId(null);
    } catch {
      toast(t("删除失败，请稍后重试"), "error");
    }
  };

  const reuse = (item: HistoryItem) => {
    const p = paramsOf(item);
    const { setPrefs: setAppPrefs, setView } = useAppStore.getState();
    setAppPrefs({
      ratio: p.ratio,
      width: p.width,
      height: p.height,
      style: p.style,
      count: 1,
      negativePrompt: p.negativePrompt,
    });
    useChatStore.getState().setDraftPrompt(p.prompt);
    setView("chat");
  };

  const collectPrompt = async (item: HistoryItem) => {
    const prompt = item.history.prompt.trim();
    if (!prompt) {
      toast(t("该作品没有可收藏的提示词"), "error");
      return;
    }
    const res = await usePromptAssetsStore
      .getState()
      .upsertFavorite(prompt, []);
    if (res === "created") toast(t("已收藏提示词"));
    if (res === "updated") toast(t("该提示词已存在，已更新收藏"));
  };

  const addToCanvas = async (item: HistoryItem) => {
    const canvas = useCanvasStore.getState();
    const existed = canvas.nodes.some((n) => n.historyId === item.history.id);
    const nodeId = await canvas.addHistoryNode(item.history.id);
    if (!nodeId) return;
    useAppStore.getState().setView("canvas");
    toast(existed ? t("该作品已在画布中") : t("已加入画布"));
  };

  /// 修图：列表里只有缩略图，必须按 id 读原图再进台（同一张图可继续叠加步骤）
  const retouchOne = async (item: HistoryItem) => {
    try {
      const img = await api.getHistoryImage(item.history.id);
      const width = Number(item.history.width);
      const height = Number(item.history.height);
      useAppStore.getState().openRetouch({
        dataUrl: img.dataUrl,
        historyId: item.history.id,
        ...(width > 0 && height > 0 ? { width, height } : {}),
        title: item.history.prompt,
        returnView: "gallery",
      });
    } catch (e) {
      toast(t("图片不可用：{{error}}", { error: String(e) }), "error");
    }
  };

  const openViewer = async (item: HistoryItem) => {
    try {
      const img = await api.getHistoryImage(item.history.id);
      setViewer({
        dataUrl: img.dataUrl,
        title: item.history.prompt,
        prompt: item.history.prompt,
        historyId: item.history.id,
      });
    } catch (e) {
      toast(t("图片不可用：{{error}}", { error: String(e) }), "error");
    }
  };

  const download = (item: HistoryItem) => {
    void downloadOne(item, true, t("已保存图片")).catch(() =>
      toast(t("下载失败：原图不可用"), "error"),
    );
  };

  const actions: GalleryActions = {
    select: toggleSelect,
    open: (item) => void openViewer(item),
    toggleFavorite: (item) => void toggleFav(item),
    retouch: (item) => void retouchOne(item),
    reuse,
    addToCanvas: (item) => void addToCanvas(item),
    collectPrompt: (item) => void collectPrompt(item),
    download,
    remove: (item) => void remove(item),
    openAnimation: (item) => openAnimation({ historyId: item.history.id }),
  };

  const doExport = async () => {
    const picked = selectedItems;
    if (picked.length === 0) return;
    setExporting(true);
    try {
      const res = await exportZip(picked);
      if (!res) return; // 用户取消保存
      toast(
        res.skipped > 0
          ? t("已导出 {{saved}} 张，{{skipped}} 张因缺图被跳过", {
              saved: res.saved,
              skipped: res.skipped,
            })
          : t("已导出 {{n}} 张", { n: res.saved }),
      );
    } catch {
      toast(t("打包导出失败，请重试"), "error");
    } finally {
      setExporting(false);
    }
  };

  // 触底自动续页：哨兵进入视口即加载；按钮作为 IO 不可用时的兜底保留
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loadError) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !loading) {
          void load(cursorRef.current);
        }
      },
      { root: parentRef.current, rootMargin: "400px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loadError, loading, items.length, load]);

  const renderItemRow = (row: Extract<GalleryRow, { type: "items" }>) => {
    switch (mode) {
      case "xlarge":
      case "large":
      case "medium":
      case "small":
        return (
          <GalleryGrid
            items={row.items}
            iconSize={iconSize}
            cellWidth={layout.cellWidth}
            selected={selected}
            actions={actions}
          />
        );
      case "tiles":
        return (
          <GalleryTiles
            items={row.items}
            iconSize={iconSize}
            cellWidth={layout.cellWidth}
            selected={selected}
            actions={actions}
          />
        );
      case "list":
        return (
          <GalleryList
            item={row.items[0]}
            thumbSize={thumbSize}
            selected={selected.has(row.items[0].history.id)}
            actions={actions}
          />
        );
      case "details":
        return (
          <GalleryDetailsRow
            item={row.items[0]}
            thumbSize={thumbSize}
            selected={selected.has(row.items[0].history.id)}
            actions={actions}
          />
        );
      default:
        return (
          <GalleryContent
            item={row.items[0]}
            thumbSize={thumbSize}
            selected={selected.has(row.items[0].history.id)}
            actions={actions}
          />
        );
    }
  };

  const showDetails = detailsPane && wide;

  return (
    <div
      ref={rootRef}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <PageHeader
        title={t("作品")}
        actions={
          <span className="tabular text-footnote text-tertiary">
            {t("{{n}} 张作品", { n: displayItems.length })}
          </span>
        }
        footer={
          <GalleryToolbar
            mode={mode}
            sort={sort}
            order={order}
            group={group}
            detailsPane={detailsPane}
            searchText={searchText}
            modelFilter={modelFilter}
            models={models}
            styleFilter={styleFilter}
            styles={styles}
            favOnly={favOnly}
            onSearchChange={setSearchText}
            onModeChange={changeMode}
            onSortChange={changeSort}
            onOrderChange={(next: SortOrder) => changePrefs({ order: next })}
            onGroupChange={(next: GroupBy) => changePrefs({ group: next })}
            onToggleDetails={() => changePrefs({ detailsPane: !detailsPane })}
            onModelChange={setModelFilter}
            onStyleChange={setStyleFilter}
            onFavOnlyChange={setFavOnly}
            onRefresh={reload}
          />
        }
      />

      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-h-0 flex-1 flex-col">
          {mode === "details" && displayItems.length > 0 && (
            <GalleryDetailsHeader
              sort={sort}
              order={order}
              onSort={changeSort}
            />
          )}
          <div
            ref={parentRef}
            className="scroll-edge min-h-0 flex-1 overflow-y-auto"
          >
            {displayItems.length === 0 && !loading ? (
              loadError ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                  <p className="text-footnote text-secondary">
                    {t("加载画廊失败")}
                  </p>
                  <Button size="sm" variant="ghost" onClick={reload}>
                    {t("重试")}
                  </Button>
                </div>
              ) : (
                <EmptyState
                  className="h-full"
                  eyebrow={t("作品")}
                  title={
                    query
                      ? t("没有匹配的作品")
                      : favOnly
                        ? t("还没有收藏的作品")
                        : t("还没有生成记录")
                  }
                  description={
                    query
                      ? t("试试其他关键词或清除筛选")
                      : favOnly
                        ? t("在聊天里生成图片后点星标即可收藏")
                        : t("回到聊天描述一个画面，生成结果会自动归档到这里")
                  }
                />
              )
            ) : displayItems.length === 0 && loading ? (
              <div className="py-10 text-center text-footnote text-tertiary">
                {t("加载中…")}
              </div>
            ) : (
              <div
                className="relative w-full"
                style={{ height: virtualizer.getTotalSize() }}
              >
                {virtualizer.getVirtualItems().map((vrow) => {
                  const row = rows[vrow.index];
                  if (!row) return null;
                  if (row.type === "header") {
                    return (
                      <div
                        key={vrow.key}
                        className="absolute left-0 flex h-10 w-full items-center gap-3 px-4 pt-2"
                        style={{ transform: `translateY(${vrow.start}px)` }}
                      >
                        <span className="shrink-0 font-kai text-callout text-secondary">
                          {row.label}
                        </span>
                        <span aria-hidden className="h-px flex-1 bg-line" />
                        <span className="shrink-0 text-caption text-quaternary">
                          {t("{{n}} 张", { n: row.count })}
                        </span>
                      </div>
                    );
                  }
                  return (
                    <div
                      key={vrow.key}
                      className="absolute left-0 w-full"
                      style={{
                        transform: `translateY(${vrow.start}px)`,
                        height: vrow.size,
                      }}
                    >
                      {renderItemRow(row)}
                    </div>
                  );
                })}
              </div>
            )}
            <div ref={sentinelRef} aria-hidden className="h-6 w-full" />
            {loadError && items.length > 0 && (
              <div className="flex flex-col items-center gap-2 py-3 text-center">
                <span className="text-footnote text-secondary">
                  {t("加载更多失败")}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void load(cursorRef.current)}
                >
                  {t("重试")}
                </Button>
              </div>
            )}
            {hasMore && !loading && !loadError && items.length > 0 && (
              <div className="py-3 text-center">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void load(cursorRef.current)}
                >
                  {t("加载更多")}
                </Button>
              </div>
            )}
            {loading && (
              <div className="py-3 text-center text-footnote text-tertiary">
                {t("加载中…")}
              </div>
            )}
          </div>
        </div>

        {showDetails && (
          <GalleryDetailsPane
            item={activeItem}
            actions={actions}
            onClose={() => changePrefs({ detailsPane: false })}
          />
        )}
      </div>

      <GalleryStatusBar
        total={displayItems.length}
        selectedCount={selectedItems.length}
        iconSize={iconSize}
        mode={mode}
        onIconSizeChange={changeIconSize}
      />

      {/* 选择工具条：只在有选择时浮出，避免常驻按钮占位 */}
      {selectedItems.length > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-12 z-20 flex justify-center px-4">
          <div className="pointer-events-auto flex items-center gap-1 rounded-pill border border-line bg-elevated p-1 pl-3 shadow-sheet">
            <span className="tabular text-footnote text-secondary">
              {t("已选 {{n}}", { n: selectedItems.length })}
            </span>
            {selectedItems.length === 2 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setCompareOpen(true)}
              >
                {t("对比")}
              </Button>
            )}
            <Button
              size="sm"
              variant="primary"
              disabled={exporting}
              aria-label={t("打包导出已选 {{n}} 张作品", {
                n: selectedItems.length,
              })}
              onClick={() => void doExport()}
            >
              {exporting ? t("打包中…") : t("导出")}
            </Button>
            <IconButton
              size="sm"
              label={t("取消选择")}
              icon={<IconClose size={13} />}
              onClick={() => setSelected(new Set())}
            />
          </div>
        </div>
      )}

      <CompareDialog
        open={compareOpen}
        left={selectedItems[0] ?? null}
        right={selectedItems[1] ?? null}
        onClose={() => setCompareOpen(false)}
      />

      {viewer &&
        createPortal(
          <ImageViewer
            images={[viewer]}
            index={0}
            onIndexChange={() => {}}
            onClose={() => setViewer(null)}
          />,
          document.body,
        )}
    </div>
  );
}
