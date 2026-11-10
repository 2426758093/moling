import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./lib/api";
import { useAppStore } from "./stores/appStore";

// 视图与外壳组件会各自拉起数据依赖：这里只验证「离开画布时关掉挂在画布上的编辑目标」
vi.mock("./components/Sidebar", () => ({ default: () => null }));
vi.mock("./components/ChatView", () => ({ default: () => null }));
vi.mock("./components/GalleryView", () => ({ default: () => null }));
vi.mock("./components/CanvasView", () => ({ default: () => null }));
vi.mock("./components/QueueView", () => ({ default: () => null }));
vi.mock("./components/SettingsView", () => ({ default: () => null }));
vi.mock("./components/SettingsRail", () => ({ default: () => null }));
vi.mock("./components/EditorView", () => ({ default: () => null }));
vi.mock("./components/OutpaintView", () => ({ default: () => null }));
vi.mock("./components/TransformDialog", () => ({ default: () => null }));
vi.mock("./components/BasicEditView", () => ({ default: () => null }));
vi.mock("./components/BackgroundView", () => ({ default: () => null }));
vi.mock("./components/AnimationView", () => ({ default: () => null }));
vi.mock("./components/shell/TitleBar", () => ({ default: () => null }));
vi.mock("./components/shell/ResizeHandles", () => ({ default: () => null }));
vi.mock("./components/shell/ShortcutsSheet", () => ({ default: () => null }));
vi.mock("./components/shell/DropOverlay", () => ({ default: () => null }));
vi.mock("./components/shell/UpdateDialog", () => ({ default: () => null }));
vi.mock("./hooks/useWindowState", () => ({
  useWindowState: () => ({ isMaximized: false, platform: "windows" }),
}));
vi.mock("./hooks/useGlobalShortcuts", () => ({
  useGlobalShortcuts: () => undefined,
}));
vi.mock("./lib/closeFlush", () => ({
  installCloseFlush: async () => () => undefined,
}));
// 队列 / 更新订阅在 jsdom 里没有处理器：给一个可卸载的空监听
vi.mock("@tauri-apps/api/event", () => ({
  listen: async () => () => undefined,
}));

import App from "./App";

beforeEach(() => {
  // 启动副作用与本次断言无关：settings 与列表都给空值，避免拼在 undefined 上的 then
  vi.spyOn(api, "getSetting").mockResolvedValue(null);
  vi.spyOn(api, "listProviders").mockResolvedValue({ providers: [] } as never);
  useAppStore.setState({
    view: "chat",
    canvasInline: true,
    editTarget: null,
    outpaintTarget: null,
    transformTarget: null,
    basicEditTarget: null,
    backgroundTarget: null,
    animationTarget: null,
    regionTarget: null,
    retouchTarget: null,
  });
});

describe("离开画布时的编辑目标清理", () => {
  it("内嵌修图 target 在切走画布后关闭，且不改写目标视图", () => {
    render(<App />);

    act(() => {
      useAppStore.getState().setView("canvas");
      useAppStore
        .getState()
        .openRetouch({ dataUrl: "d", embedded: true, returnView: "canvas" });
    });
    expect(useAppStore.getState().retouchTarget?.embedded).toBe(true);

    act(() => {
      useAppStore.getState().setView("chat");
    });
    expect(useAppStore.getState().retouchTarget).toBeNull();
    expect(useAppStore.getState().view).toBe("chat");
  });

  it("画布入口的浮层编辑同样在切走后关闭", () => {
    render(<App />);

    act(() => {
      useAppStore.getState().setView("canvas");
      useAppStore.getState().openEditor({
        historyId: 1,
        dataUrl: "d",
        prompt: "",
        mode: "erase",
        host: "canvas",
      });
    });
    expect(useAppStore.getState().editTarget).not.toBeNull();

    act(() => {
      useAppStore.getState().setView("gallery");
    });
    expect(useAppStore.getState().editTarget).toBeNull();
  });
});
