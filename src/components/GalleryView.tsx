import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import JSZip from "jszip";
import { api, HistoryItem } from "../lib/api";
import { useAppStore } from "../stores/appStore";
import { useChatStore } from "../stores/chatStore";

const PAGE_SIZE = 90;
const COLUMNS = 3;

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

async function exportZip(items: HistoryItem[]) {
  const zip = new JSZip();
  const manifest: unknown[] = [];
  items.forEach((item, i) => {
    const h = item.history;
    const ext = h.filePath.split(".").pop() ?? "png";
    const name = `${String(i + 1).padStart(3, "0")}_${h.id}.${ext}`;
    zip.file(name, item.dataUrl.split(",")[1] ?? "", { base64: true });
    manifest.push({ file: name, ...paramsOf(item) });
  });
  zip.file("params.json", JSON.stringify(manifest, null, 2));
  const blob = await zip.generateAsync({ type: "blob" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `moling_export_${Date.now()}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function downloadOne(item: HistoryItem, withParams: boolean) {
  const h = item.history;
  const ext = h.filePath.split(".").pop() ?? "png";
  const a = document.createElement("a");
  a.href = item.dataUrl;
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

export default function GalleryView() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [modelFilter, setModelFilter] = useState("");
  const [favOnly, setFavOnly] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);
  const loadSeq = useRef(0);
  const noticeTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (noticeTimer.current !== null)
        window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  const showNotice = (text: string) => {
    setNotice(text);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2500);
  };

  const load = useCallback(async (offset: number, model: string) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const { items: page } = await api.listHistory(PAGE_SIZE, offset, model);
      if (seq !== loadSeq.current) return;
      setHasMore(page.length === PAGE_SIZE);
      setItems((prev) => (offset === 0 ? page : [...prev, ...page]));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(0, modelFilter);
    setSelected(new Set());
  }, [modelFilter, load]);

  const models = useMemo(
    () =>
      Array.from(new Set(items.map((i) => i.history.model).filter(Boolean))),
    [items],
  );

  const filtered = useMemo(
    () => (favOnly ? items.filter((i) => i.history.favorite) : items),
    [items, favOnly],
  );

  const rows = useMemo(() => {
    const out: HistoryItem[][] = [];
    for (let i = 0; i < filtered.length; i += COLUMNS) {
      out.push(filtered.slice(i, i + COLUMNS));
    }
    return out;
  }, [filtered]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 240,
    overscan: 4,
  });

  const toggleFav = async (item: HistoryItem) => {
    const next = !item.history.favorite;
    try {
      await api.setFavorite(item.history.id, next);
      setItems((prev) =>
        prev.map((i) =>
          i.history.id === item.history.id
            ? { ...i, history: { ...i.history, favorite: next } }
            : i,
        ),
      );
    } catch {
      showNotice("收藏操作失败，请稍后重试");
    }
  };

  const remove = async (item: HistoryItem) => {
    try {
      await api.deleteHistory(item.history.id);
      setItems((prev) => prev.filter((i) => i.history.id !== item.history.id));
    } catch {
      showNotice("删除失败，请稍后重试");
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

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-base">
      <header className="bg-glass z-10 flex h-[52px] shrink-0 items-end justify-between border-b border-theme px-6 pb-2">
        <h1 className="text-[17px] font-semibold tracking-tight text-primary">
          画廊
        </h1>
        <span className="pb-0.5 text-[11px] text-tertiary">
          {filtered.length} 张作品
        </span>
      </header>
      <div className="bg-glass flex shrink-0 flex-wrap items-center gap-2 border-b border-theme px-4 py-2">
        <select
          value={modelFilter}
          onChange={(e) => setModelFilter(e.target.value)}
          className="rounded-[8px] border border-theme bg-transparent px-2 py-1 text-xs"
        >
          <option value="">全部模型</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <label className="flex cursor-pointer items-center gap-1 text-xs text-secondary">
          <input
            type="checkbox"
            checked={favOnly}
            onChange={(e) => setFavOnly(e.target.checked)}
          />
          只看收藏
        </label>
        <div className="ml-auto flex gap-2">
          <button
            onClick={() =>
              exportZip(filtered.filter((i) => selected.has(i.history.id)))
            }
            disabled={selected.size === 0}
            className="pressable rounded-[8px] border border-theme px-2.5 py-1 text-xs disabled:opacity-40"
          >
            打包导出（{selected.size}）
          </button>
          <button
            onClick={() => load(0, modelFilter)}
            className="pressable rounded-[8px] border border-theme px-2.5 py-1 text-xs"
          >
            刷新
          </button>
        </div>
      </div>
      {notice && (
        <div className="shrink-0 border-b border-danger/25 bg-danger/10 px-4 py-1.5 text-xs text-danger">
          {notice}
        </div>
      )}

      <div ref={parentRef} className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 && !loading ? (
          <div className="flex h-full items-center justify-center text-sm text-tertiary">
            还没有生成记录
          </div>
        ) : (
          <div
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((row) => (
              <div
                key={row.key}
                className="absolute left-0 grid w-full grid-cols-3 gap-3 px-4 py-1.5"
                style={{ transform: `translateY(${row.start}px)` }}
              >
                {rows[row.index].map((item) => (
                  <div
                    key={item.history.id}
                    className="group relative h-52 overflow-hidden rounded-lg bg-sunken"
                  >
                    <img
                      src={item.dataUrl}
                      alt={item.history.prompt}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                    <input
                      type="checkbox"
                      checked={selected.has(item.history.id)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(item.history.id);
                        else next.delete(item.history.id);
                        setSelected(next);
                      }}
                      className="absolute left-2 top-2 opacity-0 group-hover:opacity-100"
                    />
                    <button
                      onClick={() => toggleFav(item)}
                      className="absolute right-2 top-2 rounded bg-black/40 px-1.5 py-0.5 text-xs opacity-0 group-hover:opacity-100"
                    >
                      {item.history.favorite ? "★" : "☆"}
                    </button>
                    <div className="absolute inset-x-0 bottom-0 flex justify-center gap-1 bg-gradient-to-t from-black/70 to-transparent p-1.5 text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        onClick={() => reuse(item)}
                        className="rounded bg-white/15 px-2 py-0.5 hover:bg-white/30"
                      >
                        复用参数
                      </button>
                      <button
                        onClick={() => downloadOne(item, true)}
                        className="rounded bg-white/15 px-2 py-0.5 hover:bg-white/30"
                      >
                        下载
                      </button>
                      <button
                        onClick={() => remove(item)}
                        className="rounded bg-white/15 px-2 py-0.5 hover:bg-white/30"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        {hasMore && !loading && items.length > 0 && (
          <div className="py-3 text-center">
            <button
              onClick={() => load(items.length, modelFilter)}
              className="text-xs text-tertiary hover:text-secondary"
            >
              加载更多
            </button>
          </div>
        )}
        {loading && (
          <div className="py-3 text-center text-xs text-tertiary">加载中…</div>
        )}
      </div>
    </div>
  );
}
