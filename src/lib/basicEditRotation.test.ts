import { describe, expect, it } from "vitest";
import {
  buildBasicEditOps,
  normalizeFreeDeg,
  rotationBoundingBox,
  type BasicEditOpsInput,
} from "./basicEditRotation";

describe("rotationBoundingBox", () => {
  it("0 / 90 / 180 与轴对齐尺寸一致", () => {
    expect(rotationBoundingBox(100, 50, 0)).toEqual({ w: 100, h: 50 });
    expect(rotationBoundingBox(100, 50, 90)).toEqual({ w: 50, h: 100 });
    expect(rotationBoundingBox(100, 50, 180)).toEqual({ w: 100, h: 50 });
    expect(rotationBoundingBox(100, 50, -90)).toEqual({ w: 50, h: 100 });
  });

  it("45° 取包围盒并向上取整", () => {
    // 100*cos45 + 50*sin45 = 106.07 → 107
    expect(rotationBoundingBox(100, 50, 45)).toEqual({ w: 107, h: 107 });
    // 100*cos45 + 100*sin45 = 141.42 → 142
    expect(rotationBoundingBox(100, 100, 45)).toEqual({ w: 142, h: 142 });
  });

  it("非有限角度按不变处理", () => {
    expect(rotationBoundingBox(80, 40, Number.NaN)).toEqual({ w: 80, h: 40 });
  });
});

describe("normalizeFreeDeg", () => {
  it("折回 (-180, 180]", () => {
    expect(normalizeFreeDeg(0)).toBe(0);
    expect(normalizeFreeDeg(179)).toBe(179);
    expect(normalizeFreeDeg(180)).toBe(180);
    expect(normalizeFreeDeg(-180)).toBe(180);
    expect(normalizeFreeDeg(190)).toBe(-170);
    expect(normalizeFreeDeg(-190)).toBe(170);
    expect(normalizeFreeDeg(540)).toBe(180);
    expect(normalizeFreeDeg(-0.5)).toBe(-0.5);
  });

  it("非有限值归 0", () => {
    expect(normalizeFreeDeg(Number.NaN)).toBe(0);
    expect(normalizeFreeDeg(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeFreeDeg(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

const base: BasicEditOpsInput = {
  quarterTurns: 0,
  freeDeg: 0,
  flipH: false,
  flipV: false,
  canvasW: 100,
  canvasH: 100,
  crop: null,
  brightness: 0,
  contrast: 0,
  saturation: 0,
};

describe("buildBasicEditOps", () => {
  it("顺序：rotate → rotateFree → flip → crop → adjust", () => {
    const ops = buildBasicEditOps({
      ...base,
      quarterTurns: 1,
      freeDeg: 7.5,
      flipH: true,
      crop: { x: 10, y: 10, w: 50, h: 50 },
      brightness: 10,
    });
    expect(ops.map((o) => o.type)).toEqual([
      "rotate",
      "rotateFree",
      "flip",
      "adjust",
    ]);
    expect(ops[0]).toEqual({ type: "rotate", deg: 90 });
    expect(ops[1]).toEqual({ type: "rotateFree", deg: 7.5 });
  });

  it("自由旋转时不生成 crop", () => {
    const ops = buildBasicEditOps({
      ...base,
      freeDeg: -12,
      crop: { x: 10, y: 10, w: 50, h: 50 },
    });
    expect(ops.map((o) => o.type)).toEqual(["rotateFree"]);
  });

  it("无自由旋转时生成 crop 并夹到画布内", () => {
    const ops = buildBasicEditOps({
      ...base,
      crop: { x: -5, y: 10, w: 500, h: 40 },
    });
    expect(ops).toEqual([
      { type: "crop", x: 0, y: 10, width: 100, height: 40 },
    ]);
  });

  it("全图裁剪与微小自由角都不生成 op", () => {
    expect(
      buildBasicEditOps({ ...base, crop: { x: 0, y: 0, w: 100, h: 100 } }),
    ).toEqual([]);
    expect(buildBasicEditOps({ ...base, freeDeg: 0.005 })).toEqual([]);
  });
});
