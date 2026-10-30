import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { useCanvasStore } from "./canvasStore";

beforeEach(() => {
  useCanvasStore.setState({ thumbs: {} });
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
