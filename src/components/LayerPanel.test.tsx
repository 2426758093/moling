import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LayerPanel from "./LayerPanel";
import { TooltipProvider } from "./ui/Tooltip";
import { CanvasNode, useCanvasStore } from "../stores/canvasStore";

const node: CanvasNode = {
  id: "n1",
  historyId: 5,
  x: 0,
  y: 0,
  width: 220,
  layers: [
    {
      id: "base",
      kind: "image",
      historyId: 5,
      visible: true,
      opacity: 1,
      locked: true,
    },
    {
      id: "l2",
      kind: "image",
      historyId: 6,
      visible: true,
      opacity: 1,
      locked: false,
    },
    {
      id: "l3",
      kind: "image",
      historyId: 7,
      visible: true,
      opacity: 1,
      locked: false,
    },
  ],
};

beforeEach(() => {
  useCanvasStore.setState({ nodes: [node], thumbs: {}, gifIds: {} });
});

function currentLayers() {
  return useCanvasStore.getState().nodes[0].layers ?? [];
}

/** 画布里浮层随 store 更新重渲染：测试同样用订阅节点的方式挂载 */
function Harness({ onClose = () => {} }: { onClose?: () => void }) {
  const live = useCanvasStore((s) => s.nodes.find((n) => n.id === "n1"));
  if (!live) return null;
  return (
    <TooltipProvider>
      <LayerPanel node={live} onClose={onClose} />
    </TooltipProvider>
  );
}

describe("LayerPanel", () => {
  it("显隐/锁定按行生效，锁定的基准层不可删除", async () => {
    render(<Harness />);
    const eyeButtons = await screen.findAllByLabelText("隐藏图层");
    // 反向渲染：第一行是最上层 l3
    fireEvent.click(eyeButtons[0]);
    expect(currentLayers().find((l) => l.id === "l3")?.visible).toBe(false);
    expect(await screen.findByLabelText("显示图层")).toBeTruthy();

    const deleteButtons = screen.getAllByLabelText("删除图层");
    const baseDelete = deleteButtons[deleteButtons.length - 1];
    expect((baseDelete as HTMLButtonElement).disabled).toBe(true);
  });

  it("按钮换序，锁定层不允许上移", () => {
    render(<Harness />);
    const downButtons = screen.getAllByLabelText("下移图层");
    // 第一行 l3 的「下移」：l3 与 l2 交换
    fireEvent.click(downButtons[0]);
    expect(currentLayers().map((l) => l.id)).toEqual(["base", "l3", "l2"]);
    const upButtons = screen.getAllByLabelText("上移图层");
    fireEvent.click(upButtons[upButtons.length - 1]);
    expect(currentLayers().map((l) => l.id)).toEqual(["base", "l3", "l2"]);
  });

  it("Esc 关闭浮层，Alt+↓ 下移当前层", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.keyDown(window, { key: "ArrowDown", altKey: true });
    expect(currentLayers().map((l) => l.id)).toEqual(["base", "l3", "l2"]);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
