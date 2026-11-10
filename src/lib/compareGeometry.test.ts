import { describe, expect, it } from "vitest";
import { clampPercent, clipBefore, slidePosition } from "./compareGeometry";

describe("clampPercent", () => {
  it("保留 0 / 100 两个端点", () => {
    expect(clampPercent(0)).toBe(0);
    expect(clampPercent(100)).toBe(100);
  });

  it("越界一律夹到端点", () => {
    expect(clampPercent(-0.4)).toBe(0);
    expect(clampPercent(-80)).toBe(0);
    expect(clampPercent(100.4)).toBe(100);
    expect(clampPercent(1e6)).toBe(100);
  });

  it("取整并兜住非有限值", () => {
    expect(clampPercent(50.4)).toBe(50);
    expect(clampPercent(50.6)).toBe(51);
    expect(clampPercent(Number.NaN)).toBe(50);
    expect(clampPercent(Number.POSITIVE_INFINITY)).toBe(50);
  });
});

describe("slidePosition", () => {
  it("指针在左缘 / 右缘时给 0 / 100", () => {
    expect(slidePosition(0, 800)).toBe(0);
    expect(slidePosition(800, 800)).toBe(100);
  });

  it("中点与越界拖动", () => {
    expect(slidePosition(400, 800)).toBe(50);
    expect(slidePosition(-40, 800)).toBe(0);
    expect(slidePosition(900, 800)).toBe(100);
  });

  it("舞台宽度为 0 时保持中点，不产生 NaN", () => {
    expect(slidePosition(120, 0)).toBe(50);
    expect(slidePosition(120, -10)).toBe(50);
  });
});

describe("clipBefore", () => {
  it("0 时原图完全裁掉，100 时完整保留", () => {
    expect(clipBefore(0)).toBe("inset(0 100% 0 0)");
    expect(clipBefore(100)).toBe("inset(0 0% 0 0)");
  });

  it("中间值按左侧比例保留", () => {
    expect(clipBefore(25)).toBe("inset(0 75% 0 0)");
    expect(clipBefore(50)).toBe("inset(0 50% 0 0)");
    expect(clipBefore(-10)).toBe("inset(0 100% 0 0)");
    expect(clipBefore(140)).toBe("inset(0 0% 0 0)");
  });
});
