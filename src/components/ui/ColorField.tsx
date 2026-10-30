interface ColorFieldProps {
  value: string;
  onValueChange: (value: string) => void;
  label: string;
}

/// 颜色选择：原生取色器 + 十六进制文本，值统一为 #rrggbb。
export function ColorField({ value, onValueChange, label }: ColorFieldProps) {
  return (
    <label className="flex items-center gap-2">
      <input
        type="color"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        aria-label={label}
        className="h-7 w-9 cursor-pointer rounded-chip border border-line bg-elevated p-0.5"
      />
      <span className="text-footnote tabular-nums text-tertiary">
        {value.toUpperCase()}
      </span>
    </label>
  );
}
