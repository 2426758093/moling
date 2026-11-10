import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  adapterErrorTitle,
  api,
  parseAdapterError,
  type RetouchOp,
} from "./api";

describe("parseAdapterError", () => {
  it("解析后端序列化后的结构化错误", () => {
    const parsed = parseAdapterError(
      JSON.stringify({ type: "auth_invalid", message: "bad key", status: 401 }),
    );
    expect(parsed).toEqual({
      type: "auth_invalid",
      message: "bad key",
      status: 401,
    });
  });

  it("保留每一种已知错误类型", () => {
    const types = [
      "auth_invalid",
      "quota_exceeded",
      "timeout",
      "content_blocked",
      "network",
      "unsupported",
      "other",
    ] as const;
    for (const type of types) {
      expect(
        parseAdapterError(JSON.stringify({ type, message: type })),
      ).toEqual({ type, message: type });
    }
  });

  it("非 JSON 原文退化为 other 且 message 不变", () => {
    expect(parseAdapterError("网络连接被重置")).toEqual({
      type: "other",
      message: "网络连接被重置",
    });
  });

  it("JSON 但缺少 type 时同样退化为 other", () => {
    expect(parseAdapterError(JSON.stringify({ message: "boom" }))).toEqual({
      type: "other",
      message: JSON.stringify({ message: "boom" }),
    });
  });

  it("JSON 标量（如字符串）不会误判为结构化错误", () => {
    expect(parseAdapterError(JSON.stringify("plain"))).toEqual({
      type: "other",
      message: JSON.stringify("plain"),
    });
  });
});

describe("adapterErrorTitle", () => {
  it("已知类型显示对应标题", () => {
    expect(adapterErrorTitle({ type: "auth_invalid", message: "" })).toBe(
      "API Key 无效",
    );
    expect(adapterErrorTitle({ type: "quota_exceeded", message: "" })).toBe(
      "余额不足或触发限额",
    );
    expect(adapterErrorTitle({ type: "timeout", message: "" })).toBe(
      "请求超时",
    );
    expect(adapterErrorTitle({ type: "content_blocked", message: "" })).toBe(
      "内容审核拦截",
    );
    expect(adapterErrorTitle({ type: "unsupported", message: "" })).toBe(
      "该服务商不支持此操作",
    );
  });

  it("network / other 回落到通用标题", () => {
    expect(adapterErrorTitle({ type: "network", message: "" })).toBe(
      "请求失败",
    );
    expect(adapterErrorTitle({ type: "other", message: "" })).toBe("请求失败");
  });
});

describe("修图接口", () => {
  const ops: RetouchOp[] = [{ type: "autoEnhance", strength: 0.5 }];

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("retouchAnalyze 调用 retouch_analyze 且只传图片", async () => {
    const analysis = {
      exposureEv: 0.2,
      wbCast: 0.05,
      contrast: 0.4,
      saturation: 0.5,
      sharpness: 0.6,
      skinRatio: 0.1,
      clipLow: 0.01,
      clipHigh: 0.02,
      meanLuma: 0.5,
      suggestions: ["exposure"],
    };
    vi.mocked(invoke).mockResolvedValue(analysis);

    await expect(api.retouchAnalyze("x")).resolves.toBe(analysis);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("retouch_analyze", { imageB64: "x" });
  });

  it("previewRetouch 与 applyRetouch 走同一个 apply_retouch 命令", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);

    await api.previewRetouch({
      imageB64: "x",
      ops,
      preview: { maxSide: 1024 },
    });
    expect(invoke).toHaveBeenLastCalledWith("apply_retouch", {
      input: { imageB64: "x", ops, preview: { maxSide: 1024 } },
    });

    // 预览与提交的唯一区别就是 input 里有没有 preview
    await api.applyRetouch({ imageB64: "x", parentId: 7, ops });
    expect(invoke).toHaveBeenLastCalledWith("apply_retouch", {
      input: { imageB64: "x", parentId: 7, ops },
    });
  });

  it("historyLineage 调用 history_lineage 并返回裸历史行（root→current）", async () => {
    const lineage = [
      { id: 1, prompt: "", parentId: null, op: "generate" },
      { id: 3, prompt: "", parentId: 1, op: "retouch" },
    ];
    vi.mocked(invoke).mockResolvedValue(lineage);

    await expect(api.historyLineage(3)).resolves.toBe(lineage);
    expect(invoke).toHaveBeenCalledWith("history_lineage", { historyId: 3 });
  });
});
