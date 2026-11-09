import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { toast } from "../lib/notify";
import { useAppStore } from "../stores/appStore";
import {
  CanvasNode,
  clampZoom,
  MAX_ZOOM,
  MIN_ZOOM,
  useCanvasStore,
} from "../stores/canvasStore";
import CanvasNodeCard from "./CanvasNode";
import { IconButton } from "./ui/IconButton";
import { Button } from "./ui/Button";
import { IconCanvas, IconGrid, IconImage, IconMinus, IconPlus } from "./Icons";
import { cn } from "./ui/cn";

const ZOOM_STEP = 1.25;
const FIT_PADDING = 64;

function nodeCenter(node: CanvasNode) {
  return { x: node.x + node.width / 2, y: node.y + node.width / 2 };
}

export default function CanvasBoard({
  wireMode,
  onWireModeChange,
  onAddImage,
}: {
  wireMode: boolean;
  onWireModeChange: (on: boolean) => void;
  onAddImage: () => void;
}) {
  const { t } = useTranslation();
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const viewport = useCanvasStore((s) => s.viewport);
  const thumbs = useCanvasStore((s) => s.thumbs);
  const setViewport = useCanvasStore((s) => s.setViewport);
  const addEdge = useCanvasStore((s) => s.addEdge);
  const removeEdge = useCanvasStore((s) => s.removeEdge);
  const removeNode = useCanvasStore((s) => s.removeNode);

  const containerRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
  } | null>(null);
  const [panning, setPanning] = useState(false);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [wireFrom, setWireFrom] = useState<string | null>(null);
  const wireSource = wireMode ? wireFrom : null;

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const fit = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const current = useCanvasStore.getState().nodes;
    const width = el.clientWidth;
    const height = el.clientHeight;
    if (current.length === 0 || width === 0 || height === 0) {
      setViewport({ x: 0, y: 0, zoom: 1 });
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of current) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.width);
      maxY = Math.max(maxY, n.y + n.width);
    }
    const boxW = Math.max(1, maxX - minX);
    const boxH = Math.max(1, maxY - minY);
    const zoom = clampZoom(
      Math.min(
        (width - FIT_PADDING * 2) / boxW,
        (height - FIT_PADDING * 2) / boxH,
        1.5,
      ),
    );
    setViewport({
      x: (width - boxW * zoom) / 2 - minX * zoom,
      y: (height - boxH * zoom) / 2 - minY * zoom,
      zoom,
    });
  }, [setViewport]);

  // 滚轮以光标为锚缩放：先算光标下的世界坐标，缩放后让它仍停在同一屏幕位置
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const vp = useCanvasStore.getState().viewport;
      const next = clampZoom(vp.zoom * Math.exp(-e.deltaY * 0.0015));
      if (next === vp.zoom) return;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const worldX = (px - vp.x) / vp.zoom;
      const worldY = (py - vp.y) / vp.zoom;
      setViewport({
        x: px - worldX * next,
        y: py - worldY * next,
        zoom: next,
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setViewport]);

  const zoomBy = useCallback(
    (factor: number) => {
      const el = containerRef.current;
      if (!el) return;
      const vp = useCanvasStore.getState().viewport;
      const next = clampZoom(vp.zoom * factor);
      if (next === vp.zoom) return;
      const px = el.clientWidth / 2;
      const py = el.clientHeight / 2;
      const worldX = (px - vp.x) / vp.zoom;
      const worldY = (py - vp.y) / vp.zoom;
      setViewport({ x: px - worldX * next, y: py - worldY * next, zoom: next });
    },
    [setViewport],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        zoomBy(ZOOM_STEP);
        return;
      }
      if (mod && e.key === "-") {
        e.preventDefault();
        zoomBy(1 / ZOOM_STEP);
        return;
      }
      if (mod && e.key === "0") {
        e.preventDefault();
        fit();
        return;
      }
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void useCanvasStore.getState().flush();
        return;
      }
      if (e.key === "Escape") {
        setSelectedNode(null);
        setSelectedEdge(null);
        setWireFrom(null);
        if (wireMode) onWireModeChange(false);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedEdge) {
          e.preventDefault();
          removeEdge(selectedEdge);
          setSelectedEdge(null);
        } else if (selectedNode) {
          e.preventDefault();
          removeNode(selectedNode);
          setSelectedNode(null);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    fit,
    zoomBy,
    selectedNode,
    selectedEdge,
    wireMode,
    onWireModeChange,
    removeNode,
    removeEdge,
  ]);

  const importPasted = useCallback(
    async (dataUrl: string) => {
      try {
        const { historyId } = await api.importImage(dataUrl);
        const id = await useCanvasStore.getState().addHistoryNode(historyId);
        if (id) {
          setSelectedNode(id);
          toast(t("已粘贴图片到画布"));
        }
      } catch {
        toast(t("粘贴失败：图片无法读取"), "error");
      }
    },
    [t],
  );

  // 粘贴剪贴板图片：先入库拿到 historyId，再落到当前视口左上角
  useEffect(() => {
    const readImage = (file: File) =>
      new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });

    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      const item = Array.from(e.clipboardData?.items ?? []).find((entry) =>
        entry.type.startsWith("image/"),
      );
      const file = item?.getAsFile();
      if (!file) return;
      e.preventDefault();
      void readImage(file).then(importPasted);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [importPasted]);

  const pasteFromClipboard = async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (!type) continue;
        const blob = await item.getType(type);
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        await importPasted(dataUrl);
        return;
      }
      toast(t("剪贴板里没有图片"), "error");
    } catch {
      toast(t("无法读取剪贴板，可先复制图片再按 Ctrl V"), "error");
    }
  };

  // 离开画布前落盘：防抖窗口内的最后一次改动不能丢
  useEffect(() => () => void useCanvasStore.getState().flush(), []);

  const pointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    setSelectedNode(null);
    setSelectedEdge(null);
    e.currentTarget.setPointerCapture(e.pointerId);
    const vp = useCanvasStore.getState().viewport;
    panRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      x: vp.x,
      y: vp.y,
    };
    setPanning(true);
  };

  const pointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = panRef.current;
    if (!p || p.pointerId !== e.pointerId) return;
    setViewport({
      x: p.x + (e.clientX - p.startX),
      y: p.y + (e.clientY - p.startY),
      zoom: useCanvasStore.getState().viewport.zoom,
    });
  };

  const pointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (panRef.current?.pointerId !== e.pointerId) return;
    panRef.current = null;
    setPanning(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const selectNode = useCallback((id: string) => {
    setSelectedNode(id);
    setSelectedEdge(null);
  }, []);

  const pickWire = useCallback(
    (id: string) => {
      if (wireFrom == null) {
        setWireFrom(id);
        return;
      }
      if (wireFrom === id) {
        setWireFrom(null);
        return;
      }
      addEdge(wireFrom, id);
      setWireFrom(null);
    },
    [wireFrom, addEdge],
  );

  const gridSize = 24 * viewport.zoom;

  return (
    <div
      ref={containerRef}
      role="application"
      aria-label={t("画布：拖动空白处平移，滚轮缩放")}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerUp}
      className={cn(
        "relative min-h-0 min-w-0 flex-1 touch-none overflow-hidden bg-sunken",
        panning ? "cursor-grabbing" : "cursor-grab",
      )}
      style={{
        backgroundImage:
          "radial-gradient(var(--line-strong) 1px, transparent 1px)",
        backgroundSize: `${gridSize}px ${gridSize}px`,
        backgroundPosition: `${viewport.x}px ${viewport.y}px`,
      }}
    >
      <div
        className="absolute left-0 top-0"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
          transformOrigin: "0 0",
        }}
      >
        <svg
          className="pointer-events-none absolute left-0 top-0 overflow-visible"
          width="1"
          height="1"
          aria-hidden
        >
          {edges.map((edge) => {
            const a = nodeById.get(edge.from);
            const b = nodeById.get(edge.to);
            if (!a || !b) return null;
            const p1 = nodeCenter(a);
            const p2 = nodeCenter(b);
            const active = edge.id === selectedEdge;
            return (
              <g key={edge.id}>
                <line
                  x1={p1.x}
                  y1={p1.y}
                  x2={p2.x}
                  y2={p2.y}
                  stroke="transparent"
                  strokeWidth={18}
                  vectorEffect="non-scaling-stroke"
                  className="pointer-events-auto cursor-pointer"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setSelectedEdge(edge.id);
                    setSelectedNode(null);
                  }}
                />
                <line
                  x1={p1.x}
                  y1={p1.y}
                  x2={p2.x}
                  y2={p2.y}
                  stroke="currentColor"
                  strokeWidth={active ? 2 : 1.4}
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                  className={cn(
                    "pointer-events-none",
                    active ? "text-accent" : "text-tertiary",
                  )}
                />
              </g>
            );
          })}
        </svg>
        {nodes.map((node) => (
          <CanvasNodeCard
            key={node.id}
            node={node}
            thumbUrl={thumbs[node.historyId]}
            selected={selectedNode === node.id}
            wireMode={wireMode}
            wireArmed={wireSource === node.id}
            onSelect={selectNode}
            onWirePick={pickWire}
          />
        ))}
      </div>

      {nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-panel bg-fill text-tertiary">
            <IconCanvas size={22} strokeWidth={1.4} />
          </span>
          <div>
            <div className="text-title3 text-primary">{t("画布还是空的")}</div>
            <p className="mt-1 max-w-72 text-footnote text-quaternary">
              {t(
                "从画廊挑几张作品放进来，拖动排布、滚轮缩放，再从节点进入编辑。",
              )}
            </p>
          </div>
          <div
            className="pointer-events-auto grid w-full max-w-sm grid-cols-3 gap-2"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Button
              size="sm"
              variant="primary"
              icon={<IconPlus size={14} />}
              onClick={onAddImage}
            >
              {t("添加图片")}
            </Button>
            <Button
              size="sm"
              icon={<IconImage size={14} />}
              onClick={() => void pasteFromClipboard()}
            >
              {t("粘贴图片")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<IconGrid size={14} />}
              onClick={() => useAppStore.getState().setView("gallery")}
            >
              {t("去画廊")}
            </Button>
          </div>
        </div>
      )}

      {wireMode && (
        <div className="glass pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-pill px-3 py-1 text-footnote text-secondary">
          {wireSource == null
            ? t("点击起点节点，再点击终点连线 · Esc 退出")
            : t("再点击一个节点完成连线 · Esc 取消")}
        </div>
      )}

      {selectedEdge && (
        <div className="glass pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-pill px-3 py-1 text-footnote text-secondary">
          {t("已选中连线 · 按 Delete 删除")}
        </div>
      )}

      <div
        className="glass absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-pill p-1 shadow-pop"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-pressed={!wireMode}
            onClick={() => onWireModeChange(false)}
            className={`pressable h-7 rounded-pill px-2.5 text-footnote transition-colors ${
              wireMode
                ? "text-secondary hover:bg-hover"
                : "bg-elevated text-primary shadow-card"
            }`}
          >
            {t("浏览")}
          </button>
          <button
            type="button"
            aria-pressed={wireMode}
            disabled={nodes.length < 2}
            onClick={() => onWireModeChange(true)}
            className={`pressable h-7 rounded-pill px-2.5 text-footnote transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              wireMode
                ? "bg-elevated text-primary shadow-card"
                : "text-secondary hover:bg-hover"
            }`}
          >
            {t("连线")}
          </button>
        </div>
        <span className="mx-0.5 h-4 w-px bg-separator" />
        <IconButton
          label={t("缩小")}
          size="sm"
          tooltip={false}
          icon={<IconMinus size={14} />}
          disabled={viewport.zoom <= MIN_ZOOM}
          onClick={() => zoomBy(1 / ZOOM_STEP)}
        />
        <span
          aria-label={t("缩放 {{percent}}%", {
            percent: Math.round(viewport.zoom * 100),
          })}
          className="tabular min-w-12 text-center text-footnote text-secondary"
        >
          {Math.round(viewport.zoom * 100)}%
        </span>
        <IconButton
          label={t("放大")}
          size="sm"
          tooltip={false}
          icon={<IconPlus size={14} />}
          disabled={viewport.zoom >= MAX_ZOOM}
          onClick={() => zoomBy(ZOOM_STEP)}
        />
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-footnote"
          onClick={fit}
        >
          {t("适应")}
        </Button>
      </div>
    </div>
  );
}
