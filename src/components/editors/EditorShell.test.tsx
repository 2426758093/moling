import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import EditorShell from "./EditorShell";
import { TooltipProvider } from "../ui/Tooltip";

function renderShell(
  overrides: { inline?: boolean; onClose?: () => void } = {},
) {
  const onClose = overrides.onClose ?? vi.fn();
  const view = render(
    <TooltipProvider>
      <EditorShell
        title="局部重绘"
        subtitle="第 2 层"
        inline={overrides.inline ?? false}
        onClose={onClose}
      >
        <p>画布内容</p>
      </EditorShell>
    </TooltipProvider>,
  );
  return { ...view, onClose };
}

describe("EditorShell 统一编辑器外壳", () => {
  it("渲染标题、副标题与内容区，并暴露 dialog 语义", () => {
    renderShell();

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("局部重绘")).toBeTruthy();
    expect(screen.getByText("第 2 层")).toBeTruthy();
    expect(screen.getByText("画布内容")).toBeTruthy();
  });

  it("点击关闭按钮触发 onClose", () => {
    const { onClose } = renderShell();

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("按 Esc 触发 onClose", () => {
    const { onClose } = renderShell();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("inline 时占满容器，全屏浮层时绝对定位", () => {
    const inline = renderShell({ inline: true });
    expect(
      (inline.container.firstElementChild as HTMLElement).className,
    ).toContain("h-full");
    inline.unmount();

    const overlay = renderShell({ inline: false });
    expect(
      (overlay.container.firstElementChild as HTMLElement).className,
    ).toContain("absolute");
  });
});
