import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { ReactNode, useId } from "react";
import { motion } from "framer-motion";
import { cn } from "./cn";
import { SPRING } from "../../lib/motion";
import { useMotionTokens } from "../../lib/useMotion";

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

/// 分段控件：滑块指示器用 layoutId 在选项之间连续移动，
/// 比"每项各自换底色"更容易看出当前选中了哪一段。
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  label,
  size = "md",
  block = false,
  className,
}: SegmentedControlProps<T>) {
  const indicatorId = useId();
  const motionTokens = useMotionTokens();

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
        "inline-flex items-center gap-0.5 rounded-btn bg-sunken p-0.5",
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
            "pressable relative inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-chip font-medium",
            "text-secondary hover:text-primary",
            "data-[state=on]:text-primary",
            "disabled:cursor-not-allowed disabled:opacity-40",
            size === "sm" ? "h-6 px-2 text-subhead" : "h-7 px-2.5 text-callout",
          )}
        >
          {opt.value === value && (
            <motion.span
              aria-hidden
              layoutId={indicatorId}
              transition={
                motionTokens.reduce
                  ? { duration: 0 }
                  : { type: "spring", ...SPRING.snappy }
              }
              className="absolute inset-0 rounded-chip bg-elevated shadow-card"
            />
          )}
          <span className="relative inline-flex items-center gap-1.5">
            {opt.icon}
            {opt.label}
          </span>
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
