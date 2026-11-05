import { ReactNode } from "react";
import { cn } from "./cn";

/// 工具栏分组：同一功能的按钮共享一块玻璃，组间用分隔符。
/// 组内不混用图标与文字（HIG 工具栏一致性要求）。
export function Toolbar({
  children,
  label,
  className,
}: {
  children: ReactNode;
  /// 整条工具栏的可访问名称
  label: string;
  className?: string;
}) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      className={cn(
        "flex items-center gap-1 rounded-btn glass px-1 py-1",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function ToolbarGroup({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-0.5">{children}</div>;
}

export function ToolbarSeparator() {
  return <span aria-hidden className="mx-1 h-5 w-px bg-line" />;
}

/// 浮动工具条：画布、画廊底部居中悬浮的玻璃胶囊。
/// 它浮在内容之上，所以用玻璃；不要把它塞进内容面里。
export function ToolbarFloating({
  children,
  label,
  className,
}: {
  children: ReactNode;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      className={cn(
        "glass pointer-events-auto flex items-center gap-0.5 rounded-pill px-1.5 py-1 shadow-pop",
        className,
      )}
    >
      {children}
    </div>
  );
}
