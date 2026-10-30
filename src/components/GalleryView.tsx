import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import JSZip from "jszip";
import { api, HistoryItem } from "../lib/api";
import { extOf } from "../lib/image";
import { STYLE_PRESETS } from "../lib/types";
import { dayKey, dayLabel } from "../lib/date";
import { toast } from "../lib/notify";
import SafeImg from "./SafeImg";
import PageHeader from "./PageHeader";
import CompareDialog from "./CompareDialog";
import { useScrollEdge } from "../hooks/useScrollEdge";
import { Button } from "./ui/Button";
import { Select } from "./ui/Select";
import { SegmentedControl } from "./ui/SegmentedControl";
import { useAppStore } from "../stores/appStore";
import { useChatStore } from "../stores/chatStore";
import { usePromptAssetsStore } from "../stores/promptAssetsStore";
import { useCanvasStore } from "../stores/canvasStore";
import { IconGrid } from "./Icons";

const PAGE_SIZE = 90;

function paramsOf(item: HistoryItem) {
  const h = item.history;
  return {
    prompt: h.prompt,
    negativePrompt: h.negativePrompt,
    ratio: "custom" as const,
    width: Number(h.width),
    height: Number(h.height),
    guidance: Number(h.guidance),
    steps: Number(h.steps),
    seed: h.seed !== null ? Number(h.seed) : null,
    style: h.style,
    count: 1,
  };
}

/** 打包导出。返回因缺图被跳过的数量，调用方负责提示与异常处理。
 *  列表只持有缩略图，这里按 id 逐张读取原图，避免把缩略图打包给用户。 */
async function exportZip(items: HistoryItem[]): Promise<number> {
  const zip = new JSZip();
  const manifest: unknown[] = [];
  let skipped = 0;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const h = item.history;
    try {
      const { dataUrl } = await api.getHistoryImage(h.id);
      const b64 = dataUrl.split(",")[1];
      if (!b64) {
        skipped += 1;
        continue;
      }
      const name = `${String(i + 1).padStart(3, "0")}_${h.id}.${extOf(h.filePath)}`;
      zip.file(name, b64, { base64: true });
      manifest.push({ file: name, ...paramsOf(item) });
    } catch {
      skipped += 1;
    }
  }
  zip.file("params.json", JSON.stringify(manifest, null, 2));
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `moling_export_${Date.now()}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return skipped;
}

async function downloadOne(item: HistoryItem, withParams: boolean) {
  const h = item.history;
  const ext = extOf(h.filePath);
  const { dataUrl } = await api.getHistoryImage(h.id);
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = `moling_${h.id}.${ext}`;
  a.click();
  if (withParams) {
    const p = paramsOf(item);
    const blob = new Blob(
      [
        `prompt: ${p.prompt}\nnegative: ${p.negativePrompt}\nmodel: ${h.model}\nseed: ${p.seed}\nsize: ${p.width}x${p.height}\nguidance: ${p.guidance}\nsteps: ${p.steps}\n`,
      ],
      { type: "text/plain" },
    );
    const b = document.createElement("a");
    b.href = URL.createObjectURL(blob);
    b.download = `moling_${h.id}.txt`;
    b.click();
    setTimeout(() => URL.revokeObjectURL(b.href), 1000);
  }
}

/// 画廊栅格：按容器宽度在 2 / 3 / 4 列之间切换，行高由列宽推导（正方形单元）。
const GRID_GAP = 12;
const GRID_PAD = 32; // px-4 两侧
const ROW_EXTRA = 12; // py-1.5 上下
const DAY_HEADER_HEIGHT = 44; // h-11，固定单行，避免 measureElement 破坏滚动稳定性

type Block =
  | { type: "header"; key: string; label: string; count: number }
  | { type: "row"; key: string; items: HistoryItem[] };

export default function GalleryView() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [modelFilter, setModelFilter] = useState("");
  const [styleFilter, setStyleFilter] = useState("");
  const [favOnly, setFavOnly] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [cols, setCols] = useState(3);
  const [rowHeight, setRowHeight] = useState(240);
  const parentRef = useRef<HTMLDivElement>(null);
  const loadSeq = useRef(0);
  useScrollEdge(parentRef);

  const load = useCallback(
    async (offset: number, model: string, style: string, fav: boolean) => {
      const seq = ++loadSeq.current;
      setLoading(true);
      try {
        const { items: page } = await api.listHistory(
          PAGE_SIZE,
          offset,
          model,
          style,
          fav,
        );
        if (seq !== loadSeq.current) return;
        setHasMore(page.length === PAGE_SIZE);
        setItems((prev) => (offset === 0 ? page : [...prev, ...page]));
      } catch {
        // 数据库文件被占用/损坏时不能停在「加载中」且毫无反馈
        if (seq === loadSeq.current) toast("加载画廊失败，请稍后重试", "error");
      } finally {
        if (seq === loadSeq.current) setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load(0, modelFilter, styleFilter, favOnly);
    setSelected(new Set());
  }, [modelFilter, styleFilter, favOnly, load]);

  // 列数由容器宽度决定，行高随之推导 —— 不再写死 grid-cols-3 / h-52
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const update = () => {
      const width = el.clientWidth;
      const nextCols = width >= 1500 ? 4 : width >= 1100 ? 3 : 2;
      const cell = Math.max(
        120,
        (width - GRID_PAD - GRID_GAP * (nextCols - 1)) / nextCols,
      );
      setCols(nextCols);
      setRowHeight(Math.ceil(cell) + GRID_GAP + ROW_EXTRA);
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

  // 时间线：同一天归为一组，组头固定 44px 单行，行仍是等宽栅格
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
      for (let i = 0; i < g.items.length; i += cols) {
        out.push({
          type: "row",
          key: `r-${g.key}-${i}`,
          items: g.items.slice(i, i + cols),
        });
      }
    }
    return out;
  }, [groups, cols]);

  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) =>
      blocks[index]?.type === "header" ? DAY_HEADER_HEIGHT : rowHeight,
    overscan: 4,
  });

  // 列宽/行高变化后让虚拟器丢掉旧估算
  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, cols, virtualizer]);

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

  const doExport = async () => {
    const picked = selectedItems;
    if (picked.length === 0) return;
    setExporting(true);
    try {
      const skipped = await exportZip(picked);
      const ok = picked.length - skipped;
      toast(
        skipped > 0
          ? `已导出 ${ok} 张，${skipped} 张因缺图被跳过`
          : `已导出 ${ok} 张`,
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-base">
      <PageHeader
        title="画廊"
        subtitle={`${items.length} 张作品`}
        footer={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={modelFilter || "all"}
              onValueChange={(v) => setModelFilter(v === "all" ? "" : v)}
              options={[
                { value: "all", label: "全部模型" },
                ...models.map((m) => ({ value: m, label: m })),
              ]}
              label="按模型筛选"
              variant="bare"
              widthClass="w-40"
            />
            <Select
              value={styleFilter || "all"}
              onValueChange={(v) => setStyleFilter(v === "all" ? "" : v)}
              options={[
                { value: "all", label: "全部风格" },
                ...styles.map((s) => ({ value: s.id, label: s.label })),
              ]}
              label="按风格筛选"
              variant="bare"
              widthClass="w-36"
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
            <div className="ml-auto flex items-center gap-2">
              {selectedItems.length === 2 && (
                <Button
                  size="sm"
                  onClick={() => setCompareOpen(true)}
                >{`对比（2）`}</Button>
              )}
              <Button
                size="sm"
                variant="primary"
                disabled={selectedItems.length === 0 || exporting}
                aria-label={`打包导出已选 ${selectedItems.length} 张作品`}
                onClick={() => void doExport()}
              >
                {exporting ? "打包中…" : `打包导出（${selectedItems.length}）`}
              </Button>
              <Button
                size="sm"
                onClick={() => void load(0, modelFilter, styleFilter, favOnly)}
              >
                刷新
              </Button>
            </div>
          </div>
        }
      />

      <div
        ref={parentRef}
        className="scroll-edge min-h-0 flex-1 overflow-y-auto"
      >
        {items.length === 0 && !loading ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-panel bg-fill text-tertiary">
              <IconGrid size={22} strokeWidth={1.4} />
            </span>
            <div className="text-body text-tertiary">
              {favOnly ? "还没有收藏的作品" : "还没有生成记录"}
            </div>
          </div>
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
                  className="absolute left-0 w-full px-4 py-1.5"
                  style={{ transform: `translateY(${vrow.start}px)` }}
                >
                  <div
                    className="grid gap-3"
                    style={{
                      gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                    }}
                  >
                    {block.items.map((item) => (
                      <div
                        key={item.history.id}
                        className="group relative aspect-square overflow-hidden rounded-card bg-sunken"
                      >
                        <SafeImg
                          src={item.thumbUrl}
                          alt={item.history.prompt}
                          className="h-full w-full object-cover"
                          loading="lazy"
                          decoding="async"
                        />
                        <label className="glass-media absolute left-2 top-2 flex h-6 w-6 cursor-pointer items-center justify-center rounded-chip opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 has-[:checked]:opacity-100">
                          <input
                            type="checkbox"
                            aria-label={`选择作品：${item.history.prompt}`}
                            checked={selected.has(item.history.id)}
                            onChange={(e) => {
                              const next = new Set(selected);
                              if (e.target.checked) next.add(item.history.id);
                              else next.delete(item.history.id);
                              setSelected(next);
                            }}
                            className="size-4 cursor-pointer accent-accent-fill"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => void toggleFav(item)}
                          aria-label={
                            item.history.favorite ? "取消收藏" : "收藏该作品"
                          }
                          className="glass-media pressable absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-pill text-footnote text-on-accent hover:bg-on-accent/15"
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
                            <button
                              type="button"
                              onClick={() => reuse(item)}
                              className="pressable rounded-pill px-2.5 py-1 text-footnote text-on-accent hover:bg-on-accent/15"
                            >
                              复用参数
                            </button>
                            <button
                              type="button"
                              onClick={() => void addToCanvas(item)}
                              className="pressable rounded-pill px-2.5 py-1 text-footnote text-on-accent hover:bg-on-accent/15"
                            >
                              加入画布
                            </button>
                            <button
                              type="button"
                              onClick={() => void collectPrompt(item)}
                              className="pressable rounded-pill px-2.5 py-1 text-footnote text-on-accent hover:bg-on-accent/15"
                            >
                              收藏提示词
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                void downloadOne(item, true).catch(() =>
                                  toast("下载失败：原图不可用", "error"),
                                )
                              }
                              className="pressable rounded-pill px-2.5 py-1 text-footnote text-on-accent hover:bg-on-accent/15"
                            >
                              下载
                            </button>
                            <button
                              type="button"
                              onClick={() => void remove(item)}
                              className="pressable rounded-pill px-2.5 py-1 text-footnote text-danger hover:bg-on-accent/15"
                            >
                              删除
                            </button>
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
        {hasMore && !loading && items.length > 0 && (
          <div className="py-3 text-center">
            <Button
              size="sm"
              onClick={() =>
                void load(items.length, modelFilter, styleFilter, favOnly)
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

      <CompareDialog
        open={compareOpen}
        left={selectedItems[0] ?? null}
        right={selectedItems[1] ?? null}
        onClose={() => setCompareOpen(false)}
      />
    </div>
  );
}
