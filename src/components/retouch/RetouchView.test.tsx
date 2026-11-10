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

const { maskHandles, deliverSpy, historySpy } = vi.hoisted(() => ({
  maskHandles: [] as FakeMask[],
  deliverSpy: vi.fn(),
  historySpy: vi.fn(),
}));

// 回写单独测：这里只关心「提交成功后有没有带着 nodeId 调回写」，画布规则在
// deliverEditResult.test.ts 里覆盖。
vi.mock("../../lib/deliverEditResult", () => ({
  deliverEditResult: deliverSpy,
}));

// 历史变更广播：画廊靠它刷新，每步提交后都必须发一次
vi.mock("../../lib/historyEvents", () => ({
  emitHistoryChanged: historySpy,
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
      recoverImageRequestByClient: vi.fn(),
      getSetting: vi.fn(),
      segmentModelStatus: vi.fn(),
      segmentSubject: vi.fn(),
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

beforeEach(() => {
  vi.stubGlobal("Image", FakeImage);
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
  /** 一次未确认失败：gateway 超时但可能已在服务商侧出图 */
  function unconfirmed() {
    return new Error(
      JSON.stringify({
        type: "unconfirmed",
        message: "gateway timeout",
        request_id: "req_1",
      }),
    );
  }

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
