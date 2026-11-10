import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "./ui/Tooltip";
import { useAppStore } from "../stores/appStore";
import { useCanvasStore } from "../stores/canvasStore";
import { useProviderStore } from "../stores/providerStore";
import { api } from "../lib/api";
import { toast } from "../lib/notify";

const { maskHandle } = vi.hoisted(() => ({
  maskHandle: {
    clear: vi.fn(),
    fillAll: vi.fn(),
    toAlphaPng: vi.fn(() => "data:image/png;base64,MASK"),
    toLumaPng: vi.fn(() => null),
    hasStrokes: vi.fn(() => true),
    applyMask: vi.fn(async () => undefined),
  },
}));

// 真实蒙版画布依赖 canvas 像素 API：测试里用只暴露句柄的替身
vi.mock("./MaskCanvas", async () => {
  const React = await import("react");
  return {
    default: React.forwardRef((_props: unknown, ref: React.Ref<unknown>) => {
      React.useImperativeHandle(ref, () => maskHandle);
      return null;
    }),
  };
});

vi.mock("../lib/notify", () => ({ toast: vi.fn() }));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getSetting: vi.fn(),
      segmentModelStatus: vi.fn(),
      readMediaImage: vi.fn(),
      saveCanvasLayerAsset: vi.fn(),
      regionEditBatch: vi.fn(),
      cancelGeneration: vi.fn(),
    },
  };
});

import RegionEditView from "./RegionEditView";

class FakeImage {
  naturalWidth = 400;
  naturalHeight = 300;
  onload: (() => void) | null = null;
  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

function region(index: number) {
  return {
    id: `r${index}`,
    prompt: `区域提示词 ${index}`,
    maskPath: `C:/media/m${index}.png`,
    feather: 24,
  };
}

function seed(regions: ReturnType<typeof region>[]) {
  useCanvasStore.setState({
    nodes: [
      {
        id: "n1",
        historyId: 100,
        x: 0,
        y: 0,
        width: 220,
        layers: [
          {
            id: "n1-base",
            kind: "image",
            historyId: 100,
            visible: true,
            opacity: 1,
            locked: true,
          },
        ],
        regions,
      },
    ],
    thumbs: {},
    gifIds: {},
  });
  useAppStore.setState({
    regionTarget: {
      nodeId: "n1",
      baseHistoryId: 100,
      dataUrl: "data:image/png;base64,AAAA",
    },
  });
}

function renderView() {
  return render(
    <TooltipProvider>
      <RegionEditView />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("Image", FakeImage);
  maskHandle.hasStrokes.mockReturnValue(true);
  useProviderStore.setState({
    defaultProviderId: 1,
    providers: [
      {
        provider: { id: 1, defaultModel: "gpt-image-1", kind: "openai" },
      },
    ] as never,
  });
  vi.mocked(api.getSetting).mockResolvedValue("off");
  vi.mocked(api.readMediaImage).mockResolvedValue({
    dataUrl: "data:image/png;base64,MMM",
  });
  vi.mocked(api.saveCanvasLayerAsset).mockResolvedValue({
    path: "C:/media/new.png",
  });
});

describe("RegionEditView", () => {
  it("待重绘区域超过一批时禁用提交并说明上限", () => {
    seed([region(1), region(2), region(3), region(4), region(5)]);
    renderView();

    const submit = screen.getByRole("button", {
      name: "一批最多 4 个区域",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it("没有笔画时不落盘区域蒙版", async () => {
    seed([]);
    maskHandle.hasStrokes.mockReturnValue(false);
    renderView();

    fireEvent.change(screen.getByPlaceholderText("该区域画什么"), {
      target: { value: "换成晚霞" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加区域" }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("请先涂抹区域并填写提示词", "error"),
    );
    expect(api.saveCanvasLayerAsset).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().nodes[0].regions).toHaveLength(0);
  });

  it("成功后把蒙版层与结果层追加到节点并标记区域", async () => {
    seed([region(1)]);
    vi.mocked(api.regionEditBatch).mockResolvedValue({
      groupId: "g1",
      results: [{ id: "r1", ok: true, historyId: 501 }],
      cancelled: false,
      anySucceeded: true,
      historyId: 900,
      dataUrl: "data:image/png;base64,OUT",
    });
    renderView();

    fireEvent.click(screen.getByRole("button", { name: "提交 1 个区域" }));
    fireEvent.click(await screen.findByRole("button", { name: "开始重绘" }));

    await waitFor(() => {
      const node = useCanvasStore.getState().nodes[0];
      expect(node.layers?.some((l) => l.historyId === 501)).toBe(true);
      expect(node.regions?.[0].appliedHistoryId).toBe(501);
    });
    const node = useCanvasStore.getState().nodes[0];
    const maskLayer = node.layers?.find(
      (l) => l.kind === "mask" && l.regionId === "r1",
    );
    const imageLayer = node.layers?.find(
      (l) => l.kind === "image" && l.historyId === 501,
    );
    expect(maskLayer?.path).toBe("C:/media/m1.png");
    expect(imageLayer?.maskLayerId).toBe(maskLayer?.id);
    expect(
      vi.mocked(api.regionEditBatch).mock.calls[0][0].regions[0],
    ).toMatchObject({ id: "r1", prompt: "区域提示词 1" });
  });

  it("整批失败时区域标记为失败且不追加图层", async () => {
    seed([region(1)]);
    vi.mocked(api.regionEditBatch).mockRejectedValue(new Error("network down"));
    renderView();

    fireEvent.click(screen.getByRole("button", { name: "提交 1 个区域" }));
    fireEvent.click(await screen.findByRole("button", { name: "开始重绘" }));

    expect(await screen.findByText("失败")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("network down");
    const node = useCanvasStore.getState().nodes[0];
    expect(node.layers).toHaveLength(1);
    expect(node.regions?.[0].appliedHistoryId).toBeUndefined();
  });
});
