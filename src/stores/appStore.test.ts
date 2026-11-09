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
  });
});

describe("编辑入口", () => {
  it("打开任一入口都会关掉其余四个，保证同一时刻只有一个编辑实例", () => {
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
  });

  it("画布内嵌偏好只写 localStorage", () => {
    useAppStore.getState().setCanvasInline(false);
    expect(useAppStore.getState().canvasInline).toBe(false);
    expect(localStorage.getItem("moling.canvasInline")).toBe("off");
    useAppStore.getState().setCanvasInline(true);
    expect(localStorage.getItem("moling.canvasInline")).toBe("on");
  });
});
