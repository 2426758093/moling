import { CSSProperties, useState } from "react";

/**
 * 带加载失败兜底的图片。
 *
 * 背景：画廊 / 聊天 / 编辑器里的图片都来自磁盘（dataUrl），文件被外部删除、
 * 磁盘损坏、懒迁移失败时 <img> 只会渲染成空白且不报错，用户完全不知道发生
 * 了什么。这里统一切成一个可读的「图片缺失」占位，并把错误暴露在 alt 上。
 */
export default function SafeImg({
  src,
  alt,
  className,
  style,
  draggable = false,
  loading,
  decoding,
}: {
  src: string;
  alt: string;
  className?: string;
  style?: CSSProperties;
  draggable?: boolean;
  loading?: "eager" | "lazy";
  decoding?: "sync" | "async" | "auto";
}) {
  // 记录「哪一个 src 加载失败」，而不是布尔值：src 变化时（编辑器复用同一节点
  // 切换结果图）自然回到未失败状态，无需副作用里 setState。
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const broken = !src || brokenSrc === src;

  if (broken) {
    return (
      <div
        role="img"
        aria-label={`${alt}（图片缺失）`}
        style={style}
        className={`${className ?? ""} flex items-center justify-center bg-sunken text-footnote text-tertiary`}
      >
        图片缺失
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      style={style}
      draggable={draggable}
      loading={loading}
      decoding={decoding}
      onError={() => setBrokenSrc(src)}
    />
  );
}
