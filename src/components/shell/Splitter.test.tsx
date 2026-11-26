import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Splitter from "./Splitter";

function renderSplitter(
  props: Partial<React.ComponentProps<typeof Splitter>> = {},
) {
  const onChange = vi.fn();
  const onDraggingChange = vi.fn();
  render(
    <Splitter
      orientation="vertical"
      label="调整侧栏宽度"
      value={248}
      min={200}
      max={420}
      defaultValue={248}
      onChange={onChange}
      onDraggingChange={onDraggingChange}
      {...props}
    />,
  );
  return {
    onChange,
    onDraggingChange,
    el: screen.getByRole("separator", {
      name: props.label ?? "调整侧栏宽度",
    }),
  };
}

describe("Splitter 无障碍语义", () => {
  it("暴露 separator 的方向与数值范围", () => {
    const { el } = renderSplitter();
    expect(el.getAttribute("aria-orientation")).toBe("vertical");
    expect(el.getAttribute("aria-valuenow")).toBe("248");
    expect(el.getAttribute("aria-valuemin")).toBe("200");
    expect(el.getAttribute("aria-valuemax")).toBe("420");
    expect(el.getAttribute("tabindex")).toBe("0");
  });
});

describe("Splitter 指针拖拽", () => {
  it("按指针位移更新，越界自动夹取，松手后停止", () => {
    const { el, onChange, onDraggingChange } = renderSplitter();

    fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: 100 });
    expect(onDraggingChange).toHaveBeenLastCalledWith(true);

    fireEvent.pointerMove(el, { pointerId: 1, clientX: 160 });
    expect(onChange).toHaveBeenLastCalledWith(308);

    fireEvent.pointerMove(el, { pointerId: 1, clientX: 900 });
    expect(onChange).toHaveBeenLastCalledWith(420);

    fireEvent.pointerUp(el, { pointerId: 1 });
    expect(onDraggingChange).toHaveBeenLastCalledWith(false);

    fireEvent.pointerMove(el, { pointerId: 1, clientX: 0 });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("invert 时指针反向增长（右侧检查器）", () => {
    const { el, onChange } = renderSplitter({
      invert: true,
      label: "调整检查器宽度",
      value: 288,
      min: 240,
      max: 420,
      defaultValue: 288,
    });

    fireEvent.pointerDown(el, { button: 0, pointerId: 2, clientX: 300 });
    fireEvent.pointerMove(el, { pointerId: 2, clientX: 340 });
    expect(onChange).toHaveBeenLastCalledWith(248);
  });

  it("横向分隔条按纵向位移增长（输入坞）", () => {
    const { el, onChange } = renderSplitter({
      orientation: "horizontal",
      invert: true,
      label: "调整输入坞高度",
      value: 160,
      min: 120,
      max: 360,
      defaultValue: 160,
    });

    fireEvent.pointerDown(el, { button: 0, pointerId: 3, clientY: 400 });
    fireEvent.pointerMove(el, { pointerId: 3, clientY: 340 });
    expect(onChange).toHaveBeenLastCalledWith(220);
  });
});

describe("Splitter 键盘操作", () => {
  it("方向键 ±8、Shift ±32、Home/End 到端点", () => {
    const { el, onChange } = renderSplitter();

    fireEvent.keyDown(el, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(256);

    fireEvent.keyDown(el, { key: "ArrowLeft", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(216);

    fireEvent.keyDown(el, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith(200);

    fireEvent.keyDown(el, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith(420);
  });

  it("invert 时方向键随分隔条物理方向移动", () => {
    const { el, onChange } = renderSplitter({
      invert: true,
      label: "调整检查器宽度",
      value: 288,
      min: 240,
      max: 420,
      defaultValue: 288,
    });

    fireEvent.keyDown(el, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith(296);
  });
});

describe("Splitter 双击复位", () => {
  it("双击回到默认值", () => {
    const { el, onChange } = renderSplitter({ value: 380 });
    fireEvent.doubleClick(el);
    expect(onChange).toHaveBeenCalledWith(248);
  });
});
