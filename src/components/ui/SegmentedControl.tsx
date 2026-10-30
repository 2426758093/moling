import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { ReactNode } from "react";
import { cn } from "./cn";

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

interface SegmentedControlProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: SegmentOption<T>[];
  /// 无可见标题时必填，作为整组的可访问名称
  label: string;
  size?: "sm" | "md";
  block?: boolean;
  className?: string;
}

export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  label,
  size = "md",
  block = false,
  className,
}: SegmentedControlProps<T>) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      aria-label={label}
      onValueChange={(v) => {
        // Radix 在重复点击当前项时会回传空串；分段控件不允许"无选中"
        if (v) onValueChange(v as T);
      }}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-btn bg-fill p-0.5",
        block && "flex w-full",
        className,
      )}
    >
      {options.map((opt) => (
        <ToggleGroup.Item
          key={opt.value}
          value={opt.value}
          disabled={opt.disabled}
          aria-label={typeof opt.label === "string" ? opt.label : undefined}
          className={cn(
            "pressable inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium",
            "text-secondary data-[state=on]:bg-elevated data-[state=on]:text-primary data-[state=on]:shadow-card",
            "hover:text-primary disabled:cursor-not-allowed disabled:opacity-40",
            size === "sm" ? "h-7 px-2.5 text-subhead" : "h-8 px-3 text-callout",
          )}
        >
          {opt.icon}
          {opt.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
