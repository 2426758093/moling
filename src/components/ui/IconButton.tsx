import { ButtonHTMLAttributes, forwardRef, ReactNode } from "react";
import { cn } from "./cn";
import { Tooltip } from "./Tooltip";

interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label"
> {
  /// 必填：图标按钮没有可见文字，label 是它唯一的可访问名称
  label: string;
  icon: ReactNode;
  size?: "sm" | "md";
  variant?: "ghost" | "secondary" | "primary" | "danger";
  /// pill：圆形图标按钮（发送、停止这类主操作）
  shape?: "square" | "pill";
  /// 关闭 Tooltip 的场景（例如菜单内部、密集工具条）
  tooltip?: boolean;
  side?: "top" | "bottom" | "left" | "right";
}

const SIZE = {
  sm: "h-8 w-8",
  md: "h-9 w-9",
} as const;

const VARIANT = {
  ghost: "text-secondary hover:bg-hover hover:text-primary",
  secondary:
    "bg-fill text-secondary hover:bg-hover hover:text-primary border border-line",
  primary: "bg-accent-fill text-on-accent hover:bg-accent-fill-hover",
  danger: "bg-danger text-on-accent hover:opacity-90",
} as const;

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      label,
      icon,
      size = "md",
      variant = "ghost",
      shape = "square",
      tooltip = true,
      side = "bottom",
      className,
      disabled,
      type = "button",
      ...rest
    },
    ref,
  ) {
    const node = (
      <button
        ref={ref}
        type={type}
        aria-label={label}
        disabled={disabled}
        aria-disabled={disabled || undefined}
        className={cn(
          "pressable inline-flex shrink-0 items-center justify-center",
          shape === "pill" ? "rounded-pill" : "rounded-btn",
          SIZE[size],
          VARIANT[variant],
          disabled && "cursor-not-allowed opacity-40",
          className,
        )}
        {...rest}
      >
        {icon}
      </button>
    );
    return tooltip ? (
      <Tooltip label={label} side={side}>
        {node}
      </Tooltip>
    ) : (
      node
    );
  },
);
