import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import TitleBar from "./TitleBar";
import ResizeHandles from "./ResizeHandles";
import { TooltipProvider } from "../ui/Tooltip";
import { useAppStore } from "../../stores/appStore";
import { useQueueStore } from "../../stores/queueStore";
import {
  close,
  minimize,
  startResizeDragging,
  toggleMaximize,
} from "../../test/stubs/tauri-window";

/** 窗口按钮只在 Tauri 容器内生效，测试里手动挂上内部标记。 */
function mountTauri() {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}

function unmountTauri() {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

function renderShell(isMaximized = false) {
  return render(
    <TooltipProvider>
      <TitleBar isMaximized={isMaximized} platform="windows" />
      <ResizeHandles isMaximized={isMaximized} />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  unmountTauri();
  useAppStore.setState({ view: "chat", sidebarCollapsed: false });
  useQueueStore.setState({ counts: {} });
});

describe("自绘标题栏（窗口外壳）", () => {
  it("三个窗口按钮分别调用 minimize / toggleMaximize / close", () => {
    mountTauri();
    renderShell();

    fireEvent.click(screen.getByRole("button", { name: "最小化" }));
    fireEvent.click(screen.getByRole("button", { name: "最大化" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    expect(minimize).toHaveBeenCalledTimes(1);
    expect(toggleMaximize).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("最大化时按钮切换为还原图标与文案", () => {
    mountTauri();
    renderShell(true);

    expect(screen.getByRole("button", { name: "还原" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "最大化" })).toBeNull();
  });

  it("最大化时隐藏 8 向缩放命中区", () => {
    mountTauri();
    const { container: normal } = renderShell(false);
    expect(normal.querySelectorAll("[class*='cursor-ns-resize']")).toHaveLength(
      2,
    );
    expect(
      normal.querySelectorAll("[class*='cursor-nwse-resize']"),
    ).toHaveLength(2);

    normal.remove();
    const { container: maximized } = renderShell(true);
    expect(
      maximized.querySelectorAll("[class*='cursor-ns-resize']"),
    ).toHaveLength(0);
  });

  it("缩放命中区按下左键时发起对应方向的缩放拖拽", async () => {
    mountTauri();
    const { container } = renderShell(false);
    const north = container.querySelector(
      "[class*='cursor-ns-resize']",
    ) as HTMLElement;

    fireEvent.pointerDown(north, { button: 0 });
    await waitFor(() =>
      expect(startResizeDragging).toHaveBeenCalledWith("North"),
    );
  });

  it("拖拽区只挂在栏体与空白占位上", () => {
    mountTauri();
    const { container } = renderShell();
    const dragRegions = container.querySelectorAll("[data-tauri-drag-region]");
    expect(dragRegions.length).toBe(3);
    for (const region of dragRegions) {
      expect(region.tagName).not.toBe("BUTTON");
    }
  });
});
