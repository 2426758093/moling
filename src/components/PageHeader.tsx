import { ReactNode } from "react";
import { cn } from "./ui/cn";

/// 各页统一栏头：功能层玻璃，下方无分割线（内容滚过时由边缘遮罩收口）。
///
/// 画廊这类带筛选条的页面把筛选条放进同一个玻璃栈（`footer`），
/// 避免出现"两条玻璃叠在一起"的分层错误。
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
    <header className={cn("relative z-10 shrink-0 glass", className)}>
      <div className="flex min-h-12 items-center gap-3 px-6 py-2">
        <div className="flex min-w-0 flex-col">
          <h1 className="truncate text-title3 text-primary">{title}</h1>
          {subtitle && (
            <p className="truncate text-footnote text-tertiary">{subtitle}</p>
          )}
        </div>
        {actions && (
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {actions}
          </div>
        )}
      </div>
      {footer && <div className="px-6 pb-2.5">{footer}</div>}
    </header>
  );
}
