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
        "relative h-5 w-9 shrink-0 rounded-pill transition-colors",
        checked ? "bg-success-fill" : "bg-fill",
        disabled && "cursor-not-allowed opacity-40",
        className,
      )}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "my-0.5 block h-4 w-4 rounded-pill bg-elevated shadow-card transition-transform",
          "data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0.5",
        )}
      />
    </SwitchPrimitive.Root>
  );
}
