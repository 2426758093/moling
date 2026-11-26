import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 提示词助手挂载即拉取模板/收藏/预设：全部替换成本地空数据，避免真实 invoke。
const apiMocks = vi.hoisted(() => ({
  getPromptTemplates: vi.fn(async () => ({ builtin: [], custom: [] })),
  savePromptTemplates: vi.fn(async () => undefined),
  getStylePresets: vi.fn(async () => ({ builtin: [], custom: [] })),
  saveStylePresets: vi.fn(async () => undefined),
  listFavorites: vi.fn(async () => []),
  listPresets: vi.fn(async () => []),
}));

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, api: { ...actual.api, ...apiMocks } };
});

import PromptAssist from "./index";
import { TooltipProvider } from "../ui/Tooltip";
import { usePromptAssetsStore } from "../../stores/promptAssetsStore";

beforeEach(() => {
  usePromptAssetsStore.setState({
    favorites: [],
    presets: [],
    loaded: false,
    loading: false,
  });
});

function renderAssist(onClose = vi.fn()) {
  return render(
    <TooltipProvider>
      <PromptAssist draft="" onClose={onClose} />
    </TooltipProvider>,
  );
}

describe("PromptAssist 提示词助手", () => {
  it("默认展示模板页签与全部页签文案", () => {
    renderAssist();

    expect(screen.getByLabelText("模板名称")).toBeTruthy();
    for (const label of ["模板", "灵感", "收藏", "预设"]) {
      expect(screen.getByRole("radio", { name: label })).toBeTruthy();
    }
  });

  it("切换页签后渲染对应内容且不抛错", () => {
    renderAssist();

    fireEvent.click(screen.getByRole("radio", { name: "灵感" }));
    expect(screen.getByText("再掷一次")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "预设" }));
    expect(screen.getByLabelText("预设名称")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "收藏" }));
    expect(screen.getByLabelText("收藏标签")).toBeTruthy();
  });
});
