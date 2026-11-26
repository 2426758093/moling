import { describe, expect, it } from "vitest";
import {
  COUNT_MAX,
  GEN_SIZE_MIN,
  GIF_FRAME_DEFAULT,
  GIF_FRAME_MAX,
  GIF_FRAME_MIN,
  GIF_FRAME_MS_DEFAULT,
  GIF_FRAME_MS_MAX,
  GIF_FRAME_MS_MIN,
  REFERENCE_MAX,
  SIZE_MAX,
  SIZE_STEP,
  snapGenerationSize,
} from "./rules";

describe("rules 常量", () => {
  it("与后端 rules.rs 同口径", () => {
    expect([GEN_SIZE_MIN, SIZE_MAX, SIZE_STEP]).toEqual([512, 4096, 8]);
    expect(COUNT_MAX).toBe(4);
    expect(REFERENCE_MAX).toBe(4);
    expect([GIF_FRAME_MIN, GIF_FRAME_MAX]).toEqual([2, 16]);
    expect([GIF_FRAME_MS_MIN, GIF_FRAME_MS_MAX]).toEqual([20, 2000]);
    expect(GIF_FRAME_DEFAULT).toBe(9);
    expect(GIF_FRAME_MS_DEFAULT).toBe(200);
  });
});

describe("snapGenerationSize", () => {
  it("夹到生成区间并吸附 8 的倍数", () => {
    expect(snapGenerationSize(0)).toBe(512);
    expect(snapGenerationSize(1)).toBe(512);
    expect(snapGenerationSize(-100)).toBe(512);
    // 513 就近吸附到 512，而不是被抬到 520
    expect(snapGenerationSize(513)).toBe(512);
    expect(snapGenerationSize(1024)).toBe(1024);
    // 4090 就近吸附到 4088，不会越过上限
    expect(snapGenerationSize(4090)).toBe(4088);
    expect(snapGenerationSize(4097)).toBe(4096);
    expect(snapGenerationSize(Number.MAX_SAFE_INTEGER)).toBe(SIZE_MAX);
  });

  it("结果永远 8 对齐且不越界", () => {
    for (const n of [0, 7, 63, 511, 512, 513, 1001, 4095, 4096, 5000]) {
      const v = snapGenerationSize(n);
      expect(v % SIZE_STEP).toBe(0);
      expect(v).toBeGreaterThanOrEqual(GEN_SIZE_MIN);
      expect(v).toBeLessThanOrEqual(SIZE_MAX);
    }
  });
});
