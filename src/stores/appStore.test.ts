import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./appStore";

const target = {
  historyId: 1,
  dataUrl: "data:image/png;base64,AA",
  prompt: "",
};

beforeEach(() => {
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

describe("编辑入口", () => {
  it("打开任一入口都会关掉其余入口，保证同一时刻只有一个编辑实例", () => {
    const app = useAppStore.getState();
    app.openEditor({ ...target, mode: "inpaint" });
    app.openBackground(target);
    let state = useAppStore.getState();
    expect(state.editTarget).toBeNull();
    expect(state.backgroundTarget).toEqual(target);

    app.openTransform({ ...target, kind: "upscale" });
    state = useAppStore.getState();
    expect(state.backgroundTarget).toBeNull();
    expect(state.transformTarget?.kind).toBe("upscale");

    app.openAnimation({ historyId: 9 });
    state = useAppStore.getState();
    expect(state.transformTarget).toBeNull();
    expect(state.animationTarget).toEqual({ historyId: 9 });

    app.openBasicEdit(target);
    state = useAppStore.getState();
    expect(state.animationTarget).toBeNull();
    expect(state.basicEditTarget).toEqual(target);

    const regionTarget = {
      nodeId: "n1",
      baseHistoryId: 3,
      dataUrl: "data:image/png;base64,CC",
    };
    app.openRegionEdit(regionTarget);
    state = useAppStore.getState();
    expect(state.basicEditTarget).toBeNull();
    expect(state.regionTarget).toEqual(regionTarget);

    app.openEditor({ ...target, mode: "inpaint" });
    state = useAppStore.getState();
    expect(state.regionTarget).toBeNull();
    expect(state.editTarget?.mode).toBe("inpaint");
  });

  it("画布内嵌偏好只写 localStorage", () => {
    useAppStore.getState().setCanvasInline(false);
    expect(useAppStore.getState().canvasInline).toBe(false);
    expect(localStorage.getItem("moling.canvasInline")).toBe("off");
    useAppStore.getState().setCanvasInline(true);
    expect(localStorage.getItem("moling.canvasInline")).toBe("on");
  });
});

describe("修图台", () => {
  it("openRetouch 进入修图视图并关掉其余七个编辑入口", () => {
    const app = useAppStore.getState();
    app.openEditor({ ...target, mode: "inpaint" });
    app.openAnimation({ historyId: 9 });

    app.openRetouch({ dataUrl: "d" });
    const state = useAppStore.getState();
    expect(state.view).toBe("retouch");
    expect(state.retouchTarget).toEqual({ dataUrl: "d", embedded: false });
    expect(state.editTarget).toBeNull();
    expect(state.animationTarget).toBeNull();
    expect(state.outpaintTarget).toBeNull();
    expect(state.transformTarget).toBeNull();
    expect(state.basicEditTarget).toBeNull();
    expect(state.backgroundTarget).toBeNull();
    expect(state.regionTarget).toBeNull();
  });

  it("内嵌模式不改全局视图", () => {
    useAppStore.getState().setView("canvas");
    useAppStore.getState().openRetouch({ dataUrl: "d", embedded: true });
    const state = useAppStore.getState();
    expect(state.view).toBe("canvas");
    expect(state.retouchTarget?.embedded).toBe(true);
  });

  it("关掉内嵌偏好后，画布的内嵌请求退回全屏浮层", () => {
    const app = useAppStore.getState();
    app.setCanvasInline(false);
    app.setView("canvas");
    app.openRetouch({
      dataUrl: "d",
      canvasNodeId: "n1",
      embedded: true,
      returnView: "canvas",
    });
    const state = useAppStore.getState();
    // 全屏：视图切到 retouch，target 不再标记内嵌（否则 CanvasView 会就地渲染）
    expect(state.view).toBe("retouch");
    expect(state.retouchTarget?.embedded).toBe(false);
    expect(state.retouchTarget?.canvasNodeId).toBe("n1");

    useAppStore.getState().closeRetouch();
    // 非内嵌按 returnView 回退
    expect(useAppStore.getState().view).toBe("canvas");
  });

  it("内嵌偏好关闭时，画廊 / 聊天入口照常进全屏", () => {
    const app = useAppStore.getState();
    app.setCanvasInline(false);
    app.setView("gallery");
    app.openRetouch({ dataUrl: "d", returnView: "gallery" });
    expect(useAppStore.getState().view).toBe("retouch");
    expect(useAppStore.getState().retouchTarget?.embedded).toBe(false);
  });

  it("closeRetouch 回到 returnView，缺省回画廊", () => {
    const app = useAppStore.getState();
    app.openRetouch({ dataUrl: "d", returnView: "queue" });
    app.closeRetouch();
    expect(useAppStore.getState().view).toBe("queue");
    expect(useAppStore.getState().retouchTarget).toBeNull();

    app.openRetouch({ dataUrl: "d" });
    app.closeRetouch();
    expect(useAppStore.getState().view).toBe("gallery");
  });

  it("打开任一旧浮层都会清掉残留的修图 target", () => {
    const app = useAppStore.getState();
    const opens: Array<() => void> = [
      () => app.openEditor({ ...target, mode: "inpaint" }),
      () => app.openOutpaint(target),
      () => app.openTransform({ ...target, kind: "upscale" }),
      () => app.openBasicEdit(target),
      () => app.openBackground(target),
      () => app.openAnimation({ historyId: 9 }),
      () =>
        app.openRegionEdit({
          nodeId: "n1",
          baseHistoryId: 3,
          dataUrl: "d",
        }),
    ];
    for (const open of opens) {
      app.openRetouch({ dataUrl: "d" });
      expect(useAppStore.getState().retouchTarget).not.toBeNull();
      open();
      expect(useAppStore.getState().retouchTarget).toBeNull();
    }
  });

  it("closeRetouch 在内嵌模式只清 target，不动视图", () => {
    const app = useAppStore.getState();
    app.setView("canvas");
    app.openRetouch({ dataUrl: "d", embedded: true, returnView: "gallery" });
    app.closeRetouch();
    expect(useAppStore.getState().view).toBe("canvas");
    expect(useAppStore.getState().retouchTarget).toBeNull();
  });
});
