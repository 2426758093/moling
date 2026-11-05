import { ReactNode } from "react";
import { cn } from "./cn";

/// 设置/详情页的分组容器：内容层材质（不透明 + 描边），不加玻璃。
export function Section({
  title,
  description,
  action,
  children,
  className,
}: {
  title?: string;
  description?: ReactNode;
  /// 分组标题右侧的操作（次级按钮）
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-3", className)}>
      {(title || action) && (
        <header className="flex items-end justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            {title && <h2 className="text-headline text-primary">{title}</h2>}
            {description && (
              <p className="text-subhead text-tertiary">{description}</p>
            )}
          </div>
          {action}
        </header>
      )}
      <div className="overflow-hidden rounded-card bg-elevated shadow-card">
        {children}
      </div>
    </section>
  );
}

/// 紧凑合并卡：多条短记录（队列、历史）共用一张内容面，行间由分隔线区隔。
export function InsetList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-card bg-elevated shadow-card",
        className,
      )}
    >
      {children}
    </div>
  );
}

/// 行式表单项：左标签右控件，行高 56px。行间用 1px 分隔线，最后一行不画。
export function Row({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative flex min-h-11 items-center justify-between gap-4 px-3 py-2",
        // 分隔线内缩 12px：卡片边缘保持干净，只看得到行与行之间的细线
        "after:pointer-events-none after:absolute after:inset-x-3 after:bottom-0 after:h-px after:bg-separator last:after:hidden",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        {typeof label === "string" ? (
          <label
            htmlFor={htmlFor}
            className="text-body text-primary select-none"
          >
            {label}
          </label>
        ) : (
          label
        )}
        {hint && <p className="text-footnote text-tertiary">{hint}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}
