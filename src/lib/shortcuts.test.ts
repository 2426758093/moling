import { describe, expect, it } from "vitest";
import {
  isComposingEvent,
  isEditableTarget,
  matchesShortcut,
} from "./shortcuts";

function key(init: KeyboardEventInit & { code?: string }): KeyboardEvent {
  return new KeyboardEvent("keydown", { ...init, cancelable: true });
}

describe("matchesShortcut", () => {
  it("修饰键必须完全一致", () => {
    expect(matchesShortcut(key({ key: "k", ctrlKey: true }), "Ctrl+K")).toBe(
      true,
    );
    expect(matchesShortcut(key({ key: "k" }), "Ctrl+K")).toBe(false);
    expect(
      matchesShortcut(
        key({ key: "k", ctrlKey: true, shiftKey: true }),
        "Ctrl+K",
      ),
    ).toBe(false);
  });

  it("Cmd 与 Ctrl 等价（macOS 复用同一份组合键）", () => {
    expect(matchesShortcut(key({ key: "b", metaKey: true }), "Ctrl+B")).toBe(
      true,
    );
  });

  it("字母比较忽略大小写", () => {
    expect(matchesShortcut(key({ key: "K", ctrlKey: true }), "Ctrl+k")).toBe(
      true,
    );
  });

  it("逗号与加号的键名按键盘实际字符匹配", () => {
    expect(matchesShortcut(key({ key: ",", ctrlKey: true }), "Ctrl+,")).toBe(
      true,
    );
    expect(matchesShortcut(key({ key: "+", ctrlKey: true }), "Ctrl+=")).toBe(
      true,
    );
    expect(matchesShortcut(key({ key: "=", ctrlKey: true }), "Ctrl+=")).toBe(
      true,
    );
  });
});

describe("isEditableTarget", () => {
  it("输入类控件与可编辑区域返回 true", () => {
    expect(isEditableTarget(document.createElement("input"))).toBe(true);
    expect(isEditableTarget(document.createElement("textarea"))).toBe(true);
    expect(isEditableTarget(document.createElement("select"))).toBe(true);

    const div = document.createElement("div");
    div.contentEditable = "true";
    // jsdom 不解析 property，isContentEditable 需要显式模拟
    Object.defineProperty(div, "isContentEditable", { value: true });
    expect(isEditableTarget(div)).toBe(true);
  });

  it("普通元素与 null 返回 false", () => {
    expect(isEditableTarget(document.createElement("div"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe("isComposingEvent", () => {
  it("识别 isComposing 与 keyCode 229 两种 IME 状态", () => {
    expect(
      isComposingEvent({ isComposing: true, keyCode: 13 } as KeyboardEvent),
    ).toBe(true);
    expect(
      isComposingEvent({ isComposing: false, keyCode: 229 } as KeyboardEvent),
    ).toBe(true);
    expect(
      isComposingEvent({ isComposing: false, keyCode: 13 } as KeyboardEvent),
    ).toBe(false);
  });
});
