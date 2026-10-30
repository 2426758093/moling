import { describe, expect, it } from "vitest";
import { adapterErrorTitle, parseAdapterError } from "./api";

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
