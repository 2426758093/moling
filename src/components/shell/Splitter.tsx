import { useRef, useState } from "react";
import { clampSize } from "../../lib/layout";
import { cn } from "../ui/cn";

export interface SplitterProps {
  /// vertical = 竖直分隔条（左右拖拽），horizontal = 顶部横条（上下拖拽）
  orientation: "vertical" | "horizontal";
  value: number;
  min: number;
  max: number;
  /// 双击复位值
  defaultValue: number;
  onChange: (value: number) => void;
  /// 无可见文字时必填，同时作为 separator 的无障碍名称
  label: string;
  /// 反向拖拽：右侧检查器 / 底部输入坞的值随指针反方向增长
  invert?: boolean;
  onDraggingChange?: (dragging: boolean) => void;
  className?: string;
}

const KEY_STEP = 8;
const KEY_STEP_LARGE = 32;
const HIT_SIZE = 6;

/// 通用拖拽分隔条：pointer capture 拖拽、双击复位、方向键 / Home / End，
/// 关系数值全部暴露在 ARIA 上，键盘与辅助技术不依赖鼠标。
export default function Splitter({
  orientation,
  value,
  min,
  max,
  defaultValue,
  onChange,
  label,
  invert = false,
  onDraggingChange,
  className,
}: SplitterProps) {
  const vertical = orientation === "vertical";
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    pointerId: number;
    start: number;
    value: number;
    element: HTMLElement;
  } | null>(null);

  const endDrag = (element: HTMLElement, pointerId: number) => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    onDraggingChange?.(false);
    // jsdom 与旧浏览器可能没有 pointer capture：可选调用即可
    element.releasePointerCapture?.(pointerId);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const element = e.currentTarget;
    drag.current = {
      pointerId: e.pointerId,
      start: vertical ? e.clientX : e.clientY,
      value,
      element,
    };
    setDragging(true);
    onDraggingChange?.(true);
    element.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== e.pointerId) return;
    const delta = (vertical ? e.clientX : e.clientY) - state.start;
    onChange(clampSize(state.value + (invert ? -delta : delta), min, max));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    endDrag(e.currentTarget, e.pointerId);
  };

  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    endDrag(e.currentTarget, e.pointerId);
  };

  const onLostPointerCapture = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    onDraggingChange?.(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // 左 / 上 = 减少，右 / 下 = 增加；反向条再取反，让分隔条跟着方向键走。
    const direction =
      e.key === "ArrowLeft" || e.key === "ArrowUp"
        ? -1
        : e.key === "ArrowRight" || e.key === "ArrowDown"
          ? 1
          : 0;
    let next: number | null = null;
    if (direction !== 0) {
      const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
      next = clampSize(value + direction * step * (invert ? -1 : 1), min, max);
    } else if (e.key === "Home") {
      next = min;
    } else if (e.key === "End") {
      next = max;
    }
    if (next === null) return;
    e.preventDefault();
    if (next !== value) onChange(next);
  };

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      data-resizing={dragging ? "true" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
      onDoubleClick={() => onChange(defaultValue)}
      onKeyDown={onKeyDown}
      className={cn(
        "group relative z-10 shrink-0 touch-none select-none outline-none",
        vertical ? "cursor-col-resize self-stretch" : "cursor-row-resize",
        className,
      )}
      style={vertical ? { width: HIT_SIZE } : { height: HIT_SIZE }}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute rounded-pill bg-transparent transition-colors duration-150",
          vertical
            ? "inset-y-0 left-1/2 w-px -translate-x-1/2"
            : "inset-x-0 top-1/2 h-px -translate-y-1/2",
          "group-hover:bg-accent/30 group-focus-visible:bg-accent/60",
          dragging && "bg-accent/60",
        )}
      />
    </div>
  );
}
