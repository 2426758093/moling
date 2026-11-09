import { describe, expect, it } from "vitest";
import {
  compileRegionPrompt,
  MAX_REGIONS,
  writeRegionPrompt,
  type RegionHint,
} from "./regionPrompt";

describe("compileRegionPrompt", () => {
  it("returns empty string when nothing is described", () => {
    expect(compileRegionPrompt([])).toBe("");
    expect(compileRegionPrompt([{ area: "left", description: "   " }])).toBe(
      "",
    );
  });

  it("compiles area phrases in order", () => {
    const regions: RegionHint[] = [
      { area: "left", description: "a red fox" },
      { area: "background", description: "snowy forest" },
    ];
    expect(compileRegionPrompt(regions)).toBe(
      "Regional layout — left third: a red fox; background: snowy forest.",
    );
  });

  it("skips empty entries but keeps the rest", () => {
    const regions: RegionHint[] = [
      { area: "top", description: "" },
      { area: "bottom", description: "calm lake" },
    ];
    expect(compileRegionPrompt(regions)).toBe(
      "Regional layout — bottom: calm lake.",
    );
  });

  it("caps at MAX_REGIONS", () => {
    const regions: RegionHint[] = Array.from(
      { length: MAX_REGIONS + 2 },
      (_, i) => ({ area: "center", description: `item ${i}` }),
    );
    const out = compileRegionPrompt(regions);
    expect(out).toContain("item 0");
    expect(out).toContain(`item ${MAX_REGIONS - 1}`);
    expect(out).not.toContain(`item ${MAX_REGIONS}`);
  });
});

describe("writeRegionPrompt", () => {
  it("keeps the draft and appends on a new line", () => {
    const out = writeRegionPrompt("a cat", [
      { area: "right", description: "window light" },
    ]);
    expect(out.text).toBe(
      "a cat\nRegional layout — right third: window light.",
    );
  });

  it("returns the draft untouched when there is nothing to add", () => {
    const out = writeRegionPrompt("a cat", []);
    expect(out.text).toBe("a cat");
    expect(out.block).toBe("");
  });

  it("avoids a leading newline on empty drafts", () => {
    const out = writeRegionPrompt("  ", [
      { area: "full", description: "night city" },
    ]);
    expect(out.text).toBe("Regional layout — whole frame: night city.");
  });

  it("replaces the previously written block instead of stacking it", () => {
    const first = writeRegionPrompt("a cat", [
      { area: "right", description: "window light" },
    ]);
    const second = writeRegionPrompt(
      first.text,
      [{ area: "right", description: "moon light" }],
      first.block,
    );
    expect(second.text).toBe(
      "a cat\nRegional layout — right third: moon light.",
    );
  });
});
