import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Composer from "./Composer";
import { TooltipProvider } from "./ui/Tooltip";
import { useChatStore } from "../stores/chatStore";

beforeEach(() => {
  useChatStore.setState({
    messages: [],
    attachments: [],
    sending: false,
    draftPrompt: null,
    activeId: 7,
  });
});

describe("Composer 输入坞焦点环", () => {
  it("聚焦输入框时输入坞出现焦点环，失焦后移除", () => {
    render(
      <TooltipProvider>
        <Composer />
      </TooltipProvider>,
    );
    const textarea = screen.getByLabelText("提示词") as HTMLTextAreaElement;
    const dock = textarea.parentElement as HTMLElement;
    expect(dock.className).toContain("outline-none");

    fireEvent.focusIn(textarea);
    expect(dock.className).toContain("outline-2");
    expect(dock.className).not.toContain("outline-none");

    fireEvent.focusOut(textarea);
    expect(dock.className).toContain("outline-none");
  });
});

describe("Composer 发送未受理时回填草稿（F-008）", () => {
  it("send 返回 false 时输入框恢复原文", async () => {
    const send = vi.fn(async () => false);
    useChatStore.setState({ send });

    render(
      <TooltipProvider>
        <Composer />
      </TooltipProvider>,
    );
    const textarea = screen.getByLabelText("提示词") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "画一只猫" } });
    fireEvent.click(screen.getByRole("button", { name: "生成" }));

    await waitFor(() => expect(send).toHaveBeenCalledWith("画一只猫"));
    await waitFor(() => expect(textarea.value).toBe("画一只猫"));
  });

  it("send 返回 true 时保持清空", async () => {
    const send = vi.fn(async () => true);
    useChatStore.setState({ send });

    render(
      <TooltipProvider>
        <Composer />
      </TooltipProvider>,
    );
    const textarea = screen.getByLabelText("提示词") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "画一只猫" } });
    fireEvent.click(screen.getByRole("button", { name: "生成" }));

    await waitFor(() => expect(send).toHaveBeenCalledWith("画一只猫"));
    expect(textarea.value).toBe("");
  });
});
