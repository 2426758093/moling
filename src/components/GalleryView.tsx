import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api, HistoryItem } from "../lib/api";
import { exportHistoryZip, saveHistoryImage } from "../lib/save";
import { extOf } from "../lib/image";
import { STYLE_PRESETS } from "../lib/types";
import { dayKey, dayLabel } from "../lib/date";
import { toast } from "../lib/notify";
import SafeImg from "./SafeImg";
import PageHeader from "./PageHeader";
import CompareDialog from "./CompareDialog";
import { useScrollEdge } from "../hooks/useScrollEdge";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { EmptyState } from "./ui/EmptyState";
import { Tooltip } from "./ui/Tooltip";
import { Select } from "./ui/Select";
import { SegmentedControl } from "./ui/SegmentedControl";
import { useAppStore } from "../stores/appStore";
import { useChatStore } from "../stores/chatStore";
import { usePromptAssetsStore } from "../stores/promptAssetsStore";
import { useCanvasStore } from "../stores/canvasStore";
import {
  IconQuote,
  IconCanvas,
  IconStar,
  IconDownload,
  IconTrash,
  IconRotate,
  IconClose,
} from "./Icons";

const PAGE_SIZE = 90;

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

async function downloadOne(item: HistoryItem, withParams: boolean) {
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
  if (saved) toast("已保存图片");
}

/// 画廊栅格：按容器宽度在 2 / 3 / 4 列之间切换。每行按图片宽高比做
/// justified 布局 —— 行高由「可用宽度 ÷ 宽高比之和」推导，图片完整显示、不裁切。
const GRID_GAP = 12;
const GRID_PAD = 32; // px-4 两侧
const ROW_MAX_HEIGHT = 420; // 行高上限：避免单张竖图撑满整屏
const DAY_HEADER_HEIGHT = 44; // h-11，固定单行，避免 measureElement 破坏滚动稳定性

type RowItem = { item: HistoryItem; ratio: number };

type Block =
  | { type: "header"; key: string; label: string; count: number }
  | {
      type: "row";
      key: string;
      items: RowItem[];
      height: number;
      totalWidth: number;
    };

/** 宽高比兜底：尺寸缺失或非法时按 1:1 处理，避免除零与 NaN 布局 */
function aspectRatio(item: HistoryItem): number {
  const w = Number(item.history.width);
  const h = Number(item.history.height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 1;
  return w / h;
}

/** 把一组作品切成列数固定的行，并按宽高比求每行高度（含底部间距）。 */
function justifyRows(
  items: HistoryItem[],
  cols: number,
  containerWidth: number,
): Block[] {
  const out: Block[] = [];
  const available = Math.max(
    120,
    containerWidth - GRID_PAD - GRID_GAP * (cols - 1),
  );
  for (let start = 0; start < items.length; start += cols) {
    const slice = items.slice(start, start + cols);
    const row: RowItem[] = slice.map((item) => ({
      item,
      ratio: aspectRatio(item),
    }));
    const ratioSum = row.reduce((sum, r) => sum + r.ratio, 0) || row.length;
    const perRow = Math.max(0, row.length - 1);
    // 末行不满时不拉伸到整行宽度，保持与满行一致的图片尺寸
    const target =
      row.length === cols ? available : (available * row.length) / cols;
    const height = Math.min(
      ROW_MAX_HEIGHT,
      (target - GRID_GAP * perRow) / ratioSum,
    );
    out.push({
      type: "row",
      key: `r-${row[0]?.item.history.id ?? start}`,
      items: row,
      height,
      totalWidth: height * ratioSum + GRID_GAP * perRow,
    });
  }
  return out;
}

export default function GalleryView() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [modelFilter, setModelFilter] = useState("");
  const [styleFilter, setStyleFilter] = useState("");
  const [favOnly, setFavOnly] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [cols, setCols] = useState(3);
  const [containerWidth, setContainerWidth] = useState(960);
  const parentRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Shift 连选的锚点：上一次单独点选的 id
  const anchorRef = useRef<number | null>(null);
  const loadSeq = useRef(0);
  // 下一页游标 = 已加载的最后一条 id；用游标而不是 offset，删除记录后不跳项
  const cursorRef = useRef<number | null>(null);
  const fetchingRef = useRef(false);
  useScrollEdge(parentRef);

  const load = useCallback(
    async (
      beforeId: number | null,
      model: string,
      style: string,
      fav: boolean,
    ) => {
      // 触底回调可能密集触发：同一时刻只允许一个列表请求
      if (fetchingRef.current) return;
      fetchingRef.current = true;
      const seq = ++loadSeq.current;
      setLoading(true);
      setLoadError(false);
      try {
        const { items: page } = await api.listHistory(
          PAGE_SIZE,
          beforeId,
          model,
          style,
          fav,
        );
        if (seq !== loadSeq.current) return;
        setHasMore(page.length === PAGE_SIZE);
        setItems((prev) => {
          if (beforeId === null) return page;
          // 翻页期间新增/删除会让相邻页出现重复 id，按 id 去重
          const seen = new Set(prev.map((i) => i.history.id));
          return [...prev, ...page.filter((i) => !seen.has(i.history.id))];
        });
        const last = page[page.length - 1];
        if (last) cursorRef.current = last.history.id;
      } catch {
        // 失败后停止自动触底，由用户点「重试」；避免无限重试刷屏
        if (seq === loadSeq.current) setLoadError(true);
      } finally {
        if (seq === loadSeq.current) setLoading(false);
        fetchingRef.current = false;
      }
    },
    [],
  );

  const reload = useCallback(() => {
    cursorRef.current = null;
    void load(null, modelFilter, styleFilter, favOnly);
  }, [load, modelFilter, styleFilter, favOnly]);

  useEffect(() => {
    cursorRef.current = null;
    void load(null, modelFilter, styleFilter, favOnly);
    setSelected(new Set());
  }, [modelFilter, styleFilter, favOnly, load]);

  // 列数与行高都由容器宽度决定：最大化后列数不变时，行高会随宽度一起长
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const update = () => {
      const width = el.clientWidth;
      setContainerWidth(width);
      setCols(width >= 1500 ? 4 : width >= 1100 ? 3 : 2);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
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
    for (const s of STYLE_PRESETS) {
      if (s.id) map.set(s.id, s.label);
    }
    for (const item of items) {
      const s = item.history.style;
      if (s && !map.has(s)) map.set(s, s);
    }
    return Array.from(map, ([id, label]) => ({ id, label }));
  }, [items]);

  // 时间线：同一天归为一组，组头固定 44px 单行，组内按宽高比 justified 排布
  const groups = useMemo(() => {
    const out: { key: string; label: string; items: HistoryItem[] }[] = [];
    for (const item of items) {
      const t = Number(item.history.createdAt);
      const key = Number.isFinite(t) ? dayKey(t) : "unknown";
      const last = out[out.length - 1];
      if (last && last.key === key) last.items.push(item);
      else
        out.push({
          key,
          label: Number.isFinite(t) ? dayLabel(t) : "更早",
          items: [item],
        });
    }
    return out;
  }, [items]);

  const blocks = useMemo(() => {
    const out: Block[] = [];
    for (const g of groups) {
      out.push({
        type: "header",
        key: `h-${g.key}`,
        label: g.label,
        count: g.items.length,
      });
      out.push(...justifyRows(g.items, cols, containerWidth));
    }
    return out;
  }, [groups, cols, containerWidth]);

  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      const block = blocks[index];
      if (!block) return 0;
      return block.type === "header"
        ? DAY_HEADER_HEIGHT
        : block.height + GRID_GAP;
    },
    overscan: 4,
  });

  // 列数 / 容器宽度 / 数据变化后让虚拟器丢掉旧估算
  useEffect(() => {
    virtualizer.measure();
  }, [blocks, virtualizer]);

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
      if (favOnly && !next && selected.has(item.history.id)) {
        const nextSel = new Set(selected);
        nextSel.delete(item.history.id);
        setSelected(nextSel);
      }
    } catch {
      toast("收藏操作失败，请稍后重试", "error");
    }
  };

  const remove = async (item: HistoryItem) => {
    try {
      await api.deleteHistory(item.history.id);
      setItems((prev) => prev.filter((i) => i.history.id !== item.history.id));
      if (selected.has(item.history.id)) {
        const nextSel = new Set(selected);
        nextSel.delete(item.history.id);
        setSelected(nextSel);
      }
    } catch {
      toast("删除失败，请稍后重试", "error");
    }
  };

  const selectedItems = useMemo(
    () => items.filter((i) => selected.has(i.history.id)),
    [items, selected],
  );

  /// 单选 / Shift 连选：Shift 以最近一次单独点选为锚，选中区间内的所有作品
  const toggleSelect = (item: HistoryItem, shift: boolean) => {
    const id = item.history.id;
    setSelected((prev) => {
      const next = new Set(prev);
      const anchor = anchorRef.current;
      if (shift && anchor !== null) {
        const from = items.findIndex((i) => i.history.id === anchor);
        const to = items.findIndex((i) => i.history.id === id);
        if (from >= 0 && to >= 0) {
          const [lo, hi] = from < to ? [from, to] : [to, from];
          for (let i = lo; i <= hi; i += 1) next.add(items[i].history.id);
          return next;
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      anchorRef.current = id;
      return next;
    });
  };

  // Esc 清空选择；Ctrl/⌘ A 选中当前已加载的全部作品
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (typing) return;
      if (e.key === "Escape" && selected.size > 0) {
        setSelected(new Set());
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        if (items.length === 0) return;
        e.preventDefault();
        setSelected(new Set(items.map((i) => i.history.id)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, selected.size]);

  // 触底自动续页：哨兵进入视口即加载；按钮作为 IO 不可用时的兜底保留
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loadError) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !loading) {
          void load(cursorRef.current, modelFilter, styleFilter, favOnly);
        }
      },
      { root: parentRef.current, rootMargin: "400px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [
    hasMore,
    loadError,
    loading,
    items.length,
    modelFilter,
    styleFilter,
    favOnly,
    load,
  ]);

  const doExport = async () => {
    const picked = selectedItems;
    if (picked.length === 0) return;
    setExporting(true);
    try {
      const res = await exportZip(picked);
      if (!res) return; // 用户取消保存
      toast(
        res.skipped > 0
          ? `已导出 ${res.saved} 张，${res.skipped} 张因缺图被跳过`
          : `已导出 ${res.saved} 张`,
      );
    } catch {
      toast("打包导出失败，请重试", "error");
    } finally {
      setExporting(false);
    }
  };

  const reuse = (item: HistoryItem) => {
    const p = paramsOf(item);
    const { setPrefs, setView } = useAppStore.getState();
    setPrefs({
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
      toast("该作品没有可收藏的提示词", "error");
      return;
    }
    const res = await usePromptAssetsStore
      .getState()
      .upsertFavorite(prompt, []);
    if (res === "created") toast("已收藏提示词");
    if (res === "updated") toast("该提示词已存在，已更新收藏");
  };

  const addToCanvas = async (item: HistoryItem) => {
    const canvas = useCanvasStore.getState();
    const existed = canvas.nodes.some((n) => n.historyId === item.history.id);
    const nodeId = await canvas.addHistoryNode(item.history.id);
    if (!nodeId) return;
    useAppStore.getState().setView("canvas");
    toast(existed ? "该作品已在画布中" : "已加入画布");
  };

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="画廊"
        subtitle={`${items.length} 张作品`}
        footer={
          <div className="flex flex-wrap items-center gap-1.5">
            <Select
              value={modelFilter || "all"}
              onValueChange={(v) => setModelFilter(v === "all" ? "" : v)}
              options={[
                { value: "all", label: "全部模型" },
                ...models.map((m) => ({ value: m, label: m })),
              ]}
              label="按模型筛选"
              variant="chip"
              widthClass="w-36"
            />
            <Select
              value={styleFilter || "all"}
              onValueChange={(v) => setStyleFilter(v === "all" ? "" : v)}
              options={[
                { value: "all", label: "全部风格" },
                ...styles.map((s) => ({ value: s.id, label: s.label })),
              ]}
              label="按风格筛选"
              variant="chip"
              widthClass="w-32"
            />
            <SegmentedControl
              value={favOnly ? "fav" : "all"}
              onValueChange={(v) => setFavOnly(v === "fav")}
              label="收藏筛选"
              size="sm"
              options={[
                { value: "all", label: "全部" },
                { value: "fav", label: "只看收藏" },
              ]}
            />
            <div className="ml-auto flex items-center gap-1.5">
              <IconButton
                size="sm"
                label="刷新"
                icon={<IconRotate size={14} />}
                onClick={reload}
              />
            </div>
          </div>
        }
      />

      <div
        ref={parentRef}
        className="scroll-edge min-h-0 flex-1 overflow-y-auto"
      >
        {items.length === 0 && !loading ? (
          loadError ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="text-footnote text-secondary">加载画廊失败</p>
              <Button size="sm" variant="ghost" onClick={reload}>
                重试
              </Button>
            </div>
          ) : (
            <EmptyState
              className="h-full"
              eyebrow="画廊"
              title={favOnly ? "还没有收藏的作品" : "还没有生成记录"}
              description={
                favOnly
                  ? "在聊天里生成图片后点星标即可收藏"
                  : "回到聊天描述一个画面，生成结果会自动归档到这里"
              }
            />
          )
        ) : (
          <div
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((vrow) => {
              const block = blocks[vrow.index];
              if (!block) return null;
              if (block.type === "header") {
                return (
                  <div
                    key={vrow.key}
                    className="absolute left-0 flex h-11 w-full items-center justify-between px-4"
                    style={{ transform: `translateY(${vrow.start}px)` }}
                  >
                    <span className="text-footnote font-medium text-secondary">
                      {block.label}
                    </span>
                    <span className="text-caption text-tertiary">
                      {block.count} 张
                    </span>
                  </div>
                );
              }
              return (
                <div
                  key={vrow.key}
                  className="absolute left-0 w-full px-4"
                  style={{
                    transform: `translateY(${vrow.start}px)`,
                    height: block.height + GRID_GAP,
                  }}
                >
                  <div
                    className="flex items-start"
                    style={{ gap: GRID_GAP, height: block.height }}
                  >
                    {block.items.map(({ item, ratio }) => (
                      <div
                        key={item.history.id}
                        className="group relative shrink-0 overflow-hidden rounded-card bg-sunken"
                        style={{
                          width: ratio * block.height,
                          height: block.height,
                        }}
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
                            缩略图生成中
                          </div>
                        )}
                        <label
                          className={`glass-media absolute left-2 top-2 flex h-5 w-5 cursor-pointer items-center justify-center rounded-chip transition-opacity focus-within:opacity-100 group-hover:opacity-100 ${
                            selected.has(item.history.id)
                              ? "opacity-100"
                              : "opacity-0"
                          }`}
                        >
                          <input
                            type="checkbox"
                            aria-label={`选择作品：${item.history.prompt}`}
                            checked={selected.has(item.history.id)}
                            onChange={() => toggleSelect(item, false)}
                            onClick={(e) => {
                              if (e.shiftKey) {
                                e.preventDefault();
                                toggleSelect(item, true);
                              }
                            }}
                            className="size-3.5 cursor-pointer accent-accent-fill"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => void toggleFav(item)}
                          aria-label={
                            item.history.favorite ? "取消收藏" : "收藏该作品"
                          }
                          className="glass-media pressable absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-pill text-caption text-on-accent transition-opacity hover:bg-on-accent/15"
                        >
                          {item.history.favorite ? "★" : "☆"}
                        </button>
                        {item.history.parentId != null && (
                          <span className="glass-media pointer-events-none absolute bottom-2 left-2 rounded-pill px-2 py-0.5 text-caption text-on-accent">
                            派生 #{item.history.parentId}
                          </span>
                        )}
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-2 opacity-0 transition-opacity duration-200 group-focus-within:opacity-100 group-hover:opacity-100">
                          <div className="glass-media pointer-events-auto flex items-center gap-0.5 rounded-pill p-0.5">
                            <Tooltip label="复用参数" side="top">
                              <button
                                type="button"
                                onClick={() => reuse(item)}
                                aria-label="复用参数"
                                className="pressable flex h-7 w-7 items-center justify-center rounded-pill text-on-accent hover:bg-on-accent/15"
                              >
                                <IconQuote size={13} />
                              </button>
                            </Tooltip>
                            <Tooltip label="加入画布" side="top">
                              <button
                                type="button"
                                onClick={() => void addToCanvas(item)}
                                aria-label="加入画布"
                                className="pressable flex h-7 w-7 items-center justify-center rounded-pill text-on-accent hover:bg-on-accent/15"
                              >
                                <IconCanvas size={13} />
                              </button>
                            </Tooltip>
                            <Tooltip label="收藏提示词" side="top">
                              <button
                                type="button"
                                onClick={() => void collectPrompt(item)}
                                aria-label="收藏提示词"
                                className="pressable flex h-7 w-7 items-center justify-center rounded-pill text-on-accent hover:bg-on-accent/15"
                              >
                                <IconStar size={13} />
                              </button>
                            </Tooltip>
                            <Tooltip label="下载原图与参数" side="top">
                              <button
                                type="button"
                                onClick={() =>
                                  void downloadOne(item, true).catch(() =>
                                    toast("下载失败：原图不可用", "error"),
                                  )
                                }
                                aria-label="下载原图与参数"
                                className="pressable flex h-7 w-7 items-center justify-center rounded-pill text-on-accent hover:bg-on-accent/15"
                              >
                                <IconDownload size={13} />
                              </button>
                            </Tooltip>
                            <Tooltip label="删除" side="top">
                              <button
                                type="button"
                                onClick={() => void remove(item)}
                                aria-label="删除"
                                className="pressable flex h-7 w-7 items-center justify-center rounded-pill text-on-accent hover:bg-on-accent/15"
                              >
                                <IconTrash size={13} />
                              </button>
                            </Tooltip>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div ref={sentinelRef} aria-hidden className="h-6 w-full" />
        {loadError && items.length > 0 && (
          <div className="flex flex-col items-center gap-2 py-3 text-center">
            <span className="text-footnote text-secondary">加载更多失败</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void load(cursorRef.current, modelFilter, styleFilter, favOnly)
              }
            >
              重试
            </Button>
          </div>
        )}
        {hasMore && !loading && !loadError && items.length > 0 && (
          <div className="py-3 text-center">
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void load(cursorRef.current, modelFilter, styleFilter, favOnly)
              }
            >
              加载更多
            </Button>
          </div>
        )}
        {loading && (
          <div className="py-3 text-center text-footnote text-tertiary">
            加载中…
          </div>
        )}
      </div>

      {/* 选择工具条：只在有选择时浮出，避免常驻按钮占位 */}
      {selectedItems.length > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-4">
          <div className="glass pointer-events-auto flex items-center gap-1 rounded-pill p-1 pl-3 shadow-sheet">
            <span className="tabular text-footnote text-secondary">
              已选 {selectedItems.length}
            </span>
            {selectedItems.length === 2 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setCompareOpen(true)}
              >
                对比
              </Button>
            )}
            <Button
              size="sm"
              variant="primary"
              disabled={exporting}
              aria-label={`打包导出已选 ${selectedItems.length} 张作品`}
              onClick={() => void doExport()}
            >
              {exporting ? "打包中…" : "导出"}
            </Button>
            <IconButton
              size="sm"
              label="取消选择"
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
    </div>
  );
}
