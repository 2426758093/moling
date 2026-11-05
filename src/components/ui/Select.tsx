import * as SelectPrimitive from "@radix-ui/react-select";
import { IconCheck, IconChevron } from "../Icons";
import { cn } from "./cn";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/// Radix 禁止空字符串选项值，也不允许 value 在受控/非受控间切换。
/// 调用方的「未选择」用 "" 表示，这里统一换成哨兵值再换回来。
const EMPTY_VALUE = "__empty__";
const toRadix = (v: string) => (v === "" ? EMPTY_VALUE : v);
const fromRadix = (v: string) => (v === EMPTY_VALUE ? "" : v);

interface SelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  label?: string;
  id?: string;
  /// bare：无边框无底色，用于工具栏内联（触发器仍保留焦点环与最小点击区）
  /// chip：24px 摘要胶囊，用于输入坞参数行
  variant?: "default" | "bare" | "chip";
  /// 宽度工具类（如 "w-48"）。不要用 className 覆盖：w-full 会因生成顺序压过它
  widthClass?: string;
  className?: string;
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder = "请选择",
  disabled,
  label,
  id,
  variant = "default",
  widthClass,
  className,
}: SelectProps) {
  return (
    <SelectPrimitive.Root
      value={toRadix(value)}
      onValueChange={(v) => onValueChange(fromRadix(v))}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        id={id}
        aria-label={label}
        className={cn(
          "pressable flex items-center justify-between gap-2",
          variant === "chip"
            ? "h-6 rounded-chip px-2 text-caption text-secondary hover:bg-hover hover:text-primary"
            : "h-8 rounded-btn px-2.5 text-left text-callout text-primary transition-colors",
          widthClass ?? "w-full",
          variant === "default" &&
            "bg-elevated shadow-card hover:bg-grouped data-[placeholder]:text-tertiary",
          variant === "bare" &&
            "border border-transparent bg-transparent transition-colors hover:bg-hover",
          variant === "chip" && "transition-colors",
          disabled && "cursor-not-allowed opacity-40",
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon className="text-tertiary">
          <IconChevron size={14} />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          className="anim-pop z-50 max-h-72 overflow-hidden rounded-pop glass shadow-pop"
        >
          <SelectPrimitive.Viewport className="max-h-72 overflow-y-auto p-1.5">
            {options.map((opt) => (
              <SelectPrimitive.Item
                key={opt.value}
                value={toRadix(opt.value)}
                disabled={opt.disabled}
                className={cn(
                  "relative flex h-7 cursor-pointer select-none items-center rounded-chip pl-2 pr-7 text-callout text-primary outline-none",
                  "data-[highlighted]:bg-hover data-[disabled]:cursor-not-allowed data-[disabled]:text-quaternary",
                )}
              >
                <SelectPrimitive.ItemText>{opt.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute right-2 flex h-4 w-4 items-center justify-center text-accent">
                  <IconCheck size={14} />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
