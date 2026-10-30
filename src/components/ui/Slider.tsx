import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "./cn";

interface SliderProps {
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  /// 无可见 label 时必填
  label?: string;
  className?: string;
}

export function Slider({
  value,
  onValueChange,
  min = 0,
  max = 100,
  step = 1,
  disabled,
  label,
  className,
}: SliderProps) {
  return (
    <SliderPrimitive.Root
      value={[value]}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      aria-label={label}
      onValueChange={([v]) => onValueChange(v)}
      className={cn(
        "relative flex h-5 w-full touch-none items-center select-none",
        disabled && "cursor-not-allowed opacity-40",
        className,
      )}
    >
      <SliderPrimitive.Track className="relative h-1 w-full grow rounded-pill bg-sunken">
        <SliderPrimitive.Range className="absolute h-full rounded-pill bg-accent" />
      </SliderPrimitive.Track>
      {/* 旋钮是内容层里唯一允许的玻璃例外：拖动期间呈现玻璃质感 */}
      <SliderPrimitive.Thumb
        className={cn(
          "thumb-glass block h-4 w-4 rounded-pill border border-line bg-elevated shadow-card transition-transform",
          "active:scale-110",
        )}
      />
    </SliderPrimitive.Root>
  );
}
