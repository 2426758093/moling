import { describe, expect, it } from "vitest";
import {
  CROP_RATIOS,
  OUTPAINT_RATIOS,
  cropRectForRatio,
  outpaintOffsets,
  outpaintTargetSize,
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
