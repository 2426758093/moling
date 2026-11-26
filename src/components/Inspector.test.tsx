import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 检查器挂载时会读取思考模型配置：测试里不启动 Tauri。
vi.mock("../lib/api", () => ({
  api: {
    getThinkingConfig: vi.fn(async () => null),
    saveThinkingConfig: vi.fn(async () => null),
  },
}));

import Inspector from "./Inspector";
import { useLayoutStore } from "../stores/layoutStore";
import { INSPECTOR_DEFAULT, INSPECTOR_MAX, INSPECTOR_MIN } from "../lib/layout";

beforeEach(() => {
  localStorage.clear();
  useLayoutStore.setState({
    sidebarWidth: 248,
    inspectorWidth: INSPECTOR_DEFAULT,
    composerHeight: 160,
    resizing: null,
  });
});

describe("Inspector 参数入口去重", () => {
  it("画幅与生成数量只在输入坞出现，检查器不再重复", async () => {
    await act(async () => {
      render(<Inspector />);
    });

    expect(screen.queryByText("画幅")).toBeNull();
    expect(screen.queryByText("生成数量")).toBeNull();
  });

  it("保留绘图服务商、绘图模型与思考模型", async () => {
    await act(async () => {
      render(<Inspector />);
    });

    expect(screen.getByText("绘图服务商")).toBeTruthy();
    expect(screen.getByText("绘图模型")).toBeTruthy();
    expect(screen.getByText("思考模型")).toBeTruthy();
  });
});

describe("Inspector 宽度", () => {
  it("宽度绑定布局 store", async () => {
    await act(async () => {
      render(<Inspector />);
    });
    const panel = screen.getByRole("complementary", { name: "生成参数" });
    expect((panel as HTMLElement).style.width).toBe(`${INSPECTOR_DEFAULT}px`);

    await act(async () => {
      useLayoutStore.getState().setInspectorWidth(360);
    });
    expect((panel as HTMLElement).style.width).toBe("360px");
  });

  it("store 把越界宽度夹取到范围内", () => {
    useLayoutStore.getState().setInspectorWidth(9999);
    expect(useLayoutStore.getState().inspectorWidth).toBe(INSPECTOR_MAX);
    useLayoutStore.getState().setInspectorWidth(1);
    expect(useLayoutStore.getState().inspectorWidth).toBe(INSPECTOR_MIN);
  });
});
