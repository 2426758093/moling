import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import {
  CANVAS_VERSION,
  MAX_LAYERS_PER_CANVAS,
  MAX_LAYERS_PER_NODE,
  parseCanvasData,
  useCanvasStore,
} from "./canvasStore";

function resetStore() {
  useCanvasStore.setState({
    thumbs: {},
    gifIds: {},
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    activeId: null,
    activeName: "",
    selectedNodeId: null,
    layerPanelOpen: false,
    dirty: false,
    saving: false,
  });
}

beforeEach(() => {
  resetStore();
});

describe("缩略图加载失败后的重试（F-017）", () => {
  it("批次失败会回滚占位，下一次调用重新请求", async () => {
    const batch = vi
      .spyOn(api, "batchHistoryThumbs")
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValueOnce([
        { historyId: 9001, thumbUrl: "data:image/png;base64,AA" },
      ]);

    await useCanvasStore.getState().loadThumbs([9001]);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(useCanvasStore.getState().thumbs[9001]).toBeUndefined();

    await useCanvasStore.getState().loadThumbs([9001]);
    expect(batch).toHaveBeenCalledTimes(2);
    expect(useCanvasStore.getState().thumbs[9001]).toBe(
      "data:image/png;base64,AA",
    );
  });
});

describe("画布文档 v1/v2 容忍解析", () => {
  it("v1 文档（无 version / 无 layers）照常打开，内存归一为 v2", () => {
    const data = parseCanvasData(
      JSON.stringify({
        nodes: [{ id: "n1", historyId: 5, x: 10, y: 20, width: 220 }],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
    );
    expect(data.version).toBe(CANVAS_VERSION);
    expect(data.nodes).toHaveLength(1);
    expect(data.nodes[0].layers).toBeUndefined();
    expect(data.nodes[0].regions).toBeUndefined();
  });

  it("首次追加图层时物化锁定的基准层", () => {
    useCanvasStore.setState({
      nodes: [{ id: "n1", historyId: 5, x: 0, y: 0, width: 220 }],
    });
    const id = useCanvasStore.getState().appendLayer("n1", {
      kind: "image",
      historyId: 9,
      visible: true,
      opacity: 0.5,
      locked: false,
    });
    expect(id).toBeTruthy();
    const layers = useCanvasStore.getState().nodes[0].layers;
    expect(layers).toHaveLength(2);
    expect(layers?.[0]).toMatchObject({
      id: "n1-base",
      historyId: 5,
      locked: true,
    });
    expect(layers?.[1]).toMatchObject({ historyId: 9, opacity: 0.5 });
  });

  it("落盘一律写 v2，且空图层/区域字段被省略", async () => {
    const save = vi.spyOn(api, "saveCanvasBoard").mockResolvedValue({
      id: 1,
      name: "roundtrip",
      dataJson: "",
      createdAt: "t",
      updatedAt: "t",
    });
    useCanvasStore.setState({
      activeId: 1,
      activeName: `roundtrip-${Date.now()}`,
      nodes: [
        { id: "n1", historyId: 5, x: 0, y: 0, width: 220 },
        {
          id: "n2",
          historyId: 6,
          x: 0,
          y: 0,
          width: 220,
          layers: [
            {
              id: "l1",
              kind: "image",
              historyId: 7,
              visible: true,
              opacity: 1,
              locked: false,
            },
          ],
        },
      ],
    });
    await useCanvasStore.getState().flush();
    expect(save).toHaveBeenCalledTimes(1);
    const written = JSON.parse(save.mock.calls[0][2] as string);
    expect(written.version).toBe(2);
    expect(written.nodes[0].layers).toBeUndefined();
    expect(written.nodes[1].layers).toHaveLength(1);
    const roundtrip = parseCanvasData(JSON.stringify(written));
    expect(roundtrip.nodes[1].layers?.[0].historyId).toBe(7);
  });

  it("坏图层被丢弃，同 id 只保留第一条", () => {
    const data = parseCanvasData(
      JSON.stringify({
        version: 2,
        nodes: [
          {
            id: "n1",
            historyId: 5,
            x: 0,
            y: 0,
            width: 220,
            layers: [
              { id: "ok", kind: "image", historyId: 2 },
              "not-an-object",
              { id: "bad-kind", kind: "text" },
              { id: "no-history", kind: "image" },
              { id: "mask-no-path", kind: "mask" },
              { id: "ok", kind: "image", historyId: 3 },
              { id: "opacity", kind: "image", historyId: 4, opacity: 9 },
            ],
          },
        ],
      }),
    );
    const layers = data.nodes[0].layers ?? [];
    expect(layers.map((l) => l.id)).toEqual(["ok", "opacity"]);
    expect(layers[0].historyId).toBe(2);
    expect(layers[1].opacity).toBe(1);
  });

  it("单节点图层截断到上限", () => {
    const layers = Array.from({ length: MAX_LAYERS_PER_NODE + 6 }, (_, i) => ({
      id: `l${i}`,
      kind: "image",
      historyId: i + 2,
    }));
    const data = parseCanvasData(
      JSON.stringify({
        nodes: [{ id: "n1", historyId: 1, x: 0, y: 0, width: 220, layers }],
      }),
    );
    expect(data.nodes[0].layers).toHaveLength(MAX_LAYERS_PER_NODE);
  });

  it("整张画布图层总数截断到上限", () => {
    const nodes = Array.from({ length: 130 }, (_, n) => ({
      id: `n${n}`,
      historyId: n + 1,
      x: 0,
      y: 0,
      width: 220,
      layers: Array.from({ length: MAX_LAYERS_PER_NODE }, (_, i) => ({
        id: `n${n}l${i}`,
        kind: "image",
        historyId: 100000 + n * 100 + i,
      })),
    }));
    const data = parseCanvasData(JSON.stringify({ nodes }));
    const total = data.nodes.reduce(
      (sum, n) => sum + (n.layers?.length ?? 0),
      0,
    );
    expect(total).toBe(MAX_LAYERS_PER_CANVAS);
  });
});

describe("图层与缩略图", () => {
  it("打开画布时缩略图请求包含图像层 historyId", async () => {
    const board = {
      id: 77,
      name: "layers",
      createdAt: "t",
      updatedAt: "t",
      dataJson: JSON.stringify({
        version: 2,
        nodes: [
          {
            id: "n1",
            historyId: 70001,
            x: 0,
            y: 0,
            width: 220,
            layers: [
              {
                id: "l1",
                kind: "image",
                historyId: 70002,
                visible: true,
                opacity: 1,
                locked: false,
              },
            ],
          },
        ],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
    };
    vi.spyOn(api, "getCanvasBoard").mockResolvedValue(board);
    const batch = vi.spyOn(api, "batchHistoryThumbs").mockResolvedValue([]);
    await useCanvasStore.getState().selectBoard(77);
    expect(batch).toHaveBeenCalledWith(expect.arrayContaining([70001, 70002]));
  });

  it("已有图层里的图片不会被重复加节点", async () => {
    useCanvasStore.setState({
      activeId: 1,
      loaded: true,
      nodes: [
        {
          id: "n1",
          historyId: 5,
          x: 0,
          y: 0,
          width: 220,
          layers: [
            {
              id: "l1",
              kind: "image",
              historyId: 70003,
              visible: true,
              opacity: 1,
              locked: false,
            },
          ],
        },
      ],
    });
    const id = await useCanvasStore.getState().addHistoryNode(70003);
    expect(id).toBe("n1");
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
  });
});

describe("图层操作", () => {
  const base = {
    id: "n1",
    historyId: 5,
    x: 0,
    y: 0,
    width: 220,
    layers: [
      {
        id: "base",
        kind: "image" as const,
        historyId: 5,
        visible: true,
        opacity: 1,
        locked: true,
      },
      {
        id: "l2",
        kind: "image" as const,
        historyId: 6,
        visible: true,
        opacity: 1,
        locked: false,
      },
      {
        id: "l3",
        kind: "image" as const,
        historyId: 7,
        visible: true,
        opacity: 1,
        locked: false,
      },
    ],
  };

  it("显隐、不透明度与锁定", () => {
    useCanvasStore.setState({ nodes: [base] });
    const s = useCanvasStore.getState();
    s.updateLayer("n1", "l2", { visible: false, opacity: 2 });
    const layer = useCanvasStore
      .getState()
      .nodes[0].layers?.find((l) => l.id === "l2");
    expect(layer?.visible).toBe(false);
    expect(layer?.opacity).toBe(1);
  });

  it("换序不能越过锁定的基准层，也不能移动锁定层", () => {
    useCanvasStore.setState({ nodes: [base] });
    const s = useCanvasStore.getState();
    s.moveLayer("n1", "l2", -1);
    expect(useCanvasStore.getState().nodes[0].layers?.map((l) => l.id)).toEqual(
      ["base", "l2", "l3"],
    );
    s.moveLayer("n1", "l3", -1);
    expect(useCanvasStore.getState().nodes[0].layers?.map((l) => l.id)).toEqual(
      ["base", "l3", "l2"],
    );
    s.moveLayer("n1", "l3", 1);
    expect(useCanvasStore.getState().nodes[0].layers?.map((l) => l.id)).toEqual(
      ["base", "l2", "l3"],
    );
  });

  it("锁定的层不能删除", () => {
    useCanvasStore.setState({ nodes: [base] });
    useCanvasStore.getState().removeLayer("n1", "base");
    expect(useCanvasStore.getState().nodes[0].layers).toHaveLength(3);
    useCanvasStore.getState().removeLayer("n1", "l2");
    expect(useCanvasStore.getState().nodes[0].layers?.map((l) => l.id)).toEqual(
      ["base", "l3"],
    );
  });
});
