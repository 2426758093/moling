import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";
import { useAppStore } from "../../stores/appStore";

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ paletteOpen: true, view: "chat" });
});

describe("CommandPalette", () => {
  it("打开后列出命令分组，并能按关键词过滤", async () => {
    render(<CommandPalette />);

    const input = await screen.findByLabelText("搜索命令");
    expect(screen.getByText("导航")).toBeTruthy();
    expect(screen.getByText("打开聊天")).toBeTruthy();

    fireEvent.change(input, { target: { value: "画廊" } });
    expect(screen.getByText("打开画廊")).toBeTruthy();
    expect(screen.queryByText("打开聊天")).toBeNull();
  });

  it("回车执行当前高亮命令并关闭面板", async () => {
    const setView = vi.fn();
    useAppStore.setState({ setView });
    render(<CommandPalette />);

    const input = await screen.findByLabelText("搜索命令");
    fireEvent.change(input, { target: { value: "打开画廊" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(setView).toHaveBeenCalledWith("gallery"));
    expect(useAppStore.getState().paletteOpen).toBe(false);
  });

  it("方向键在结果间移动高亮", async () => {
    render(<CommandPalette />);
    const input = await screen.findByLabelText("搜索命令");

    const first = screen.getByRole("option", { name: /打开聊天/ });
    expect(first.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    const second = screen.getByRole("option", { name: /打开画廊/ });
    expect(second.getAttribute("aria-selected")).toBe("true");
  });

  it("输入法组合期回车不执行命令", async () => {
    const setView = vi.fn();
    useAppStore.setState({ setView });
    render(<CommandPalette />);
    const input = await screen.findByLabelText("搜索命令");
    fireEvent.change(input, { target: { value: "打开画廊" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect(setView).not.toHaveBeenCalled();
  });

  it("无匹配时给出空态提示", async () => {
    render(<CommandPalette />);
    const input = await screen.findByLabelText("搜索命令");
    fireEvent.change(input, { target: { value: "zzzzzz" } });
    expect(screen.getByText("没有匹配的命令")).toBeTruthy();
  });
});
