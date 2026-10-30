import {
  forwardRef,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
  useId,
} from "react";
import { cn } from "./cn";

const FIELD_BASE =
  "rounded-btn border bg-fill px-3 text-primary transition-colors placeholder:text-tertiary hover:border-line-strong focus:border-accent disabled:cursor-not-allowed disabled:opacity-50";

interface CommonProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  /// 右侧附着内容（字符计数、单位、按钮）
  suffix?: ReactNode;
  /// 宽度工具类（如 "w-64"）。不要用 className 覆盖：w-full 会因生成顺序压过它
  widthClass?: string;
}

interface InputProps
  extends CommonProps, InputHTMLAttributes<HTMLInputElement> {
  /// compact：工具栏内联用的紧凑高度
  compact?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    label,
    hint,
    error,
    suffix,
    widthClass,
    compact = false,
    className,
    id,
    ...rest
  },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const describedBy = error
    ? `${inputId}-error`
    : hint
      ? `${inputId}-hint`
      : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={inputId} className="text-subhead text-secondary">
          {label}
        </label>
      )}
      <div className="relative">
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            FIELD_BASE,
            widthClass ?? "w-full",
            compact ? "h-8 text-callout" : "h-9 text-body",
            error && "border-danger",
            suffix ? "pr-12" : null,
            className,
          )}
          {...rest}
        />
        {suffix && (
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-footnote text-tertiary">
            {suffix}
          </span>
        )}
      </div>
      {error ? (
        <p id={`${inputId}-error`} className="text-footnote text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="text-footnote text-tertiary">
          {hint}
        </p>
      ) : null}
    </div>
  );
});

interface TextareaProps
  extends CommonProps, TextareaHTMLAttributes<HTMLTextAreaElement> {
  /// sm：紧凑浮层里的多行输入（不撑高到设置页那种体量）
  compact?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea(
    { label, hint, error, widthClass, compact = false, className, id, ...rest },
    ref,
  ) {
    const autoId = useId();
    const areaId = id ?? autoId;
    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={areaId} className="text-subhead text-secondary">
            {label}
          </label>
        )}
        <textarea
          ref={ref}
          id={areaId}
          aria-invalid={error ? true : undefined}
          className={cn(
            FIELD_BASE,
            widthClass ?? "w-full",
            "resize-y py-2 text-body leading-relaxed",
            compact ? "min-h-16" : "min-h-24",
            error && "border-danger",
            className,
          )}
          {...rest}
        />
        {error ? (
          <p className="text-footnote text-danger">{error}</p>
        ) : hint ? (
          <p className="text-footnote text-tertiary">{hint}</p>
        ) : null}
      </div>
    );
  },
);
