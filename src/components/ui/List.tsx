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
          <div className="flex flex-col gap-1">
            {title && <h2 className="text-title2 text-primary">{title}</h2>}
            {description && (
              <p className="text-subhead text-tertiary">{description}</p>
            )}
          </div>
          {action}
        </header>
      )}
      <div className="overflow-hidden rounded-panel border border-line bg-elevated">
        {children}
      </div>
    </section>
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
        "flex min-h-14 items-center justify-between gap-4 px-4 py-2",
        "border-b border-separator last:border-b-0",
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
