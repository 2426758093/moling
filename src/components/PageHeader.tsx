import { ReactNode } from "react";
import { cn } from "./ui/cn";

/// ViewBar：内容面顶部的 44px 视图栏。
///
/// 它不再是玻璃 —— 玻璃只负责"浮在内容之上"，而它属于内容面本身。
/// 副标题与标题同一行（Linear 式），带筛选条的页面把筛选放进 `footer`。
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
    <header
      className={cn(
        "relative z-10 shrink-0 border-b border-separator",
        className,
      )}
    >
      <div className="flex h-11 items-center gap-3 px-5">
        <h1 className="shrink-0 truncate text-title1 text-primary">{title}</h1>
        {subtitle && (
          <p className="min-w-0 truncate text-footnote text-tertiary">
            {subtitle}
          </p>
        )}
        {actions && (
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {actions}
          </div>
        )}
      </div>
      {footer && <div className="px-4 pb-2">{footer}</div>}
    </header>
  );
}
