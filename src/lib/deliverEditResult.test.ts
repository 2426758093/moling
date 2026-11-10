import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addHistoryNode: vi.fn(),
  addEdge: vi.fn(),
  appendLayer: vi.fn(),
  gifIds: {} as Record<number, boolean>,
  appendImageMessage: vi.fn(),
  toast: vi.fn(),
  activeId: 1 as number | null,
}));

vi.mock("../stores/canvasStore", () => ({
  useCanvasStore: {
    getState: () => ({
      nodes: [{ id: "n1", historyId: 7, x: 0, y: 0, width: 220 }],
      addHistoryNode: mocks.addHistoryNode,
      addEdge: mocks.addEdge,
      appendLayer: mocks.appendLayer,
      gifIds: mocks.gifIds,
    }),
  },
}));

vi.mock("../stores/chatStore", () => ({
  useChatStore: {
    getState: () => ({
      activeId: mocks.activeId,
      appendImageMessage: mocks.appendImageMessage,
    }),
  },
}));

vi.mock("./notify", () => ({ toast: mocks.toast }));

import { deliverEditResult } from "./deliverEditResult";

const out = {
  historyId: 9,
  dataUrl: "data:image/png;base64,AAAA",
  filePath: "C:/img/9.png",
};

describe("deliverEditResult", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.activeId = 1;
    mocks.addHistoryNode.mockResolvedValue("n9");
    mocks.appendLayer.mockReturnValue("l9");
    mocks.gifIds = {};
  });

  it("routes canvas-hosted results to a new node plus source edge", async () => {
    const dest = await deliverEditResult(
      { historyId: 7, host: "canvas" },
      out,
      "局部重绘",
    );
    expect(dest).toBe("canvas");
    expect(mocks.addHistoryNode).toHaveBeenCalledWith(9);
    expect(mocks.addEdge).toHaveBeenCalledWith("n1", "n9");
    expect(mocks.appendImageMessage).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("已加入画布");
  });

  it("adds a same-size result as a layer instead of a node", async () => {
    const dest = await deliverEditResult(
      { historyId: 7, host: "canvas", width: 1024, height: 1024 },
      { ...out, width: 1024, height: 1024 },
      "局部重绘",
    );
    expect(dest).toBe("canvas");
    expect(mocks.appendLayer).toHaveBeenCalledWith(
      "n1",
      expect.objectContaining({ historyId: 9, kind: "image" }),
    );
    expect(mocks.addHistoryNode).not.toHaveBeenCalled();
    expect(mocks.addEdge).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("已作为新图层加入");
  });

  it("creates a child node when the result size changes", async () => {
    const dest = await deliverEditResult(
      { historyId: 7, host: "canvas", width: 1024, height: 1024 },
      { ...out, width: 1536, height: 1024 },
      "扩图",
    );
    expect(dest).toBe("canvas");
    expect(mocks.appendLayer).not.toHaveBeenCalled();
    expect(mocks.addEdge).toHaveBeenCalledWith("n1", "n9");
    expect(mocks.toast).toHaveBeenCalledWith("尺寸已变化，已生成为独立节点");
  });

  it("never layers results onto a GIF node", async () => {
    mocks.gifIds[7] = true;
    const dest = await deliverEditResult(
      { historyId: 7, host: "canvas", width: 240, height: 240 },
      { ...out, width: 240, height: 240 },
      "已转静图",
    );
    expect(dest).toBe("canvas");
    expect(mocks.appendLayer).not.toHaveBeenCalled();
    expect(mocks.addEdge).toHaveBeenCalledWith("n1", "n9");
  });

  it("skips the edge when the source node is no longer on the canvas", async () => {
    const dest = await deliverEditResult(
      { historyId: 404, host: "canvas" },
      out,
      "基础编辑",
    );
    expect(dest).toBe("canvas");
    expect(mocks.addEdge).not.toHaveBeenCalled();
  });

  it("appends to the active conversation for global entries", async () => {
    const dest = await deliverEditResult({ historyId: 7 }, out, "局部重绘");
    expect(dest).toBe("chat");
    expect(mocks.appendImageMessage).toHaveBeenCalledWith(
      {
        historyId: 9,
        dataUrl: out.dataUrl,
        path: out.filePath,
        derivedFrom: 7,
      },
      "局部重绘",
    );
  });

  it("only notifies when no conversation is open", async () => {
    mocks.activeId = null;
    const dest = await deliverEditResult({ historyId: 7 }, out, "局部重绘");
    expect(dest).toBe("gallery");
    expect(mocks.appendImageMessage).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      "已保存到画廊（当前没有打开的会话）",
    );
  });
});
