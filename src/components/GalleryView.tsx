import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import JSZip from "jszip";
import { api, HistoryItem } from "../lib/api";
import { extOf } from "../lib/image";
import { STYLE_PRESETS } from "../lib/types";
import SafeImg from "./SafeImg";
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

export default function GalleryView() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [modelFilter, setModelFilter] = useState("");
  const [styleFilter, setStyleFilter] = useState("");
  const [favOnly, setFavOnly] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
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

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2500);
  }, []);

  const load = useCallback(
    async (offset: number, model: string, style: string) => {
      const seq = ++loadSeq.current;
      setLoading(true);
      try {
        const { items: page } = await api.listHistory(
          PAGE_SIZE,
          offset,
          model,
          style,
        );
        if (seq !== loadSeq.current) return;
        setHasMore(page.length === PAGE_SIZE);
        setItems((prev) => (offset === 0 ? page : [...prev, ...page]));
      } catch {
        // 原实现没有 catch：数据库文件被占用/损坏时是一条未捕获的 rejection，
        // 界面停在「加载中」且没有任何反馈。
        if (seq === loadSeq.current) showNotice("加载画廊失败，请稍后重试");
      } finally {
        if (seq === loadSeq.current) setLoading(false);
      }
    },
    [showNotice],
  );

  useEffect(() => {
    load(0, modelFilter, styleFilter);
    setSelected(new Set());
  }, [modelFilter, styleFilter, load]);

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

  const doExport = async () => {
    const picked = filtered.filter((i) => selected.has(i.history.id));
    if (picked.length === 0) return;
    setExporting(true);
    try {
      const skipped = await exportZip(picked);
      const ok = picked.length - skipped;
      showNotice(
        skipped > 0
          ? `已导出 ${ok} 张，${skipped} 张因缺图被跳过`
          : `已导出 ${ok} 张`,
      );
    } catch {
      showNotice("打包导出失败，请重试");
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
          aria-label="按模型筛选"
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
        <select
          value={styleFilter}
          aria-label="按风格筛选"
          onChange={(e) => setStyleFilter(e.target.value)}
          className="rounded-[8px] border border-theme bg-transparent px-2 py-1 text-xs"
        >
          <option value="">全部风格</option>
          {styles.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
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
            onClick={doExport}
            disabled={selected.size === 0 || exporting}
            aria-label={`打包导出已选 ${selected.size} 张作品`}
            className="pressable rounded-[8px] border border-theme px-2.5 py-1 text-xs disabled:opacity-40"
          >
            {exporting ? "打包中…" : `打包导出（${selected.size}）`}
          </button>
          <button
            onClick={() => load(0, modelFilter, styleFilter)}
            aria-label="刷新画廊"
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
                    <SafeImg
                      src={item.thumbUrl}
                      alt={item.history.prompt}
                      className="h-full w-full object-cover"
                      loading="lazy"
                      decoding="async"
                    />
                    <input
                      type="checkbox"
                      aria-label="选择该作品"
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
                      aria-label={item.history.favorite ? "取消收藏" : "收藏"}
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
                        onClick={() =>
                          void downloadOne(item, true).catch(() =>
                            showNotice("下载失败：原图不可用"),
                          )
                        }
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
              onClick={() => load(items.length, modelFilter, styleFilter)}
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
