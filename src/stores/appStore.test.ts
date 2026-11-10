import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./appStore";

const target = {
  historyId: 1,
  dataUrl: "data:image/png;base64,AA",
  prompt: "",
};

beforeEach(() => {
  useAppStore.setState({
    editTarget: null,
    outpaintTarget: null,
    transformTarget: null,
    basicEditTarget: null,
    backgroundTarget: null,
    animationTarget: null,
    regionTarget: null,
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
