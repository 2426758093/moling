import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../ui/Tooltip";
import { useAppStore } from "../../stores/appStore";
import { useProviderStore } from "../../stores/providerStore";
import { api } from "../../lib/api";

interface FakeMask {
  /** 模拟「已经涂过」的画布：新建即带笔画，只有 clear() 才归零 */
  strokes: boolean;
  clear: () => void;
  fillAll: () => void;
  toAlphaPng: () => string | null;
  toLumaPng: () => string | null;
  hasStrokes: () => boolean;
  applyMask: () => Promise<void>;
}

const { maskHandles, deliverSpy, historySpy, cropPreviewSpy, unlistenSpy } =
  vi.hoisted(() => ({
    maskHandles: [] as FakeMask[],
    deliverSpy: vi.fn(),
    historySpy: vi.fn(),
    cropPreviewSpy: vi.fn(),
    unlistenSpy: vi.fn(),
  }));

// 回写单独测：这里只关心「提交成功后有没有带着 nodeId 调回写」，画布规则在
// deliverEditResult.test.ts 里覆盖。
vi.mock("../../lib/deliverEditResult", () => ({
  deliverEditResult: deliverSpy,
}));

// 画布层依赖 canvas 像素 API（jsdom 没有）：裁剪预览直接给固定 data URL，
// 扩图垫图也只需要一个不会抛的替身。
vi.mock("../../lib/retouchCanvas", () => ({
  padImageToSize: vi.fn(),
  renderCropPreview: cropPreviewSpy,
}));

// 历史变更广播：画廊靠它刷新，每步提交后都必须发一次
vi.mock("../../lib/historyEvents", () => ({
  emitHistoryChanged: historySpy,
}));

// 多区域提交要订阅后端进度事件：jsdom 里没有 Tauri 事件总线，
// 返回一个可断言的 unlisten（提交结束必须就地释放，不能攒监听器）
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(unlistenSpy),
}));

// 真实画布依赖 canvas 像素 API（jsdom 没有）：用按实例记录笔画的替身，
// 这样「换步后是不是还挂着一块带旧笔画的画布」可以被断言。
vi.mock("../MaskCanvas", async () => {
  const React = await import("react");
  const MaskCanvasStub = React.forwardRef(
    (_props: unknown, ref: React.Ref<unknown>) => {
      const handleRef = React.useRef<FakeMask | null>(null);
      if (!handleRef.current) {
        const handle: FakeMask = {
          strokes: true,
          clear: () => {
            handle.strokes = false;
          },
          fillAll: () => undefined,
          toAlphaPng: () => "data:image/png;base64,MASK",
          toLumaPng: () => "data:image/png;base64,LUMA",
          hasStrokes: () => handle.strokes,
          applyMask: async () => undefined,
        };
        handleRef.current = handle;
        maskHandles.push(handle);
      }
      const handle = handleRef.current;
      React.useImperativeHandle(ref, () => handle as never, [handle]);
      return null;
    },
  );
  MaskCanvasStub.displayName = "MaskCanvasStub";
  return { default: MaskCanvasStub };
});

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      retouchAnalyze: vi.fn(),
      applyRetouch: vi.fn(),
      editImage: vi.fn(),
      previewRetouch: vi.fn(),
      getModelCaps: vi.fn(),
      historyLineage: vi.fn(),
      getHistoryImage: vi.fn(),
      batchHistoryThumbs: vi.fn(),
      replaceBackground: vi.fn(),
      transformImage: vi.fn(),
      applyEdit: vi.fn(),
      recoverImageRequestByClient: vi.fn(),
      getSetting: vi.fn(),
      segmentModelStatus: vi.fn(),
      segmentSubject: vi.fn(),
      regionEditBatch: vi.fn(),
      cancelGeneration: vi.fn(),
    },
  };
});

// jsdom 不解码图片：`new Image()` 永远不会触发 onload，尺寸测量会白等 5s。
// 这里给一个立刻「加载完成」的替身（与 RegionEditView 的用例同一手法）。
class FakeImage {
  naturalWidth = 400;
  naturalHeight = 300;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

import RetouchView from "./RetouchView";
import { listen } from "@tauri-apps/api/event";
import { GUARD_SUFFIX } from "../../lib/retouchPrompts";
import { resetPendingBilling } from "../../lib/retouchBilling";

const ANALYSIS = {
  exposureEv: 0.2,
  wbCast: 0,
  contrast: 0.1,
  saturation: 0.2,
  sharpness: 0.3,
  skinRatio: 0,
  clipLow: 0,
  clipHigh: 0,
  meanLuma: 0.5,
  suggestions: [],
};

/** 历史血统的一行：后端返回的裸历史行，只要断言用得到的字段 */
function lineageRow(id: number, op: string, parentId: number | null) {
  return {
    id,
    prompt: "",
    model: "gpt-image-1",
    width: 400,
    height: 300,
    filePath: `C:/media/${id}.png`,
    parentId,
    op,
    createdAt: "",
  };
}

/** 步骤条按钮名就是「序号. 文案」，按名字能同时断言顺序与数量 */
function stepLabels() {
  return screen
    .queryAllByRole("button", { name: /^\d+\. / })
    .map((el) => el.getAttribute("aria-label"));
}

/** 一次未确认失败：gateway 超时但可能已在服务商侧出图 */
function unconfirmed(requestId: string | null = "req_1") {
  return new Error(
    JSON.stringify({
      type: "unconfirmed",
      message: "gateway timeout",
      request_id: requestId ?? undefined,
    }),
  );
}

beforeEach(() => {
  vi.stubGlobal("Image", FakeImage);
  // 挂起标记是模块级单例（要跨「关掉修图台再打开」存活），用例之间必须清零
  resetPendingBilling();
  maskHandles.length = 0;
  deliverSpy.mockReset();
  deliverSpy.mockResolvedValue("canvas");
  historySpy.mockReset();
  useAppStore.setState({
    mode: "simple",
    retouchTarget: {
      dataUrl: "data:image/png;base64,SRC",
      historyId: 7,
      width: 400,
      height: 300,
      title: "a.png",
    },
  });
  useProviderStore.setState({
    defaultProviderId: 1,
    providers: [
      {
        provider: { id: 1, defaultModel: "gpt-image-1", kind: "openai" },
      },
    ] as never,
  });
  vi.mocked(api.retouchAnalyze).mockResolvedValue(ANALYSIS);
  vi.mocked(api.getModelCaps).mockResolvedValue({
    "gpt-image-1": {
      negative: true,
      edit: true,
      instructionEdit: true,
      transform: true,
      maxSide: 1024,
      multiImage: true,
      gif: false,
      gifMaxFrames: 16,
    },
  });
  vi.mocked(api.applyRetouch).mockResolvedValue({
    historyId: 8,
    dataUrl: "data:image/png;base64,NEXT",
    filePath: "C:/media/next.png",
    width: 400,
    height: 300,
    op: "autoEnhance",
    parentId: 7,
  });
  // 默认没有血统（单条）：既有用例保持「一进来只有原图一步」
  vi.mocked(api.historyLineage).mockResolvedValue([
    lineageRow(7, "paste", null),
  ]);
  // 还原时先批量取缩略图；只有当前步与对比左图会另读全图
  vi.mocked(api.batchHistoryThumbs).mockImplementation(async (ids: number[]) =>
    ids.map((id) => ({
      historyId: id,
      thumbUrl: `data:image/png;base64,THUMB${id}`,
    })),
  );
  vi.mocked(api.getHistoryImage).mockImplementation(async (id: number) => ({
    historyId: id,
    dataUrl: `data:image/png;base64,IMG${id}`,
    filePath: `C:/media/${id}.png`,
  }));
  vi.mocked(api.getSetting).mockResolvedValue("off");
  vi.mocked(api.segmentModelStatus).mockResolvedValue({
    available: false,
    loaded: false,
    reason: null,
  });
  vi.mocked(api.segmentSubject).mockResolvedValue({
    dataUrl: "data:image/png;base64,SEG",
    width: 400,
    height: 300,
    covered: 0.4,
  });
  vi.mocked(api.editImage).mockReset();
  vi.mocked(api.replaceBackground).mockReset();
  vi.mocked(api.replaceBackground).mockResolvedValue({
    historyId: 9,
    dataUrl: "data:image/png;base64,BG",
    filePath: "C:/media/bg.png",
    width: 400,
    height: 300,
    op: "background",
    parentId: 7,
  });
  vi.mocked(api.transformImage).mockReset();
  vi.mocked(api.transformImage).mockResolvedValue({
    historyId: 10,
    dataUrl: "data:image/png;base64,UP",
    filePath: "C:/media/up.png",
    width: 800,
    height: 600,
    op: "upscale",
    parentId: 7,
  });
  vi.mocked(api.recoverImageRequestByClient).mockReset();
  vi.mocked(api.recoverImageRequestByClient).mockResolvedValue({
    recovered: 1,
    failed: 0,
  });
  vi.mocked(api.applyEdit).mockReset();
  vi.mocked(api.applyEdit).mockResolvedValue({
    historyId: 20,
    dataUrl: "data:image/png;base64,CROP",
    filePath: "C:/media/crop.png",
    width: 300,
    height: 300,
    op: "basic-edit",
    parentId: 7,
  });
  cropPreviewSpy.mockClear();
  cropPreviewSpy.mockResolvedValue("data:image/png;base64,CROPPREVIEW");
  vi.mocked(api.regionEditBatch).mockReset();
  vi.mocked(api.regionEditBatch).mockResolvedValue({
    groupId: "g",
    results: [
      {
        id: "r1",
        ok: true,
        historyId: 9,
        dataUrl: "data:image/png;base64,REGION",
        filePath: "C:/media/region.png",
      },
    ],
    cancelled: false,
    anySucceeded: true,
    historyId: 9,
    dataUrl: "data:image/png;base64,REGION",
  });
  vi.mocked(api.cancelGeneration).mockReset();
  vi.mocked(api.cancelGeneration).mockResolvedValue(undefined);
  // 事件订阅的调用次数与 unlisten 都是「每次提交一条」的契约：用例间清零
  vi.mocked(listen).mockClear();
  unlistenSpy.mockClear();
});

function renderStudio() {
  return render(
    <TooltipProvider>
      <RetouchView />
    </TooltipProvider>,
  );
}

describe("RetouchStudio 蒙版与步骤", () => {
  it("消除面板开着时回看别的步骤，蒙版立刻清空（hasStrokes() 为 false）", async () => {
    renderStudio();

    // 先造出第二步，才有「面板开着 + 换步」的组合
    fireEvent.click(screen.getByRole("button", { name: "一键优化" }));
    await screen.findByRole("button", { name: "2. 一键优化" });

    fireEvent.click(screen.getByRole("button", { name: "AI 消除" }));
    await waitFor(() => expect(maskHandles).toHaveLength(1));
    expect(maskHandles[0].hasStrokes()).toBe(true);

    // 回到第 1 步：画布必须重建（旧画布是旧图尺寸），新画布不能带旧笔画
    fireEvent.click(screen.getByRole("button", { name: "1. 原图" }));

    await waitFor(() => expect(maskHandles.length).toBeGreaterThan(1));
    const active = maskHandles[maskHandles.length - 1];
    expect(active.hasStrokes()).toBe(false);
  });
});

/** 手动控制 resolve 的 Promise：用来制造「先发后回」的乱序响应 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("RetouchStudio 专家预览", () => {
  it("旧预览晚回来时被丢弃，最终只显示最后一次的结果", async () => {
    vi.useFakeTimers();
    try {
      useAppStore.setState({ mode: "expert" });
      const first = deferred<{
        dataUrl: string;
        width: number;
        height: number;
      }>();
      const second = deferred<{
        dataUrl: string;
        width: number;
        height: number;
      }>();
      vi.mocked(api.previewRetouch)
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      renderStudio();

      // 专家模式下点动作只是开面板，拖滑杆才触发防抖预览
      fireEvent.click(screen.getByRole("button", { name: "一键优化" }));
      const slider = screen.getByRole("slider");

      // 第一次调整：等防抖到点，请求 #1 已在路上
      fireEvent.keyDown(slider, { key: "ArrowLeft" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(api.previewRetouch).toHaveBeenCalledTimes(1);

      // 第二次调整：请求 #2 晚于 #1 发出
      fireEvent.keyDown(slider, { key: "ArrowLeft" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(api.previewRetouch).toHaveBeenCalledTimes(2);

      // 后发的先回：舞台立刻显示它
      await act(async () => {
        second.resolve({
          dataUrl: "data:image/png;base64,PREVIEW_NEW",
          width: 1024,
          height: 768,
        });
      });
      expect(screen.getByAltText("a.png").getAttribute("src")).toBe(
        "data:image/png;base64,PREVIEW_NEW",
      );

      // 先发的后回：令牌已过期，必须被丢弃
      await act(async () => {
        first.resolve({
          dataUrl: "data:image/png;base64,PREVIEW_OLD",
          width: 1024,
          height: 768,
        });
      });
      expect(screen.getByAltText("a.png").getAttribute("src")).toBe(
        "data:image/png;base64,PREVIEW_NEW",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RetouchStudio 步骤条门禁", () => {
  it("提交进行中不能换步：busy 时点缩略图不改变当前步", async () => {
    renderStudio();

    // 第一步先正常提交，步骤条上出现两格
    fireEvent.click(screen.getByRole("button", { name: "一键优化" }));
    await screen.findByRole("button", { name: "2. 一键优化" });

    // 第二次提交挂起，保持 busy
    let release!: (value: unknown) => void;
    vi.mocked(api.applyRetouch).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }) as never,
    );
    fireEvent.click(screen.getByRole("button", { name: "美颜" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "1. 原图" })
          .hasAttribute("disabled"),
      ).toBe(true),
    );

    fireEvent.click(screen.getByRole("button", { name: "1. 原图" }));
    // 仍然停在第二步
    expect(
      screen
        .getByRole("button", { name: "2. 一键优化" })
        .getAttribute("aria-current"),
    ).toBe("step");

    await act(async () => {
      release({
        historyId: 9,
        dataUrl: "data:image/png;base64,BEAUTY",
        filePath: "C:/media/beauty.png",
        width: 400,
        height: 300,
        op: "beauty",
        parentId: 7,
      });
    });
    // 释放后恢复可点
    expect(
      screen.getByRole("button", { name: "1. 原图" }).hasAttribute("disabled"),
    ).toBe(false);
  });
});

describe("RetouchStudio 画布回写", () => {
  it("画布来源提交后带着 nodeId 与源尺寸回写", async () => {
    useAppStore.setState({
      retouchTarget: {
        dataUrl: "data:image/png;base64,SRC",
        historyId: 7,
        width: 400,
        height: 300,
        canvasNodeId: "n1",
        embedded: true,
      },
    });
    renderStudio();

    fireEvent.click(screen.getByRole("button", { name: "一键优化" }));
    await screen.findByRole("button", { name: "2. 一键优化" });

    await waitFor(() => expect(deliverSpy).toHaveBeenCalledTimes(1));
    expect(deliverSpy).toHaveBeenCalledWith(
      {
        historyId: 7,
        nodeId: "n1",
        host: "canvas",
        width: 400,
        height: 300,
      },
      expect.objectContaining({ historyId: 8, width: 400, height: 300 }),
      "一键优化",
    );
    // 内嵌/独立同一个口径：每步提交后都要广播历史变更
    expect(historySpy).toHaveBeenCalledTimes(1);
  });

  it("回写失败只提示，步骤仍然保留", async () => {
    deliverSpy.mockRejectedValueOnce(new Error("disk full"));
    useAppStore.setState({
      retouchTarget: {
        dataUrl: "data:image/png;base64,SRC",
        historyId: 7,
        canvasNodeId: "n1",
        embedded: true,
      },
    });
    renderStudio();

    fireEvent.click(screen.getByRole("button", { name: "一键优化" }));
    await screen.findByRole("button", { name: "2. 一键优化" });
    expect(screen.getByRole("button", { name: "2. 一键优化" })).toBeTruthy();
  });

  it("源尺寸未知（0×0）时不把宽高传给回写", async () => {
    // 自动尺寸记录：0×0 必须当「未知」，不能参与同尺寸成层判定
    useAppStore.setState({
      retouchTarget: {
        dataUrl: "data:image/png;base64,SRC",
        historyId: 7,
        width: 0,
        height: 0,
        canvasNodeId: "n1",
        embedded: true,
      },
    });
    renderStudio();

    fireEvent.click(screen.getByRole("button", { name: "一键优化" }));
    await waitFor(() => expect(deliverSpy).toHaveBeenCalledTimes(1));

    const [source] = deliverSpy.mock.calls[0];
    expect(source).not.toHaveProperty("width");
    expect(source).not.toHaveProperty("height");
    expect(source.nodeId).toBe("n1");
  });

  it("每步提交成功后广播历史变更，画廊才能刷新", async () => {
    renderStudio();

    fireEvent.click(screen.getByRole("button", { name: "一键优化" }));
    await screen.findByRole("button", { name: "2. 一键优化" });

    expect(historySpy).toHaveBeenCalledTimes(1);
  });
});

describe("RetouchStudio 内嵌一致性", () => {
  it("内嵌模式的计费保护与独立模式同一口径", async () => {
    // 从画布进入：带 nodeId + embedded，行为与入口无关
    useAppStore.setState({
      retouchTarget: {
        dataUrl: "data:image/png;base64,SRC",
        historyId: 7,
        canvasNodeId: "n1",
        embedded: true,
      },
    });
    vi.mocked(api.editImage)
      .mockRejectedValueOnce(unconfirmed())
      .mockResolvedValueOnce({
        historyId: 12,
        dataUrl: "data:image/png;base64,FIX",
        filePath: "C:/media/fix.png",
        op: "erase",
      });
    renderStudio();

    fireEvent.click(screen.getByRole("button", { name: "AI 消除" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认消除" }));
    await screen.findByText("请求 ID：req_1");

    // 关掉提示条只是不显示：拦截仍在，再提交必须先确认
    fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
    await waitFor(() =>
      expect(screen.queryByText("请求 ID：req_1")).toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认消除" }));
    await screen.findByText("确认重新生成？");
    expect(api.editImage).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "仍然重新生成" }));
    await waitFor(() => expect(api.editImage).toHaveBeenCalledTimes(2));
  });
});

describe("RetouchStudio 重开后还原步骤链", () => {
  it("血统 3 条时还原成 3 步、顺序正确、停在最后一步，并从这一步继续延伸", async () => {
    vi.mocked(api.historyLineage).mockResolvedValue([
      lineageRow(4, "paste", null),
      lineageRow(5, "auto-enhance", 4),
      lineageRow(6, "erase", 5),
    ]);
    renderStudio();

    await screen.findByRole("button", { name: "3. AI 消除" });
    expect(stepLabels()).toEqual(["1. 原图", "2. 一键优化", "3. AI 消除"]);
    // 缩略图一次批量取，顺序就是 root→current
    expect(api.batchHistoryThumbs).toHaveBeenCalledWith([4, 5, 6]);
    // 全图只读两张：当前步（提交要用）+ 对比左图（首帧）
    await waitFor(() =>
      expect(
        vi
          .mocked(api.getHistoryImage)
          .mock.calls.map(([id]) => id)
          .sort(),
      ).toEqual([4, 6]),
    );
    const steps = screen.getAllByRole("button", { name: /^\d+\. / });
    expect(steps[2].getAttribute("aria-current")).toBe("step");

    // 新提交以当前步为父节点：链继续延伸，而不是接回打开时那张图
    fireEvent.click(screen.getByRole("button", { name: "一键优化" }));
    await screen.findByRole("button", { name: "4. 一键优化" });
    expect(api.applyRetouch).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: 6 }),
    );
  });

  it("中间步只带缩略图：勾选时才懒加载全图，并且只请求一次", async () => {
    vi.mocked(api.historyLineage).mockResolvedValue([
      lineageRow(4, "paste", null),
      lineageRow(5, "auto-enhance", 4),
      lineageRow(6, "erase", 5),
    ]);
    renderStudio();

    await screen.findByRole("button", { name: "3. AI 消除" });
    // 还原阶段不该读过中间步的全图
    expect(
      vi.mocked(api.getHistoryImage).mock.calls.map(([id]) => id),
    ).not.toContain(5);
    // 步骤条用的是缩略图（dataUrl 为空但 thumbUrl 有值，不会走缺图占位）
    const thumbs = screen
      .getAllByRole("img")
      .map((el) => el.getAttribute("src"));
    expect(thumbs).toContain("data:image/png;base64,THUMB5");

    // 勾选中间步：舞台先显示缩略图，随后后台补全图
    fireEvent.click(screen.getByRole("button", { name: "2. 一键优化" }));
    await waitFor(() =>
      expect(screen.getByAltText("a.png").getAttribute("src")).toBe(
        "data:image/png;base64,IMG5",
      ),
    );
    expect(
      vi.mocked(api.getHistoryImage).mock.calls.filter(([id]) => id === 5),
    ).toHaveLength(1);
  });

  it("血统只有 1 条时不新增步骤", async () => {
    renderStudio();

    await waitFor(() => expect(api.historyLineage).toHaveBeenCalledWith(7));
    expect(api.getHistoryImage).not.toHaveBeenCalled();
    expect(api.batchHistoryThumbs).not.toHaveBeenCalled();
    expect(stepLabels()).toEqual(["1. 原图"]);
  });

  it("13 条时只保留最后 12 条，且最后一条是当前记录", async () => {
    const rows = Array.from({ length: 13 }, (_, index) =>
      lineageRow(
        100 + index,
        index === 0 ? "paste" : index % 2 === 0 ? "beauty" : "auto-enhance",
        index === 0 ? null : 99 + index,
      ),
    );
    vi.mocked(api.historyLineage).mockResolvedValue(rows);
    renderStudio();

    await screen.findByRole("button", { name: "12. 美颜" });
    const labels = stepLabels();
    expect(labels).toHaveLength(12);
    // 真正的原图被截掉了，第一格按自身 op 命名，不能谎称「原图」
    expect(labels[0]).toBe("1. 一键优化");
    // 末条就是当前记录（id 112，op=beauty）
    expect(labels[11]).toBe("12. 美颜");
    // 缩略图只批量取保留的 12 条（101…112）
    expect(api.batchHistoryThumbs).toHaveBeenCalledWith(
      rows.slice(1).map((row) => row.id),
    );
    // 全图只有当前步 112 与对比左图 101
    await waitFor(() =>
      expect(
        vi
          .mocked(api.getHistoryImage)
          .mock.calls.map(([id]) => id)
          .sort((a, b) => a - b),
      ).toEqual([101, 112]),
    );
    const steps = screen.getAllByRole("button", { name: /^\d+\. / });
    expect(steps[11].getAttribute("aria-current")).toBe("step");
  });

  it("historyLineage 失败时保持单步原图，不崩", async () => {
    vi.mocked(api.historyLineage).mockRejectedValue(new Error("db locked"));
    renderStudio();

    await waitFor(() => expect(api.historyLineage).toHaveBeenCalledTimes(1));
    expect(stepLabels()).toEqual(["1. 原图"]);
    expect(screen.getByRole("button", { name: "一键优化" })).toBeTruthy();
  });

  it("缩略图缺失且读图失败时只丢那一步，其余照常还原", async () => {
    vi.mocked(api.historyLineage).mockResolvedValue([
      lineageRow(4, "paste", null),
      lineageRow(5, "auto-enhance", 4),
      lineageRow(6, "retouch", 5),
    ]);
    // 第 5 条既没有缩略图，读全图也失败 → 只能丢它
    vi.mocked(api.batchHistoryThumbs).mockImplementation(
      async (ids: number[]) =>
        ids
          .filter((id) => id !== 5)
          .map((id) => ({
            historyId: id,
            thumbUrl: `data:image/png;base64,THUMB${id}`,
          })),
    );
    vi.mocked(api.getHistoryImage).mockImplementation(async (id: number) => {
      if (id === 5) throw new Error("file missing");
      return {
        historyId: id,
        dataUrl: `data:image/png;base64,IMG${id}`,
        filePath: `C:/media/${id}.png`,
      };
    });
    renderStudio();

    await screen.findByRole("button", { name: "2. 一句话改图" });
    expect(stepLabels()).toEqual(["1. 原图", "2. 一句话改图"]);
  });
});

describe("RetouchStudio 动作 Chip 按模式过滤", () => {
  const SIMPLE_CHIPS = [
    "一键优化",
    "美颜",
    "AI 消除",
    "一句话改图",
    "换背景",
    "高清",
  ];
  const EXPERT_CHIPS = ["扩图", "裁剪调色", "风格", "局部重绘", "多区域"];

  /** 按 DOM 顺序收集动作 Chip：步骤条按钮名带序号，不会混进来 */
  function chipOrder() {
    const all = [...SIMPLE_CHIPS, ...EXPERT_CHIPS];
    return screen
      .getAllByRole("button")
      .map((el) => (el.textContent ?? "").trim())
      .filter((text) => all.includes(text));
  }

  it("简单模式恰好 6 个 Chip 且顺序与动作表一致，专家模式补在末尾", () => {
    renderStudio();

    // 顺序也是契约：动作表改了顺序，这里必须一起改
    expect(chipOrder()).toEqual(SIMPLE_CHIPS);
    for (const label of EXPERT_CHIPS) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }

    act(() => useAppStore.setState({ mode: "expert" }));
    expect(chipOrder()).toEqual([...SIMPLE_CHIPS, ...EXPERT_CHIPS]);
  });

  it("云端 Chip 带计费信号：高清 title 是「云端计费」，本地动作没有", () => {
    renderStudio();

    // 高清 与两个免费动作并排时不看图标分不出会扣费，title 是最轻的提示位
    expect(
      screen.getByRole("button", { name: "高清" }).getAttribute("title"),
    ).toBe("云端计费");
    expect(
      screen.getByRole("button", { name: "一键优化" }).getAttribute("title"),
    ).toBeNull();
    // 纯色 / 渐变是本地合成：与 cloud:false 一致，不该有计费信号
    expect(
      screen.getByRole("button", { name: "换背景" }).getAttribute("title"),
    ).toBeNull();
  });
});

describe("RetouchStudio 换背景", () => {
  it("纯色换背景：参数带 luma 蒙版、无服务商，并落成一步", async () => {
    renderStudio();

    fireEvent.click(screen.getByRole("button", { name: "换背景" }));
    fireEvent.click(await screen.findByRole("button", { name: "应用换背景" }));

    await screen.findByRole("button", { name: "2. 换背景" });
    expect(api.replaceBackground).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "solid",
        maskB64: "data:image/png;base64,LUMA",
        providerId: null,
        prompt: "",
      }),
    );
    expect(historySpy).toHaveBeenCalledTimes(1);
  });

  it("AI 描述缺服务商时禁用提交并说明原因，纯色仍可提交", async () => {
    useProviderStore.setState({ defaultProviderId: null, providers: [] });
    renderStudio();

    fireEvent.click(screen.getByRole("button", { name: "换背景" }));
    fireEvent.click(await screen.findByRole("radio", { name: "AI 描述" }));

    expect(
      (
        screen.getByRole("button", {
          name: "应用换背景",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText("请先在设置中配置服务商")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "纯色" }));
    expect(
      (
        screen.getByRole("button", {
          name: "应用换背景",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("离线时 AI 描述同样禁用（要发服务商请求），纯色本地方案不受影响", async () => {
    renderStudio();
    // 先挂载再切离线：组件只在挂载后监听 online / offline
    act(() => window.dispatchEvent(new Event("offline")));

    fireEvent.click(screen.getByRole("button", { name: "换背景" }));
    fireEvent.click(await screen.findByRole("radio", { name: "AI 描述" }));
    // 描述写了也没用：离线这一条优先于其余条件
    fireEvent.change(screen.getByLabelText("背景描述"), {
      target: { value: "星空下的霓虹城市" },
    });

    expect(
      (
        screen.getByRole("button", {
          name: "应用换背景",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText("当前离线")).toBeTruthy();
    expect(api.replaceBackground).not.toHaveBeenCalled();

    // 恢复在线后 AI 才重新可提交
    act(() => window.dispatchEvent(new Event("online")));
    expect(
      (
        screen.getByRole("button", {
          name: "应用换背景",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("蒙版为空时不发请求、不弹计费确认，只提示先涂抹", async () => {
    renderStudio();

    fireEvent.click(screen.getByRole("button", { name: "换背景" }));
    // 替身画布默认带笔画，清除后 hasStrokes() 归零
    fireEvent.click(await screen.findByRole("button", { name: "清除蒙版" }));
    fireEvent.click(screen.getByRole("button", { name: "应用换背景" }));

    expect(api.replaceBackground).not.toHaveBeenCalled();
    // toast 走 portal 挂在 body 上、且同文案去重是异步移除，断言「存在」而非唯一
    expect(
      screen.getAllByText("请先涂抹要替换的背景区域").length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("确认重新生成？")).toBeNull();
  });

  it("换面板时清空上一块蒙版：消除涂的笔画不会被当成背景蒙版", async () => {
    renderStudio();

    fireEvent.click(screen.getByRole("button", { name: "AI 消除" }));
    await waitFor(() => expect(maskHandles).toHaveLength(1));
    expect(maskHandles[0].hasStrokes()).toBe(true);

    // 同一个 src 下画布不重建，只能靠面板切换时的显式清理
    fireEvent.click(screen.getByRole("button", { name: "换背景" }));
    await waitFor(() => expect(maskHandles[0].hasStrokes()).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: "应用换背景" }));
    expect(api.replaceBackground).not.toHaveBeenCalled();
    expect(
      screen.getAllByText("请先涂抹要替换的背景区域").length,
    ).toBeGreaterThan(0);
  });
});

describe("RetouchStudio 未确认计费保护", () => {
  it("未确认要先对账；再次提交必须经确认才发第二次请求", async () => {
    vi.mocked(api.editImage)
      .mockRejectedValueOnce(unconfirmed())
      .mockResolvedValueOnce({
        historyId: 12,
        dataUrl: "data:image/png;base64,FIX",
        filePath: "C:/media/fix.png",
        op: "erase",
      });
    renderStudio();

    fireEvent.click(screen.getByRole("button", { name: "AI 消除" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认消除" }));

    await screen.findByText("请求 ID：req_1");
    expect(screen.getByText("可能已计费，重试会再次扣费")).toBeTruthy();
    expect(screen.getByRole("button", { name: "尝试恢复" })).toBeTruthy();

    // 再点一次：只弹确认框，绝不自动重发
    fireEvent.click(screen.getByRole("button", { name: "确认消除" }));
    await screen.findByText("确认重新生成？");
    expect(api.editImage).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "仍然重新生成" }));
    await waitFor(() => expect(api.editImage).toHaveBeenCalledTimes(2));
  });

  it("关闭提示条不会解除拦截：再次提交仍然要确认才发请求", async () => {
    vi.mocked(api.editImage)
      .mockRejectedValueOnce(unconfirmed())
      .mockResolvedValueOnce({
        historyId: 12,
        dataUrl: "data:image/png;base64,FIX",
        filePath: "C:/media/fix.png",
        op: "erase",
      });
    renderStudio();

    fireEvent.click(screen.getByRole("button", { name: "AI 消除" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认消除" }));
    await screen.findByText("请求 ID：req_1");

    // 关掉提示条：只是不再显示，计费风险还没对账
    fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
    await waitFor(() =>
      expect(screen.queryByText("请求 ID：req_1")).toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: "确认消除" }));
    await screen.findByText("确认重新生成？");
    expect(api.editImage).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "仍然重新生成" }));
    await waitFor(() => expect(api.editImage).toHaveBeenCalledTimes(2));
  });

  it("本地动作成功不清除拦截：一键优化成功后再次消除仍要确认", async () => {
    vi.mocked(api.editImage)
      .mockRejectedValueOnce(unconfirmed())
      .mockResolvedValueOnce({
        historyId: 12,
        dataUrl: "data:image/png;base64,FIX",
        filePath: "C:/media/fix.png",
        op: "erase",
      });
    renderStudio();

    fireEvent.click(screen.getByRole("button", { name: "AI 消除" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认消除" }));
    await screen.findByText("请求 ID：req_1");

    // 关掉提示条：拦截依据是挂起标记，不是提示条
    fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
    await waitFor(() =>
      expect(screen.queryByText("请求 ID：req_1")).toBeNull(),
    );

    // 本地动作（不扣费）成功：只能清报错条，不能清掉还没对账的计费风险
    fireEvent.click(screen.getByRole("button", { name: "一键优化" }));
    await waitFor(() => expect(api.applyRetouch).toHaveBeenCalledTimes(1));
    expect(historySpy).toHaveBeenCalled();

    // 简单模式点动作会自动收起面板，回来再打开消除（画布已重建为新蒙版）
    fireEvent.click(screen.getByRole("button", { name: "AI 消除" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认消除" }));
    await screen.findByText("确认重新生成？");
    expect(api.editImage).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "仍然重新生成" }));
    await waitFor(() => expect(api.editImage).toHaveBeenCalledTimes(2));
  });

  it("本地裁剪不受未确认拦截：不弹确认、直接 applyEdit 落成一步", async () => {
    vi.mocked(api.editImage).mockRejectedValueOnce(unconfirmed());
    renderStudio();

    // 先制造一次未确认失败，再关掉提示条（挂起标记仍留着）
    fireEvent.click(screen.getByRole("button", { name: "AI 消除" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认消除" }));
    await screen.findByText("请求 ID：req_1");
    fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
    await waitFor(() =>
      expect(screen.queryByText("请求 ID：req_1")).toBeNull(),
    );

    // 专家模式的裁剪调色是纯本地像素运算：永不计费，也就不该被云端标记拦住
    act(() => useAppStore.setState({ mode: "expert" }));
    fireEvent.click(screen.getByRole("button", { name: "裁剪调色" }));
    await screen.findByText("输出 400 × 300");
    fireEvent.click(screen.getByRole("radio", { name: "1:1" }));
    await screen.findByText("输出 300 × 300");

    const apply = screen.getByRole("button", { name: "应用裁剪" });
    await waitFor(() => expect(apply.hasAttribute("disabled")).toBe(false));
    fireEvent.click(apply);

    // 关键回归：不得出现计费确认，且直接发本地请求
    expect(screen.queryByText("确认重新生成？")).toBeNull();
    await waitFor(() => expect(api.applyEdit).toHaveBeenCalledTimes(1));
    await screen.findByRole("button", { name: "2. 裁剪调色" });
    expect(api.editImage).toHaveBeenCalledTimes(1);
  });

  it("尝试恢复按请求 ID 对账，成功后提示条消失", async () => {
    vi.mocked(api.editImage).mockRejectedValueOnce(unconfirmed());
    renderStudio();

    fireEvent.click(screen.getByRole("button", { name: "AI 消除" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认消除" }));
    await screen.findByText("请求 ID：req_1");

    fireEvent.click(screen.getByRole("button", { name: "尝试恢复" }));
    await waitFor(() =>
      expect(api.recoverImageRequestByClient).toHaveBeenCalledWith("req_1"),
    );
    await waitFor(() =>
      expect(screen.queryByText("请求 ID：req_1")).toBeNull(),
    );
  });

  it("恢复成功即解除拦截：再次云端提交不再确认，直接发请求", async () => {
    vi.mocked(api.editImage)
      .mockRejectedValueOnce(unconfirmed())
      .mockResolvedValueOnce({
        historyId: 12,
        dataUrl: "data:image/png;base64,FIX",
        filePath: "C:/media/fix.png",
        op: "erase",
      });
    renderStudio();

    fireEvent.click(screen.getByRole("button", { name: "AI 消除" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认消除" }));
    await screen.findByText("请求 ID：req_1");

    // 对账完成：这次客户端请求的计费风险已结清（哪怕有的图没恢复）
    fireEvent.click(screen.getByRole("button", { name: "尝试恢复" }));
    await waitFor(() =>
      expect(api.recoverImageRequestByClient).toHaveBeenCalledWith("req_1"),
    );

    // 挂起标记必须已清：再提交直接发请求，不弹「确认重新生成？」
    fireEvent.click(screen.getByRole("button", { name: "确认消除" }));
    await waitFor(() => expect(api.editImage).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("确认重新生成？")).toBeNull();
  });

  it("第二次失败带 ID 时采用最新请求 ID 对账", async () => {
    vi.mocked(api.editImage)
      // 第一次失败没带 request_id：标记里只有 null
      .mockRejectedValueOnce(unconfirmed(null))
      .mockRejectedValueOnce(unconfirmed("req_2"));
    renderStudio();

    fireEvent.click(screen.getByRole("button", { name: "AI 消除" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认消除" }));
    await screen.findByText("可能已计费，重试会再次扣费");
    // 没有 ID 的提示条给不出恢复入口
    expect(screen.queryByRole("button", { name: "尝试恢复" })).toBeNull();

    // 确认后重试，第二次失败带上了 ID
    fireEvent.click(screen.getByRole("button", { name: "确认消除" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "仍然重新生成" }),
    );
    await screen.findByText("请求 ID：req_2");

    // 对账必须用提示条上显示的那次请求
    fireEvent.click(screen.getByRole("button", { name: "尝试恢复" }));
    await waitFor(() =>
      expect(api.recoverImageRequestByClient).toHaveBeenCalledWith("req_2"),
    );
  });

  it("两次都带 ID 时用最新那次对账，不被最早那次钉住", async () => {
    vi.mocked(api.editImage)
      .mockRejectedValueOnce(unconfirmed("req_1"))
      .mockRejectedValueOnce(unconfirmed("req_2"));
    renderStudio();

    fireEvent.click(screen.getByRole("button", { name: "AI 消除" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认消除" }));
    await screen.findByText("请求 ID：req_1");

    fireEvent.click(screen.getByRole("button", { name: "确认消除" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "仍然重新生成" }),
    );
    await screen.findByText("请求 ID：req_2");

    fireEvent.click(screen.getByRole("button", { name: "尝试恢复" }));
    await waitFor(() =>
      expect(api.recoverImageRequestByClient).toHaveBeenCalledWith("req_2"),
    );
    expect(api.recoverImageRequestByClient).not.toHaveBeenCalledWith("req_1");
  });

  it("关掉修图台再打开仍要拦截：未确认标记跨卸载存活", async () => {
    vi.mocked(api.transformImage).mockRejectedValueOnce(
      unconfirmed("req_keep"),
    );
    const first = renderStudio();

    fireEvent.click(screen.getByRole("button", { name: "高清" }));
    fireEvent.click(await screen.findByRole("button", { name: "开始放大" }));
    await screen.findByText("请求 ID：req_keep");

    // 关掉修图台：组件销毁，但那次请求的对账结论并没有出来
    first.unmount();

    renderStudio();
    // 重新进来没有任何提示条，拦截依据只能是跨会话存活的挂起标记
    expect(screen.queryByText("请求 ID：req_keep")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "高清" }));
    fireEvent.click(await screen.findByRole("button", { name: "开始放大" }));

    await screen.findByText("确认重新生成？");
    expect(api.transformImage).toHaveBeenCalledTimes(1);
  });

  it("多区域部分成功 + 某区未确认：合成照常追加，但再次云端提交仍要确认", async () => {
    vi.mocked(api.regionEditBatch).mockImplementationOnce(async (input) => ({
      groupId: "g1",
      results: [
        {
          id: input.regions[0].id,
          ok: true,
          historyId: 10,
          dataUrl: "data:image/png;base64,REGION",
          filePath: "/r.png",
        },
        {
          id: input.regions[1].id,
          ok: false,
          error: JSON.stringify({
            type: "unconfirmed",
            message: "gateway timeout",
            request_id: "req_region",
          }),
        },
      ],
      cancelled: false,
      anySucceeded: true,
      historyId: 11,
      dataUrl: "data:image/png;base64,REGION",
    }));

    act(() => useAppStore.setState({ mode: "expert" }));
    renderStudio();
    fireEvent.click(screen.getByRole("button", { name: "多区域" }));
    await waitFor(() => expect(maskHandles.length).toBeGreaterThan(0));

    for (const prompt of ["加一束花", "加一棵树"]) {
      maskHandles[maskHandles.length - 1].strokes = true;
      fireEvent.change(screen.getByLabelText("区域提示词"), {
        target: { value: prompt },
      });
      fireEvent.click(screen.getByRole("button", { name: "添加区域" }));
    }
    await screen.findByText("区域 2");

    fireEvent.click(screen.getByRole("button", { name: "提交 2 个区域" }));
    await screen.findByText(/按区域分别计费/);
    fireEvent.click(screen.getByRole("button", { name: "开始重绘" }));

    // 已成功的图照常追加成一步
    await screen.findByRole("button", { name: "2. 多区域" });
    // 未确认的失败要讲计费口径，不能把 AdapterError 的 JSON 甩给用户
    await screen.findByText("结果可能已计费，请在请求记录中确认");
    expect(screen.queryByText(/\{"type"/)).toBeNull();

    // 关键回归：这一区可能已扣费，换任何云端动作都必须先确认
    fireEvent.click(screen.getByRole("button", { name: "高清" }));
    fireEvent.click(await screen.findByRole("button", { name: "开始放大" }));
    await screen.findByText("确认重新生成？");
    expect(api.transformImage).not.toHaveBeenCalled();
  });
});

describe("RetouchStudio 扩图面板", () => {
  it("专家模式打开扩图：原始比例显示保持原尺寸且不能提交", async () => {
    useAppStore.setState({ mode: "expert" });
    renderStudio();

    fireEvent.click(screen.getByRole("button", { name: "扩图" }));
    expect(await screen.findByText("保持原尺寸")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "生成扩图" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    // 选了比例才算出目标画布：400×300 → 16:9 = 533×300
    fireEvent.click(screen.getByRole("radio", { name: "16:9" }));
    await waitFor(() =>
      expect(screen.getByText("目标尺寸 533 × 300")).toBeTruthy(),
    );
  });
});

describe("RetouchStudio 裁剪调色面板", () => {
  it("1:1 裁剪走本地 applyEdit，parentId 是当前步", async () => {
    useAppStore.setState({ mode: "expert" });
    renderStudio();

    fireEvent.click(screen.getByRole("button", { name: "裁剪调色" }));
    // 尺寸实测完成后输出行才有值（原图 400×300 全图）
    await screen.findByText("输出 400 × 300");

    fireEvent.click(screen.getByRole("radio", { name: "1:1" }));
    await screen.findByText("输出 300 × 300");
    // 预览是本地渲染：等它落一次，避免断言期间还有未决状态
    await waitFor(() => expect(cropPreviewSpy).toHaveBeenCalled());

    const apply = screen.getByRole("button", { name: "应用裁剪" });
    await waitFor(() => expect(apply.hasAttribute("disabled")).toBe(false));
    fireEvent.click(apply);

    await screen.findByRole("button", { name: "2. 裁剪调色" });
    expect(api.applyEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        parentId: 7,
        // 不转不翻不调色：ops 精确只有一条 crop，多一条都说明参数被污染
        ops: [{ type: "crop", x: 50, y: 0, width: 300, height: 300 }],
      }),
    );
  });
});

describe("RetouchStudio 风格面板", () => {
  it("补充描述作为 prompt 走 transformImage（scale 1 / detail）", async () => {
    useAppStore.setState({ mode: "expert" });
    renderStudio();

    fireEvent.click(screen.getByRole("button", { name: "风格" }));
    fireEvent.change(await screen.findByLabelText("补充描述（可选）"), {
      target: { value: "暖色调" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用风格" }));

    await screen.findByRole("button", { name: "2. 风格" });
    expect(api.transformImage).toHaveBeenCalledWith(
      expect.objectContaining({ scale: 1, mode: "detail", prompt: "暖色调" }),
    );
  });
});

describe("RetouchStudio 局部重绘面板", () => {
  it("蒙版与加了护栏的提示词走 editImage retouch", async () => {
    vi.mocked(api.editImage).mockResolvedValueOnce({
      historyId: 30,
      dataUrl: "data:image/png;base64,INPAINT",
      filePath: "C:/media/inpaint.png",
      op: "retouch",
    });
    useAppStore.setState({ mode: "expert" });
    renderStudio();

    fireEvent.click(screen.getByRole("button", { name: "局部重绘" }));
    await waitFor(() => expect(maskHandles.length).toBeGreaterThan(0));

    fireEvent.change(await screen.findByLabelText("重绘要求"), {
      target: { value: "换成一只橘猫" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认重绘" }));

    await screen.findByRole("button", { name: "2. 局部重绘" });
    const [input] = vi.mocked(api.editImage).mock.calls[0];
    expect(input.maskB64).toBe("data:image/png;base64,MASK");
    expect(input.op).toBe("retouch");
    expect(input.prompt.startsWith("换成一只橘猫")).toBe(true);
    expect(input.prompt.endsWith(GUARD_SUFFIX)).toBe(true);
    expect(input.width).toBe(400);
    expect(input.height).toBe(300);
  });
});

describe("RetouchStudio 多区域面板", () => {
  /** 专家模式打开多区域面板，并等舞台上的蒙版画布挂上 */
  async function openRegionPanel() {
    act(() => useAppStore.setState({ mode: "expert" }));
    renderStudio();
    fireEvent.click(screen.getByRole("button", { name: "多区域" }));
    await waitFor(() => expect(maskHandles.length).toBeGreaterThan(0));
  }

  /** 涂一块（替身默认带笔画）并填提示词收进列表；每次添加后 view 会 clear() */
  function addOneRegion(prompt: string) {
    maskHandles[maskHandles.length - 1].strokes = true;
    fireEvent.change(screen.getByLabelText("区域提示词"), {
      target: { value: prompt },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加区域" }));
  }

  it("提交 1 个区域：参数带底图与羽化，整图落成一步并清空草稿", async () => {
    await openRegionPanel();
    addOneRegion("加一束花");
    await screen.findByText("区域 1");

    fireEvent.click(screen.getByRole("button", { name: "提交 1 个区域" }));
    // 逐区计费必须在提交前讲清楚
    await screen.findByText(/按区域分别计费/);
    fireEvent.click(screen.getByRole("button", { name: "开始重绘" }));

    await screen.findByRole("button", { name: "2. 多区域" });
    expect(api.regionEditBatch).toHaveBeenCalledTimes(1);
    const [input] = vi.mocked(api.regionEditBatch).mock.calls[0];
    expect(input.baseHistoryId).toBe(7);
    expect(input.baseB64).toBe("data:image/png;base64,SRC");
    expect(typeof input.jobId).toBe("string");
    expect(input.regions).toEqual([
      {
        id: expect.any(String),
        prompt: "加一束花",
        maskB64: "data:image/png;base64,MASK",
        feather: 24,
      },
    ]);
    // 成功后草稿清空，列表回到空提示
    await screen.findByText("请先涂抹区域并填写提示词");
    // 进度监听只挂一次，且提交结束就地释放（不攒监听器、不前一批事件串后一批）
    expect(listen).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(unlistenSpy).toHaveBeenCalledTimes(1));
  });

  it("一批最多 4 个区域：第 5 次时添加按钮禁用", async () => {
    await openRegionPanel();

    for (let i = 1; i <= 4; i += 1) {
      addOneRegion(`第 ${i} 个区域`);
      await screen.findByText(`区域 ${i}`);
    }

    // 每次添加都会 clear()：这里重新涂上，验证的是「数量上限」而不是空蒙版
    addOneRegion("第五个区域");
    const add = screen.getByRole("button", {
      name: "添加区域",
    }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(screen.queryByText("区域 5")).toBeNull();
  });

  it("取消分区重绘：cancelGeneration 收到提交时用的 jobId", async () => {
    const pending = deferred<{
      groupId: string;
      results: { id: string; ok: boolean; error?: string }[];
      cancelled: boolean;
      anySucceeded: boolean;
      historyId: number | null;
      dataUrl: string | null;
    }>();
    vi.mocked(api.regionEditBatch).mockReturnValueOnce(
      pending.promise as never,
    );

    await openRegionPanel();
    addOneRegion("加一束花");
    await screen.findByText("区域 1");

    fireEvent.click(screen.getByRole("button", { name: "提交 1 个区域" }));
    await screen.findByText(/按区域分别计费/);
    fireEvent.click(screen.getByRole("button", { name: "开始重绘" }));

    const cancel = await screen.findByRole("button", { name: "取消分区重绘" });
    await waitFor(() => expect(api.regionEditBatch).toHaveBeenCalledTimes(1));
    const [input] = vi.mocked(api.regionEditBatch).mock.calls[0];
    expect(input.jobId).toBeTruthy();

    fireEvent.click(cancel);
    await waitFor(() =>
      expect(api.cancelGeneration).toHaveBeenCalledWith(input.jobId),
    );

    // 收尾：后端确认「已取消且全失败」，busy 结束（草稿留给用户补齐）
    await act(async () => {
      pending.resolve({
        groupId: "g",
        results: [{ id: input.regions[0].id, ok: false, error: "cancelled" }],
        cancelled: true,
        anySucceeded: false,
        historyId: null,
        dataUrl: null,
      });
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "取消分区重绘" })).toBeNull(),
    );
    expect(screen.getByText("区域 1")).toBeTruthy();
  });

  it("部分取消：只留未成功的草稿，合成步骤不清空，再次提交只带剩下的区域", async () => {
    vi.mocked(api.regionEditBatch).mockImplementationOnce(async (input) => ({
      groupId: "g1",
      results: [
        {
          id: input.regions[0].id,
          ok: true,
          historyId: 9,
          dataUrl: "data:image/png;base64,REGION",
          filePath: "/r.png",
        },
        { id: input.regions[1].id, ok: false, error: "quota" },
      ],
      cancelled: true,
      anySucceeded: true,
      historyId: 9,
      dataUrl: "data:image/png;base64,REGION",
    }));

    await openRegionPanel();
    addOneRegion("加一束花");
    await screen.findByText("区域 1");
    addOneRegion("加一棵树");
    await screen.findByText("区域 2");

    fireEvent.click(screen.getByRole("button", { name: "提交 2 个区域" }));
    await screen.findByText(/按区域分别计费/);
    fireEvent.click(screen.getByRole("button", { name: "开始重绘" }));

    // 合成整图追加成第二步：草稿不能被换步清空，只剔除这次真跑成功的那块
    await screen.findByRole("button", { name: "2. 多区域" });
    expect(api.regionEditBatch).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("请先涂抹区域并填写提示词")).toBeNull();
    await screen.findByText("失败");
    expect(screen.queryByText("加一束花")).toBeNull();
    expect(screen.queryByText("区域 2")).toBeNull();
    expect(screen.getByText("区域 1")).toBeTruthy();
    expect(screen.getByText("加一棵树")).toBeTruthy();

    // 再提交：底图是上次合成的整图（historyId 9），只带剩下的那块
    vi.mocked(api.regionEditBatch).mockImplementationOnce(async (input) => ({
      groupId: "g2",
      results: [
        {
          id: input.regions[0].id,
          ok: true,
          historyId: 10,
          dataUrl: "data:image/png;base64,REGION2",
          filePath: "/r2.png",
        },
      ],
      cancelled: false,
      anySucceeded: true,
      historyId: 10,
      dataUrl: "data:image/png;base64,REGION2",
    }));
    fireEvent.click(screen.getByRole("button", { name: "提交 1 个区域" }));
    await screen.findByText(/按区域分别计费/);
    fireEvent.click(screen.getByRole("button", { name: "开始重绘" }));

    await screen.findByRole("button", { name: "3. 多区域" });
    const [, [secondInput]] = vi.mocked(api.regionEditBatch).mock.calls;
    expect(secondInput.baseHistoryId).toBe(9);
    expect(secondInput.baseB64).toBe("data:image/png;base64,REGION");
    expect(secondInput.regions).toEqual([
      {
        id: expect.any(String),
        prompt: "加一棵树",
        maskB64: "data:image/png;base64,MASK",
        feather: 24,
      },
    ]);
    // 全部成功才清空列表
    await screen.findByText("请先涂抹区域并填写提示词");
  });

  it("用户取消不算失败：不弹错误条与错误 toast，草稿留着", async () => {
    vi.mocked(api.regionEditBatch).mockResolvedValueOnce({
      groupId: "g",
      results: [],
      cancelled: true,
      anySucceeded: false,
      historyId: null,
      dataUrl: null,
    });

    await openRegionPanel();
    addOneRegion("加一束花");
    await screen.findByText("区域 1");

    fireEvent.click(screen.getByRole("button", { name: "提交 1 个区域" }));
    await screen.findByText(/按区域分别计费/);
    fireEvent.click(screen.getByRole("button", { name: "开始重绘" }));

    // run 里已经给过「已取消…」的 info 提示，主动取消不该再多一条红色错误
    await screen.findByText("已取消，已保留 0 个区域的结果");
    expect(screen.queryByRole("alert")).toBeNull();
    // 草稿保留：补涂后可以直接重提
    expect(screen.getByText("区域 1")).toBeTruthy();
  });

  it("当前步只有缩略图时不允许固化区域蒙版：提示稍候且不生成草稿", async () => {
    vi.mocked(api.historyLineage).mockResolvedValue([
      lineageRow(4, "paste", null),
      lineageRow(5, "auto-enhance", 4),
    ]);
    // 当前行读不到全图：步骤只剩缩略图，蒙版画布就是缩略图尺寸
    vi.mocked(api.getHistoryImage).mockImplementation(async (id: number) => {
      if (id === 5) throw new Error("file missing");
      return {
        historyId: id,
        dataUrl: `data:image/png;base64,IMG${id}`,
        filePath: `C:/media/${id}.png`,
      };
    });

    act(() => useAppStore.setState({ mode: "expert" }));
    renderStudio();
    await screen.findByRole("button", { name: "2. 一键优化" });
    fireEvent.click(screen.getByRole("button", { name: "多区域" }));
    await waitFor(() => expect(maskHandles.length).toBeGreaterThan(0));

    addOneRegion("加一束花");
    await screen.findByText("图片加载中，请稍候");
    expect(screen.queryByText("区域 1")).toBeNull();
  });
});

describe("RetouchStudio 计费口径（纯色换背景）", () => {
  it("纯色换背景成功不解除拦截：再提交云端动作仍要先确认", async () => {
    vi.mocked(api.editImage)
      .mockRejectedValueOnce(unconfirmed())
      .mockResolvedValueOnce({
        historyId: 12,
        dataUrl: "data:image/png;base64,FIX",
        filePath: "C:/media/fix.png",
        op: "erase",
      });
    renderStudio();

    // 一次云请求未确认失败
    fireEvent.click(screen.getByRole("button", { name: "AI 消除" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认消除" }));
    await screen.findByText("请求 ID：req_1");
    fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
    await waitFor(() =>
      expect(screen.queryByText("请求 ID：req_1")).toBeNull(),
    );

    // 收起消除面板（顺便重建一块新蒙版），纯色换背景在本地合成并提交成功
    fireEvent.click(screen.getByRole("button", { name: "AI 消除" }));
    fireEvent.click(screen.getByRole("button", { name: "换背景" }));
    fireEvent.click(await screen.findByRole("button", { name: "应用换背景" }));
    await screen.findByRole("button", { name: "2. 换背景" });

    // 纯色换背景不扣费：它的成功不能解除上一次未确认的计费风险
    fireEvent.click(screen.getByRole("button", { name: "换背景" }));
    fireEvent.click(screen.getByRole("button", { name: "AI 消除" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认消除" }));

    await screen.findByText("确认重新生成？");
    expect(api.editImage).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "仍然重新生成" }));
    await waitFor(() => expect(api.editImage).toHaveBeenCalledTimes(2));
  });
});
