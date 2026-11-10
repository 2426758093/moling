import i18n from "../i18n";
import type { CanvasLayer, CanvasNode } from "../stores/canvasStore";

/** 合成命令的图层入参（与 Rust `ComposeLayerInput` 对齐） */
export interface ComposeLayerInput {
  historyId?: number;
  path?: string;
  visible: boolean;
  opacity: number;
  maskPath?: string;
  feather?: number;
  regionId?: string;
}

export function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

export function isBaseLayer(node: CanvasNode, layer: CanvasLayer): boolean {
  if (layer.kind !== "image" || layer.historyId !== node.historyId)
    return false;
  return layer.locked === true && layer.id === `${node.id}-base`;
}

/** 节点实际层栈：v1 节点没有 layers 时，内存里补一层基准图（不落盘） */
export function effectiveLayers(node: CanvasNode): CanvasLayer[] {
  if (node.layers && node.layers.length > 0) return node.layers;
  return [
    {
      id: `${node.id}-base`,
      kind: "image",
      historyId: node.historyId,
      visible: true,
      opacity: 1,
      locked: true,
    },
  ];
}

/** 节点缩略图取「最上面一层可见图像」；全隐藏时回落到基准图 */
export function topVisibleHistoryId(node: CanvasNode): number {
  const layers = effectiveLayers(node);
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const layer = layers[i];
    if (layer.kind !== "image" || !layer.visible || layer.opacity <= 0)
      continue;
    if (layer.historyId) return layer.historyId;
  }
  return node.historyId;
}

/** 缩略图去重：节点基准图 + 全部图像层 */
export function collectThumbIds(nodes: CanvasNode[]): number[] {
  const ids = new Set<number>();
  for (const node of nodes) {
    ids.add(node.historyId);
    for (const layer of node.layers ?? []) {
      if (layer.kind === "image" && layer.historyId) ids.add(layer.historyId);
    }
  }
  return Array.from(ids);
}

/** 合成入参：mask 层只通过 `maskLayerId` 约束图像层，不单独参与合成 */
export function composeLayerInputs(node: CanvasNode): ComposeLayerInput[] {
  const layers = effectiveLayers(node);
  const maskById = new Map(
    layers.filter((l) => l.kind === "mask").map((l) => [l.id, l]),
  );
  return layers
    .filter((l) => l.kind === "image")
    .map((layer) => {
      const mask = layer.maskLayerId
        ? maskById.get(layer.maskLayerId)
        : undefined;
      const region = layer.regionId
        ? node.regions?.find((r) => r.id === layer.regionId)
        : undefined;
      return {
        ...(layer.historyId ? { historyId: layer.historyId } : {}),
        visible: layer.visible,
        opacity: clampOpacity(layer.opacity),
        ...(mask?.path ? { maskPath: mask.path } : {}),
        ...(region ? { feather: region.feather } : {}),
        ...(layer.regionId ? { regionId: layer.regionId } : {}),
      };
    });
}

/** 节点是否有基准图之外的图像层：有则需要先合成再编辑/导出 */
export function hasOverlayLayers(node: CanvasNode): boolean {
  return (node.layers ?? []).some(
    (l) =>
      l.kind === "image" &&
      l.historyId != null &&
      l.historyId !== node.historyId,
  );
}

export function layerLabel(layer: CanvasLayer, index: number): string {
  const name = layer.name?.trim();
  if (name) return name;
  return layer.kind === "mask"
    ? i18n.t("蒙版 {{index}}", { index: index + 1 })
    : i18n.t("图层 {{index}}", { index: index + 1 });
}
