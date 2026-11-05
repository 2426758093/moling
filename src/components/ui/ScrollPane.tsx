import { ReactNode, useRef } from "react";
import { cn } from "./cn";
import { useScrollEdge } from "../../hooks/useScrollEdge";

/// 滚动容器：原生滚动 + 上下边缘渐隐。
///
/// 刻意不用 Radix ScrollArea —— 它会把内容包进自定义视口，虚拟列表的
/// scrollTop / scrollElement 全部失真。这里只做样式与边缘遮罩。
export function ScrollPane({
  className,
  viewportClassName,
  children,
}: {
  className?: string;
  viewportClassName?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useScrollEdge(ref);

  return (
    <div ref={ref} className={cn("scroll-edge overflow-y-auto", className)}>
      <div className={viewportClassName}>{children}</div>
    </div>
  );
}
