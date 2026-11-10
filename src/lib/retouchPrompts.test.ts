import { describe, expect, it } from "vitest";
import { ERASE_PROMPT, GUARD_SUFFIX } from "./retouchPrompts";

describe("ERASE_PROMPT", () => {
  it("包含护栏后缀，且以它收尾", () => {
    expect(ERASE_PROMPT).toContain(GUARD_SUFFIX.trim());
    expect(ERASE_PROMPT.endsWith(GUARD_SUFFIX)).toBe(true);
  });

  it("说清「删掉涂抹对象 + 自然补背景」", () => {
    expect(ERASE_PROMPT).toContain("Remove the painted object");
    expect(ERASE_PROMPT).toContain("reconstruct the background");
  });
});
