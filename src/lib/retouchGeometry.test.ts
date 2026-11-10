import { describe, expect, it } from "vitest";
import {
  CROP_RATIOS,
  OUTPAINT_RATIOS,
  buildCropEditOps,
  cropRectForRatio,
  outpaintOffsets,
  outpaintTargetSize,
  rotatedSize,
} from "./retouchGeometry";

describe("比例选项", () => {
  it("扩图与裁剪共用 6 个预设，原始比例没有 aspect", () => {
    expect(OUTPAINT_RATIOS.map((option) => option.id)).toEqual([
      "original",
      "1:1",
      "4:3",
      "3:4",
      "16:9",
      "9:16",
    ]);
    expect(OUTPAINT_RATIOS[0].aspect).toBeNull();
    expect(CROP_RATIOS).toBe(OUTPAINT_RATIOS);
  });
});

describe("outpaintTargetSize / outpaintOffsets", () => {
  it("更宽的图在上下补白", () => {
    const target = outpaintTargetSize({ width: 400, height: 300 }, "1:1");
    expect(target).toEqual({ width: 400, height: 400 });
    expect(outpaintOffsets({ width: 400, height: 300 }, target)).toEqual({
      x: 0,
      y: 50,
    });

    const wide = outpaintTargetSize({ width: 400, height: 300 }, "16:9");
    expect(wide).toEqual({ width: 533, height: 300 });
    expect(outpaintOffsets({ width: 400, height: 300 }, wide)).toEqual({
      x: 66,
      y: 0,
    });
  });

  it("更高的图在左右补白", () => {
    const target = outpaintTargetSize({ width: 300, height: 400 }, "16:9");
    expect(target).toEqual({ width: 711, height: 400 });
    expect(outpaintOffsets({ width: 300, height: 400 }, target)).toEqual({
      x: 205,
      y: 0,
    });
  });

  it("原始比例原样返回，偏移全 0", () => {
    const size = { width: 640, height: 480 };
    const target = outpaintTargetSize(size, "original");
    expect(target).toEqual(size);
    expect(outpaintOffsets(size, target)).toEqual({ x: 0, y: 0 });
  });

  it("非法尺寸不返回 0，也不抛异常", () => {
    for (const size of [
      { width: 0, height: 0 },
      { width: -10, height: 5 },
      { width: Number.NaN, height: Number.POSITIVE_INFINITY },
    ]) {
      const target = outpaintTargetSize(size, "16:9");
      expect(target.width).toBeGreaterThan(0);
      expect(target.height).toBeGreaterThan(0);
      const offsets = outpaintOffsets(size, target);
      expect(Number.isFinite(offsets.x)).toBe(true);
      expect(Number.isFinite(offsets.y)).toBe(true);
      expect(offsets.x).toBeGreaterThanOrEqual(0);
      expect(offsets.y).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("cropRectForRatio", () => {
  it("横向图按目标比例居中裁剪", () => {
    expect(cropRectForRatio({ width: 400, height: 300 }, "1:1")).toEqual({
      x: 50,
      y: 0,
      width: 300,
      height: 300,
    });
    expect(cropRectForRatio({ width: 400, height: 300 }, "16:9")).toEqual({
      x: 0,
      y: 37,
      width: 400,
      height: 225,
    });
  });

  it("纵向图按目标比例居中裁剪", () => {
    expect(cropRectForRatio({ width: 300, height: 400 }, "16:9")).toEqual({
      x: 0,
      y: 115,
      width: 300,
      height: 169,
    });
  });

  it("原始比例是全图", () => {
    expect(cropRectForRatio({ width: 640, height: 480 }, "original")).toEqual({
      x: 0,
      y: 0,
      width: 640,
      height: 480,
    });
  });

  it("非法尺寸给至少 1×1 的安全框", () => {
    const rect = cropRectForRatio({ width: Number.NaN, height: -1 }, "16:9");
    expect(rect.width).toBeGreaterThanOrEqual(1);
    expect(rect.height).toBeGreaterThanOrEqual(1);
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
  });
});

describe("rotatedSize", () => {
  it("90 / 270 互换宽高，0 / 180 原样返回", () => {
    expect(rotatedSize({ width: 400, height: 300 }, 90)).toEqual({
      width: 300,
      height: 400,
    });
    expect(rotatedSize({ width: 400, height: 300 }, 180)).toEqual({
      width: 400,
      height: 300,
    });
    expect(rotatedSize({ width: 400, height: 300 }, 270)).toEqual({
      width: 300,
      height: 400,
    });
    expect(rotatedSize({ width: 400, height: 300 }, 0)).toEqual({
      width: 400,
      height: 300,
    });
  });

  it("非法尺寸不返回 0", () => {
    const size = rotatedSize({ width: Number.NaN, height: -1 }, 90);
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
  });
});

describe("buildCropEditOps", () => {
  it("全默认（不转不翻、全图、无调色）不产出任何 op", () => {
    expect(
      buildCropEditOps({
        deg: 0,
        flipH: false,
        flipV: false,
        rect: { x: 0, y: 0, width: 400, height: 300 },
        canvas: { width: 400, height: 300 },
        tone: { brightness: 0, contrast: 0, saturation: 0 },
      }),
    ).toEqual([]);
  });

  it("旋转 + 水平翻转 + 1:1 裁剪 + 调色：顺序与旧 BasicEditView 一致", () => {
    const canvas = rotatedSize({ width: 400, height: 300 }, 90);
    expect(canvas).toEqual({ width: 300, height: 400 });
    const rect = cropRectForRatio(canvas, "1:1");
    expect(rect).toEqual({ x: 0, y: 50, width: 300, height: 300 });

    expect(
      buildCropEditOps({
        deg: 90,
        flipH: true,
        flipV: false,
        rect,
        canvas,
        tone: { brightness: 10, contrast: -5, saturation: 20 },
      }),
    ).toEqual([
      { type: "rotate", deg: 90 },
      { type: "flip", axis: "horizontal" },
      { type: "crop", x: 0, y: 50, width: 300, height: 300 },
      { type: "adjust", brightness: 10, contrast: -5, saturation: 20 },
    ]);
  });

  it("只有调色 / 只有裁剪时各产出一条", () => {
    expect(
      buildCropEditOps({
        deg: 0,
        flipH: false,
        flipV: false,
        rect: { x: 0, y: 0, width: 400, height: 300 },
        canvas: { width: 400, height: 300 },
        tone: { brightness: 0, contrast: 0, saturation: 15 },
      }),
    ).toEqual([{ type: "adjust", brightness: 0, contrast: 0, saturation: 15 }]);

    expect(
      buildCropEditOps({
        deg: 0,
        flipH: false,
        flipV: false,
        rect: { x: 50, y: 0, width: 300, height: 300 },
        canvas: { width: 400, height: 300 },
        tone: { brightness: 0, contrast: 0, saturation: 0 },
      }),
    ).toEqual([{ type: "crop", x: 50, y: 0, width: 300, height: 300 }]);
  });

  it("坐标取整并夹进画布，宽高至少 1，不抛异常", () => {
    const ops = buildCropEditOps({
      deg: 0,
      flipH: false,
      flipV: false,
      rect: { x: -20, y: 0.6, width: 1000, height: 0 },
      canvas: { width: 400, height: 300 },
      tone: { brightness: 0, contrast: 0, saturation: 0 },
    });
    expect(ops).toEqual([{ type: "crop", x: 0, y: 1, width: 400, height: 1 }]);
  });
});
