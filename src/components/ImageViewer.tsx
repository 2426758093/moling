import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import SafeImg from "./SafeImg";
import { IconClose, IconExpand, IconChevron } from "./Icons";

export interface ViewerImage {
  dataUrl: string;
  title?: string;
}

/// 浮在图片之上的工具栏：clear 玻璃 + 压暗层，保证任何画面上都读得清。
const BAR_BTN =
  "pressable flex items-center justify-center rounded-pill p-2 text-on-accent transition-colors hover:bg-on-accent/15";

export default function ImageViewer({
  images,
  index,
  onIndexChange,
  onClose,
}: {
  images: ViewerImage[];
  index: number;
  onIndexChange: (i: number) => void;
  onClose: () => void;
}) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [fullscreen, setFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  // 切换图片时在渲染期间重置缩放/位移，替代「effect 内 setState」
  const [viewedIndex, setViewedIndex] = useState(index);
  if (viewedIndex !== index) {
    setViewedIndex(index);
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && index > 0) onIndexChange(index - 1);
      if (e.key === "ArrowRight" && index < images.length - 1)
        onIndexChange(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, images.length, onIndexChange, onClose]);

  useEffect(() => {
    const onFullscreenChange = () =>
      setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  const current = images[index];
  if (!current) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label="图片查看器"
      className="fixed inset-0 z-50 flex flex-col bg-black"
      onClick={onClose}
    >
      <div
        className="glass-media flex min-h-12 shrink-0 items-center justify-between px-4"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="text-subhead tabular-nums text-on-accent/80">
          {index + 1} / {images.length}
          {scale !== 1 && ` · ${Math.round(scale * 100)}%`}
        </span>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => {
              if (document.fullscreenElement) {
                document.exitFullscreen();
              } else {
                containerRef.current?.requestFullscreen();
              }
            }}
            aria-label={fullscreen ? "退出全屏" : "全屏查看"}
            className={BAR_BTN}
          >
            <IconExpand size={15} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭查看器"
            className={BAR_BTN}
          >
            <IconClose size={15} />
          </button>
        </div>
      </div>
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        onWheel={(e) => {
          const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
          setScale((s) => Math.min(8, Math.max(0.1, s * factor)));
        }}
        onMouseDown={(e) => {
          dragRef.current = {
            x: e.clientX - offset.x,
            y: e.clientY - offset.y,
          };
        }}
        onMouseMove={(e) => {
          if (dragRef.current) {
            setOffset({
              x: e.clientX - dragRef.current.x,
              y: e.clientY - dragRef.current.y,
            });
          }
        }}
        onMouseUp={() => (dragRef.current = null)}
        onMouseLeave={() => (dragRef.current = null)}
        onDoubleClick={reset}
        onClick={(e) => e.stopPropagation()}
      >
        <SafeImg
          src={current.dataUrl}
          alt={current.title ?? ""}
          className="max-h-full max-w-full cursor-grab select-none active:cursor-grabbing"
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          }}
        />
        {index > 0 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onIndexChange(index - 1);
            }}
            aria-label="上一张"
            className={`glass-media absolute left-3 ${BAR_BTN}`}
          >
            <IconChevron direction="left" size={18} />
          </button>
        )}
        {index < images.length - 1 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onIndexChange(index + 1);
            }}
            aria-label="下一张"
            className={`glass-media absolute right-3 ${BAR_BTN}`}
          >
            <IconChevron direction="right" size={18} />
          </button>
        )}
      </div>
    </motion.div>
  );
}
