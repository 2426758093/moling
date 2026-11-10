import { describe, expect, it } from "vitest";
import { ERASE_PROMPT, GUARD_SUFFIX, withGuard } from "./retouchPrompts";

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

describe("withGuard", () => {
  it("空提示词绝不拼护栏后缀（含纯空白）", () => {
    // 空 prompt 拼上护栏等于给了一个「什么都别改」的指令，必须原样返回空串
    expect(withGuard("")).toBe("");
    expect(withGuard("   ")).toBe("");
  });

  it("非空提示词保留原文并追加护栏后缀", () => {
    const result = withGuard("换成一个花园");
    expect(result.startsWith("换成一个花园")).toBe(true);
    expect(result.endsWith(GUARD_SUFFIX)).toBe(true);
    expect(result.length).toBeGreaterThan("换成一个花园".length);
  });
});
