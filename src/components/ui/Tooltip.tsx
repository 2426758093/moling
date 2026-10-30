import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { ReactElement, ReactNode } from "react";
import { cn } from "./cn";

interface TooltipProps {
  label: ReactNode;
  children: ReactElement;
  side?: "top" | "bottom" | "left" | "right";
  /// 默认 500ms：Tooltip 只做补充说明，不能作为元素的唯一标签
  delay?: number;
  className?: string;
}

export function Tooltip({
  label,
  children,
  side = "bottom",
  delay = 500,
  className,
}: TooltipProps) {
  if (!label) return children;
  return (
    <TooltipPrimitive.Root delayDuration={delay}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className={cn(
            "anim-pop z-50 select-none rounded-btn bg-elevated px-2.5 py-1.5",
            "border border-line text-footnote text-primary shadow-pop",
            className,
          )}
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/// 挂在应用根部，让同一时刻只显示一个 Tooltip，并共享 500ms 延迟。
export const TooltipProvider = TooltipPrimitive.Provider;
