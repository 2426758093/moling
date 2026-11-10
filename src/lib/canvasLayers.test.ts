import { describe, expect, it } from "vitest";
import {
  clampOpacity,
  collectThumbIds,
  composeLayerInputs,
  effectiveLayers,
  hasOverlayLayers,
  isBaseLayer,
  topVisibleHistoryId,
} from "./canvasLayers";
import type { CanvasNode } from "../stores/canvasStore";

function node(patch: Partial<CanvasNode> = {}): CanvasNode {
  return { id: "n1", historyId: 1, x: 0, y: 0, width: 220, ...patch };
}

describe("clampOpacity", () => {
  it("夹到 0..1，非法值回 1", () => {
    expect(clampOpacity(-0.5)).toBe(0);
    expect(clampOpacity(2)).toBe(1);
    expect(clampOpacity(0.4)).toBeCloseTo(0.4);
    expect(clampOpacity(Number.NaN)).toBe(1);
  });
});

describe("effectiveLayers", () => {
  it("v1 节点补一层锁定的基准图，且不写回节点", () => {
    const n = node();
    const layers = effectiveLayers(n);
    expect(layers).toHaveLength(1);
    expect(layers[0]).toMatchObject({
      id: "n1-base",
      kind: "image",
      historyId: 1,
      visible: true,
      opacity: 1,
      locked: true,
    });
    expect(n.layers).toBeUndefined();
    expect(isBaseLayer(n, layers[0])).toBe(true);
  });

  it("已有图层时原样返回（基准层不再合成）", () => {
    const n = node({
      layers: [
        {
          id: "l1",
          kind: "image",
          historyId: 2,
          visible: true,
          opacity: 1,
          locked: false,
        },
      ],
    });
    expect(effectiveLayers(n)).toBe(n.layers);
  });
});

describe("topVisibleHistoryId", () => {
  it("取最上层可见图像层，跳过蒙版层与隐藏/全透明层", () => {
    const n = node({
      layers: [
        {
          id: "base",
          kind: "image",
          historyId: 1,
          visible: true,
          opacity: 1,
          locked: true,
        },
        {
          id: "l2",
          kind: "image",
          historyId: 2,
          visible: false,
          opacity: 1,
          locked: false,
        },
        {
          id: "l3",
          kind: "image",
          historyId: 3,
          visible: true,
          opacity: 0,
          locked: false,
        },
        {
          id: "m1",
          kind: "mask",
          path: "C:/media/mask.png",
          visible: true,
          opacity: 1,
          locked: false,
        },
        {
          id: "l4",
          kind: "image",
          historyId: 4,
          visible: true,
          opacity: 0.5,
          locked: false,
        },
      ],
    });
    expect(topVisibleHistoryId(n)).toBe(4);
  });

  it("全部隐藏时回落到节点基准图", () => {
    const n = node({
      layers: [
        {
          id: "l2",
          kind: "image",
          historyId: 2,
          visible: false,
          opacity: 1,
          locked: false,
        },
      ],
    });
    expect(topVisibleHistoryId(n)).toBe(1);
  });
});

describe("collectThumbIds", () => {
  it("节点基准图与图像层去重，忽略蒙版层", () => {
    const ids = collectThumbIds([
      node({
        historyId: 1,
        layers: [
          {
            id: "base",
            kind: "image",
            historyId: 1,
            visible: true,
            opacity: 1,
            locked: true,
          },
          {
            id: "l2",
            kind: "image",
            historyId: 2,
            visible: true,
            opacity: 1,
            locked: false,
          },
          {
            id: "m1",
            kind: "mask",
            path: "C:/media/mask.png",
            visible: true,
            opacity: 1,
            locked: false,
          },
        ],
      }),
      node({ id: "n2", historyId: 2 }),
    ]);
    expect(ids.sort((a, b) => a - b)).toEqual([1, 2]);
  });
});

describe("composeLayerInputs", () => {
  it("蒙版层不参与合成，只以 maskPath/feather 约束对应图像层", () => {
    const n = node({
      layers: [
        {
          id: "base",
          kind: "image",
          historyId: 1,
          visible: true,
          opacity: 1,
          locked: true,
        },
        {
          id: "m1",
          kind: "mask",
          path: "C:/media/mask.png",
          visible: true,
          opacity: 1,
          locked: false,
        },
        {
          id: "l2",
          kind: "image",
          historyId: 2,
          visible: true,
          opacity: 0.6,
          locked: false,
          maskLayerId: "m1",
          regionId: "r1",
        },
      ],
      regions: [
        {
          id: "r1",
          prompt: "换天空",
          maskPath: "C:/media/region.png",
          feather: 30,
        },
      ],
    });
    const inputs = composeLayerInputs(n);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toEqual({ historyId: 1, visible: true, opacity: 1 });
    expect(inputs[1]).toEqual({
      historyId: 2,
      visible: true,
      opacity: 0.6,
      maskPath: "C:/media/mask.png",
      feather: 30,
      regionId: "r1",
    });
  });

  it("v1 节点只产出基准图一层", () => {
    expect(composeLayerInputs(node())).toEqual([
      { historyId: 1, visible: true, opacity: 1 },
    ]);
  });
});

describe("hasOverlayLayers", () => {
  it("只有基准图时不需要合成，有额外图像层则需要", () => {
    expect(hasOverlayLayers(node())).toBe(false);
    expect(
      hasOverlayLayers(
        node({
          layers: [
            {
              id: "base",
              kind: "image",
              historyId: 1,
              visible: true,
              opacity: 1,
              locked: true,
            },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      hasOverlayLayers(
        node({
          layers: [
            {
              id: "l2",
              kind: "image",
              historyId: 2,
              visible: true,
              opacity: 1,
              locked: false,
            },
          ],
        }),
      ),
    ).toBe(true);
  });
});
