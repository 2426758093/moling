import { ReactNode } from "react";
import { cn } from "./cn";

/// 空态统一结构：eyebrow（可选）→ display 标题 → 说明 → 动作区。
///
/// display 26px 一屏只允许出现一次，所以它只属于空态主标题；页面里已经有
/// ViewBar 标题，这里不再重复一遍普通标题的字号。
export function EmptyState({
  eyebrow,
  title,
  description,
  icon,
  children,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center",
        className,
      )}
    >
      {icon && (
        <div className="mb-1 flex h-11 w-11 items-center justify-center rounded-card bg-sunken text-tertiary">
          {icon}
        </div>
      )}
      {eyebrow && (
        <p className="text-caption tracking-normal text-tertiary uppercase">
          {eyebrow}
        </p>
      )}
      <h2 className="text-display text-primary">{title}</h2>
      {description && (
        <p className="max-w-reading text-body text-tertiary">{description}</p>
      )}
      {children && <div className="mt-3 w-full max-w-reading">{children}</div>}
    </div>
  );
}
