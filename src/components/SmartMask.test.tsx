import type { ReactNode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "./ui/Tooltip";
import { api } from "../lib/api";
import { useAppStore } from "../stores/appStore";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getSetting: vi.fn(),
      segmentModelStatus: vi.fn(),
      segmentAtPoint: vi.fn(),
      segmentSubject: vi.fn(),
    },
  };
});

import EditorView from "./EditorView";
import BackgroundView from "./BackgroundView";

const flush = () => act(async () => {});

function renderInProviders(node: ReactNode) {
  return render(<TooltipProvider>{node}</TooltipProvider>);
}

beforeEach(() => {
  useAppStore.setState({
    editTarget: {
      historyId: 1,
      dataUrl: "data:image/png;base64,AAAA",
      prompt: "",
      mode: "inpaint",
    },
    backgroundTarget: {
      historyId: 2,
      dataUrl: "data:image/png;base64,BBBB",
      prompt: "",
    },
  });
  vi.mocked(api.getSetting).mockResolvedValue("on");
  vi.mocked(api.segmentModelStatus).mockResolvedValue({
    available: true,
    loaded: false,
    reason: null,
  });
});

describe("智能蒙版入口降级", () => {
  it("smartMask 关闭时不显示点选物体，也不查询模型状态", async () => {
    vi.mocked(api.getSetting).mockResolvedValue("off");
    renderInProviders(<EditorView />);

    await waitFor(() =>
      expect(api.getSetting).toHaveBeenCalledWith("smartMask"),
    );
    await flush();

    expect(screen.queryByRole("button", { name: "点选物体" })).toBeNull();
    expect(api.segmentModelStatus).not.toHaveBeenCalled();
    // 手动涂抹入口仍然可用
    expect(screen.getByRole("button", { name: "全选" })).toBeTruthy();
  });

  it("模型不可用时不显示点选物体", async () => {
    vi.mocked(api.segmentModelStatus).mockResolvedValue({
      available: false,
      loaded: false,
      reason: "模型文件缺失",
    });
    renderInProviders(<EditorView />);

    await waitFor(() => expect(api.segmentModelStatus).toHaveBeenCalled());
    await flush();

    expect(screen.queryByRole("button", { name: "点选物体" })).toBeNull();
  });

  it("模型可用时显示点选物体并进入点选模式", async () => {
    renderInProviders(<EditorView />);

    const pick = await screen.findByRole("button", { name: "点选物体" });
    fireEvent.click(pick);

    expect(pick.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/点击要修改的物体自动选中/)).toBeTruthy();
  });

  it("换背景：模型不可用时不显示自动选中背景", async () => {
    vi.mocked(api.segmentModelStatus).mockResolvedValue({
      available: false,
      loaded: false,
      reason: "加载失败",
    });
    renderInProviders(<BackgroundView />);

    await waitFor(() => expect(api.segmentModelStatus).toHaveBeenCalled());
    await flush();

    expect(screen.queryByRole("button", { name: "自动选中背景" })).toBeNull();
    expect(screen.getByRole("button", { name: "全选背景" })).toBeTruthy();
  });
});

describe("智能蒙版失败降级", () => {
  it("空蒙版时提示改用手动涂抹", async () => {
    vi.mocked(api.segmentSubject).mockResolvedValue({
      dataUrl: "data:image/png;base64,CCCC",
      width: 1,
      height: 1,
      covered: 0.001,
    });
    renderInProviders(<BackgroundView />);

    fireEvent.click(
      await screen.findByRole("button", { name: "自动选中背景" }),
    );

    await waitFor(() =>
      expect(api.segmentSubject).toHaveBeenCalledWith(expect.any(String), true),
    );
    expect(
      await screen.findByText("没有识别到可替换的背景，请手动涂抹"),
    ).toBeTruthy();
  });

  it("分割超时时把后端提示透出为错误 toast", async () => {
    vi.mocked(api.segmentSubject).mockRejectedValue(
      "智能分割超时，请改用手动涂抹",
    );
    renderInProviders(<BackgroundView />);

    fireEvent.click(
      await screen.findByRole("button", { name: "自动选中背景" }),
    );

    expect(
      await screen.findByText("智能分割超时，请改用手动涂抹"),
    ).toBeTruthy();
  });
});
