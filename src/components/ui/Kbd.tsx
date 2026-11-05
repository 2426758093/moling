import { ReactNode } from "react";
import { cn } from "./cn";

/// 快捷键标记：只做展示，真实绑定在 lib/shortcuts.ts。
export function Kbd({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-chip bg-fill px-1",
        "font-sans text-caption text-tertiary",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
