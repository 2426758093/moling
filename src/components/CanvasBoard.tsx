import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { IconCanvas, IconMinus, IconPlus } from "./Icons";
import { cn } from "./ui/cn";

const ZOOM_STEP = 1.25;
const FIT_PADDING = 64;

function nodeCenter(node: CanvasNode) {
  return { x: node.x + node.width / 2, y: node.y + node.width / 2 };
}

export default function CanvasBoard({
  wireMode,
  onWireModeChange,
  fitSignal,
  onAddImage,
}: {
  wireMode: boolean;
  onWireModeChange: (on: boolean) => void;
  /** 每次递增触发一次「适应视图」 */
  fitSignal: number;
  onAddImage: () => void;
}) {
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

  useEffect(() => {
    if (fitSignal > 0) fit();
  }, [fitSignal, fit]);

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
    selectedNode,
    selectedEdge,
    wireMode,
    onWireModeChange,
    removeNode,
    removeEdge,
  ]);

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

  const zoomBy = (factor: number) => {
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
      aria-label="画布：拖动空白处平移，滚轮缩放"
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerUp}
      className={cn(
        "relative min-h-0 flex-1 touch-none overflow-hidden bg-sunken",
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
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-panel bg-fill text-tertiary">
            <IconCanvas size={22} strokeWidth={1.4} />
          </span>
          <div className="text-body text-tertiary">画布还是空的</div>
          <p className="max-w-72 text-footnote text-quaternary">
            从画廊挑几张作品放进来，拖动排布、滚轮缩放，再从节点进入编辑。
          </p>
          <Button
            size="sm"
            variant="primary"
            icon={<IconPlus size={14} />}
            className="pointer-events-auto"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onAddImage}
          >
            添加图片
          </Button>
        </div>
      )}

      {wireMode && (
        <div className="glass pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-pill px-3 py-1 text-footnote text-secondary">
          {wireSource == null
            ? "点击起点节点，再点击终点连线 · Esc 退出"
            : "再点击一个节点完成连线 · Esc 取消"}
        </div>
      )}

      {selectedEdge && (
        <div className="glass pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-pill px-3 py-1 text-footnote text-secondary">
          已选中连线 · 按 Delete 删除
        </div>
      )}

      <div
        className="glass absolute bottom-4 right-4 flex items-center gap-0.5 rounded-pill p-0.5"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <IconButton
          label="缩小"
          size="sm"
          tooltip={false}
          icon={<IconMinus size={14} />}
          disabled={viewport.zoom <= MIN_ZOOM}
          onClick={() => zoomBy(1 / ZOOM_STEP)}
        />
        <span
          aria-label={`缩放 ${Math.round(viewport.zoom * 100)}%`}
          className="min-w-12 text-center text-footnote text-secondary"
        >
          {Math.round(viewport.zoom * 100)}%
        </span>
        <IconButton
          label="放大"
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
          适应
        </Button>
      </div>
    </div>
  );
}
