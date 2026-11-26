import { describe, expect, it } from "vitest";
import { describeConnectionError, truncateDetail } from "./connectionError";

describe("连接错误映射", () => {
  it("401 / 鉴权失败映射为 Key 无效", () => {
    expect(
      describeConnectionError({ type: "auth_invalid", message: "HTTP 401" })
        .title,
    ).toBe("Key 无效，请检查 API Key");
    expect(describeConnectionError("unauthorized", 401).title).toBe(
      "Key 无效，请检查 API Key",
    );
  });

  it("404 提示 Base URL 可能缺少 /v1", () => {
    expect(describeConnectionError("404 not found").title).toBe(
      "Base URL 可能缺少 /v1",
    );
    expect(
      describeConnectionError({ type: "upstream", message: "Not Found" }, 404)
        .title,
    ).toBe("Base URL 可能缺少 /v1");
  });

  it("超时与网络错误分别给出可操作提示", () => {
    expect(
      describeConnectionError({ type: "timeout", message: "request timed out" })
        .title,
    ).toBe("服务商响应超时");
    expect(
      describeConnectionError({ type: "network", message: "failed to fetch" })
        .title,
    ).toBe("网络错误，请检查地址或代理");
  });

  it("原始消息截断展示，但复制内容保留完整消息", () => {
    const long = "x".repeat(400);
    const info = describeConnectionError({ type: "other", message: long });
    expect(info.detail.length).toBe(241);
    expect(info.detail.endsWith("…")).toBe(true);
    expect(info.raw).toBe(long);
    expect(truncateDetail("short")).toBe("short");
  });
});
