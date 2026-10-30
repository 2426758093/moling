import * as SelectPrimitive from "@radix-ui/react-select";
import { IconChevron } from "../Icons";
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
  variant?: "default" | "bare";
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
          "pressable flex h-9 items-center justify-between gap-2 rounded-btn px-3",
          "text-left text-body text-primary transition-colors",
          widthClass ?? "w-full",
          variant === "default"
            ? "border border-line bg-fill hover:border-line-strong data-[placeholder]:text-tertiary"
            : "border border-transparent bg-transparent hover:bg-hover",
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
          className="anim-pop z-50 max-h-72 overflow-hidden rounded-pop border border-line glass shadow-sheet"
        >
          <SelectPrimitive.Viewport className="max-h-72 overflow-y-auto p-1">
            {options.map((opt) => (
              <SelectPrimitive.Item
                key={opt.value}
                value={toRadix(opt.value)}
                disabled={opt.disabled}
                className={cn(
                  "relative flex h-8 cursor-pointer select-none items-center rounded-btn px-2 text-callout text-primary outline-none",
                  "data-[highlighted]:bg-hover data-[disabled]:cursor-not-allowed data-[disabled]:text-quaternary",
                )}
              >
                <SelectPrimitive.ItemText>{opt.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
