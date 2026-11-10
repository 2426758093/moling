import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import {
  composeLayerInputs,
  effectiveLayers,
  isBaseLayer,
  layerLabel,
} from "../lib/canvasLayers";
import { emitHistoryChanged } from "../lib/historyEvents";
import { toast } from "../lib/notify";
import { saveDataUrl } from "../lib/save";
import { CanvasLayer, CanvasNode, useCanvasStore } from "../stores/canvasStore";
import SafeImg from "./SafeImg";
import { IconButton } from "./ui/IconButton";
import { Button } from "./ui/Button";
import {
  IconChevron,
  IconClose,
  IconDownload,
  IconEye,
  IconEyeOff,
  IconImage,
  IconLayers,
  IconLock,
  IconTrash,
} from "./Icons";
import { cn } from "./ui/cn";

/// 画布图层浮层：296px 玻璃面板，挂在选中节点旁。
/// 行高 44px、缩略图 40px；显隐/锁定/不透明度/换序/删除，底部合并与导出。
export default function LayerPanel({
  node,
  onClose,
}: {
  node: CanvasNode;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const thumbs = useCanvasStore((s) => s.thumbs);
  const updateLayer = useCanvasStore((s) => s.updateLayer);
  const removeLayer = useCanvasStore((s) => s.removeLayer);
  const moveLayer = useCanvasStore((s) => s.moveLayer);
  const replaceNodeLayers = useCanvasStore((s) => s.replaceNodeLayers);
  const addHistoryNode = useCanvasStore((s) => s.addHistoryNode);
  const addEdge = useCanvasStore((s) => s.addEdge);
  const removeNode = useCanvasStore((s) => s.removeNode);

  const layers = effectiveLayers(node);
  const [activeId, setActiveId] = useState<string | null>(null);
  const active =
    layers.find((l) => l.id === activeId) ?? layers[layers.length - 1];
  const [maskThumbs, setMaskThumbs] = useState<Record<string, string>>({});
  const requestedMasks = useRef<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const maskPaths = useMemo(
    () =>
      layers
        .filter((l) => l.kind === "mask" && l.path)
        .map((l) => l.path as string),
    [layers],
  );

  useEffect(() => {
    let cancelled = false;
    for (const path of maskPaths) {
      if (requestedMasks.current.has(path)) continue;
      requestedMasks.current.add(path);
      void api
        .readMediaImage(path)
        .then((res) => {
          if (!cancelled) {
            setMaskThumbs((m) => ({ ...m, [path]: res.dataUrl }));
          }
        })
        .catch(() => {
          requestedMasks.current.delete(path);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [maskPaths]);

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
        e.preventDefault();
        onClose();
        return;
      }
      if (!active) return;
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        moveLayer(node.id, active.id, e.key === "ArrowUp" ? 1 : -1);
        return;
      }
      if (e.key === " ") {
        e.preventDefault();
        updateLayer(node.id, active.id, { visible: !active.visible });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, moveLayer, node.id, onClose, updateLayer]);

  const flattenAndExport = async (exportPng: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (exportPng) {
        const out = await api.composeCanvasNode({
          baseHistoryId: node.historyId,
          layers: composeLayerInputs(node),
        });
        const saved = await saveDataUrl(
          out.dataUrl,
          `canvas-${node.historyId}`,
        );
        if (saved) toast(t("已导出 PNG"));
      } else {
        const out = await api.flattenCanvasNode({
          baseHistoryId: node.historyId,
          layers: composeLayerInputs(node),
        });
        const base: CanvasLayer = {
          id: `${node.id}-base`,
          kind: "image",
          historyId: out.historyId,
          visible: true,
          opacity: 1,
          locked: true,
          name: t("合成图层"),
        };
        replaceNodeLayers(node.id, [base], out.historyId, true);
        emitHistoryChanged();
        toast(t("已合并为一张图"));
      }
    } catch (e) {
      toast(t("图层合成失败：{{error}}", { error: String(e) }), "error");
    } finally {
      setBusy(false);
    }
  };

  const splitToNodes = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const overlays = layers.filter(
        (l) =>
          l.kind === "image" && l.historyId && l.historyId !== node.historyId,
      );
      let created = 0;
      for (const layer of overlays) {
        const id = await addHistoryNode(layer.historyId as number);
        if (id) {
          addEdge(node.id, id);
          created += 1;
        }
      }
      if (created > 0) {
        const keep = layers.filter(
          (l) => l.kind !== "image" || l.historyId === node.historyId,
        );
        replaceNodeLayers(node.id, keep);
        setActiveId(null);
        toast(t("已拆分为 {{count}} 个节点", { count: created }));
      } else {
        toast(t("没有可拆分的图层"), "error");
      }
    } catch (e) {
      toast(t("拆分图层失败：{{error}}", { error: String(e) }), "error");
    } finally {
      setBusy(false);
    }
  };

  const thumbFor = (layer: CanvasLayer): string | undefined => {
    if (layer.kind === "image" && layer.historyId)
      return thumbs[layer.historyId];
    if (layer.kind === "mask" && layer.path) return maskThumbs[layer.path];
    return undefined;
  };

  return (
    <div
      role="dialog"
      aria-label={t("图层")}
      onPointerDown={(e) => e.stopPropagation()}
      className="glass absolute right-4 top-4 z-20 flex max-h-[calc(100%-2rem)] w-[296px] flex-col overflow-hidden rounded-panel shadow-pop"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-separator px-3">
        <IconLayers size={15} className="text-tertiary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-callout text-primary">
            {t("图层")} · #{node.historyId}
          </div>
          <div className="text-caption text-quaternary">
            {t("{{count}} 层", { count: layers.length })}
          </div>
        </div>
        <IconButton
          label={t("关闭图层面板")}
          size="sm"
          icon={<IconClose size={14} />}
          onClick={onClose}
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
        {[...layers].reverse().map((layer, revIndex) => {
          const index = layers.length - 1 - revIndex;
          const selected = layer.id === active?.id;
          const thumb = thumbFor(layer);
          return (
            <div
              key={layer.id}
              role="button"
              tabIndex={0}
              onClick={() => setActiveId(layer.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setActiveId(layer.id);
                }
              }}
              className={cn(
                "flex h-11 items-center gap-2 rounded-control px-1.5 outline-none",
                selected ? "bg-hover" : "hover:bg-hover/60",
              )}
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-control bg-sunken">
                {thumb ? (
                  <SafeImg
                    src={thumb}
                    alt=""
                    className="h-10 w-10 object-cover"
                    draggable={false}
                  />
                ) : (
                  <IconImage size={14} className="text-quaternary" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-footnote text-primary">
                  {layerLabel(layer, index)}
                </span>
                <span className="tabular block text-caption text-quaternary">
                  {Math.round(layer.opacity * 100)}%
                  {isBaseLayer(node, layer) && ` · ${t("基准图")}`}
                </span>
              </span>
              <IconButton
                label={layer.visible ? t("隐藏图层") : t("显示图层")}
                size="sm"
                tooltip={false}
                icon={
                  layer.visible ? (
                    <IconEye size={13} />
                  ) : (
                    <IconEyeOff size={13} />
                  )
                }
                onClick={(e) => {
                  e.stopPropagation();
                  updateLayer(node.id, layer.id, { visible: !layer.visible });
                }}
              />
              <IconButton
                label={layer.locked ? t("解锁图层") : t("锁定图层")}
                size="sm"
                tooltip={false}
                icon={<IconLock size={13} />}
                className={layer.locked ? "text-accent" : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  updateLayer(node.id, layer.id, { locked: !layer.locked });
                }}
              />
              <button
                type="button"
                aria-label={t("上移图层")}
                disabled={layer.locked || index >= layers.length - 1}
                onClick={(e) => {
                  e.stopPropagation();
                  moveLayer(node.id, layer.id, 1);
                }}
                className="pressable flex h-7 w-6 items-center justify-center rounded-control text-tertiary hover:bg-hover disabled:opacity-30"
              >
                <IconChevron direction="up" size={12} />
              </button>
              <button
                type="button"
                aria-label={t("下移图层")}
                disabled={layer.locked || index <= 0}
                onClick={(e) => {
                  e.stopPropagation();
                  moveLayer(node.id, layer.id, -1);
                }}
                className="pressable flex h-7 w-6 items-center justify-center rounded-control text-tertiary hover:bg-hover disabled:opacity-30"
              >
                <IconChevron direction="down" size={12} />
              </button>
              <IconButton
                label={t("删除图层")}
                size="sm"
                tooltip={false}
                icon={<IconTrash size={13} />}
                disabled={layer.locked}
                onClick={(e) => {
                  e.stopPropagation();
                  removeLayer(node.id, layer.id);
                }}
              />
            </div>
          );
        })}
      </div>

      {active && (
        <div className="shrink-0 border-t border-separator px-3 py-2">
          <label className="flex items-center gap-2 text-caption text-quaternary">
            {t("不透明度")}
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(active.opacity * 100)}
              onChange={(e) =>
                updateLayer(node.id, active.id, {
                  opacity: Number(e.target.value) / 100,
                })
              }
              className="h-1 flex-1 accent-accent"
            />
            <span className="tabular w-8 text-right text-caption text-tertiary">
              {Math.round(active.opacity * 100)}%
            </span>
          </label>
        </div>
      )}

      <footer className="flex shrink-0 flex-wrap gap-1.5 border-t border-separator px-3 py-2">
        <Button
          size="sm"
          loading={busy}
          onClick={() => void flattenAndExport(false)}
        >
          {t("合并图层")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<IconDownload size={13} />}
          disabled={busy}
          onClick={() => void flattenAndExport(true)}
        >
          {t("导出 PNG")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void splitToNodes()}
        >
          {t("拆分图层")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-danger"
          onClick={() => removeNode(node.id)}
        >
          {t("删除节点")}
        </Button>
      </footer>
    </div>
  );
}
