import { cn } from "./cn";

/// 生成中占位。禁止旋转 loading —— 骨架块的宽度与最终内容一致，不会让布局跳动。
export function Skeleton({
  className,
  count = 1,
}: {
  className?: string;
  count?: number;
}) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className={cn("shimmer rounded-card bg-sunken", className)}
        />
      ))}
    </>
  );
}
