import { ReactNode } from "react";
import { cn } from "./cn";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

const TONE: Record<BadgeTone, string> = {
  neutral: "bg-fill text-secondary",
  accent: "bg-accent-soft text-accent-text",
  success: "bg-success-fill/15 text-success",
  warning: "bg-warning-fill/15 text-warning",
  danger: "bg-danger/12 text-danger",
};

/// 状态角标：11px 上限，只放短词或数字。
export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-pill px-1.5 text-caption",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
