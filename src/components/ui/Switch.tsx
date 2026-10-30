import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "./cn";

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  /// 无可见 label 时必填，作为可访问名称
  label?: string;
  id?: string;
  className?: string;
}

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  label,
  id,
  className,
}: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className={cn(
        "relative h-6 w-10 shrink-0 rounded-pill border border-transparent transition-colors",
        checked ? "bg-success" : "bg-fill",
        disabled && "cursor-not-allowed opacity-40",
        className,
      )}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "block h-5 w-5 rounded-pill bg-elevated shadow-card transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-0.5",
        )}
      />
    </SwitchPrimitive.Root>
  );
}
