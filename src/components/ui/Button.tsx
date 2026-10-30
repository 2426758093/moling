import { ButtonHTMLAttributes, forwardRef, ReactNode } from "react";
import { cn } from "./cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  loading?: boolean;
  block?: boolean;
}

/// primary 是实心强调色底 —— 同一屏只允许出现一个，且文字必须用 text-on-accent
/// （白色压在 --accent 上只有 3.4:1，所以底色走更深的 --accent-fill）。
const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-accent-fill text-on-accent hover:bg-accent-fill-hover active:bg-accent-fill-hover",
  secondary: "bg-fill text-primary hover:bg-hover border border-line",
  ghost: "text-secondary hover:bg-hover hover:text-primary",
  danger: "bg-danger/12 text-danger border border-danger/25 hover:bg-danger/18",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-subhead",
  md: "h-9 px-4 text-callout",
  lg: "h-10 px-4 text-body",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "secondary",
      size = "md",
      icon,
      loading = false,
      block = false,
      className,
      children,
      disabled,
      type = "button",
      ...rest
    },
    ref,
  ) {
    const inactive = disabled || loading;
    return (
      <button
        ref={ref}
        type={type}
        disabled={inactive}
        aria-busy={loading || undefined}
        aria-disabled={inactive || undefined}
        className={cn(
          "pressable relative inline-flex items-center justify-center gap-2 rounded-btn font-medium select-none",
          SIZE[size],
          VARIANT[variant],
          block && "w-full",
          inactive && "cursor-not-allowed opacity-40",
          className,
        )}
        {...rest}
      >
        {/* loading 时保留子节点宽度（invisible），避免按钮宽度跳变 */}
        <span
          className={cn(
            "inline-flex items-center gap-2",
            loading && "invisible",
          )}
        >
          {icon}
          {children}
        </span>
        {loading && (
          <span className="absolute inset-0 flex items-center justify-center gap-1">
            <Dot />
            <Dot delay={150} />
            <Dot delay={300} />
          </span>
        )}
      </button>
    );
  },
);

function Dot({ delay = 0 }: { delay?: number }) {
  return (
    <span
      aria-hidden
      className="thinking-dot h-1 w-1 rounded-pill bg-current"
      style={{ animationDelay: `${delay}ms` }}
    />
  );
}
