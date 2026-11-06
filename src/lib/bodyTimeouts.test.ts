import { describe, expect, it } from "vitest";
import { parseBodyTimeouts } from "./bodyTimeouts";

describe("响应体超时设置", () => {
  it("接受区间内且总时不低于空闲的值", () => {
    expect(parseBodyTimeouts("30", "300")).toEqual({ idle: 30, total: 300 });
    expect(parseBodyTimeouts(" 5 ", "30")).toEqual({ idle: 5, total: 30 });
    expect(parseBodyTimeouts("300", "1800")).toEqual({
      idle: 300,
      total: 1800,
    });
  });

  it("拒绝非整数、越界与空值", () => {
    expect(() => parseBodyTimeouts("4", "300")).toThrow("无数据超时");
    expect(() => parseBodyTimeouts("301", "300")).toThrow("无数据超时");
    expect(() => parseBodyTimeouts("1.5", "300")).toThrow("无数据超时");
    expect(() => parseBodyTimeouts("", "300")).toThrow("无数据超时");
    expect(() => parseBodyTimeouts("30", "29")).toThrow("总超时");
    expect(() => parseBodyTimeouts("30", "1801")).toThrow("总超时");
    expect(() => parseBodyTimeouts("30", "abc")).toThrow("总超时");
  });

  it("拒绝总时小于空闲", () => {
    expect(() => parseBodyTimeouts("60", "59")).toThrow("不能小于");
  });
});
