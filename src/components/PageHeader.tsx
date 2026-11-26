import { ReactNode } from "react";
import { cn } from "./ui/cn";

/// 页眉：题签式 —— 标题 + 副题 + 右侧动作，下面一道由深到浅的细线。
/// 它属于纸面本身，不是浮层，因此不使用任何模糊或玻璃。
export default function PageHeader({
  title,
  subtitle,
  actions,
  footer,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("relative z-10 shrink-0 px-6 pb-3 pt-5", className)}>
      <div className="flex items-end gap-3">
        <h1 className="shrink-0 truncate font-kai text-title1 font-normal text-primary">
          {title}
        </h1>
        {subtitle && (
          <p className="min-w-0 truncate pb-1 text-footnote text-tertiary">
            {subtitle}
          </p>
        )}
        {actions && (
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {actions}
          </div>
        )}
      </div>
      <div
        aria-hidden
        className="mt-3 h-px bg-gradient-to-r from-line-strong to-transparent"
      />
      {footer && <div className="pt-2">{footer}</div>}
    </header>
  );
}
