import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { IconClose, IconExpand, IconChevron } from "./Icons";

export interface ViewerImage {
  dataUrl: string;
  title?: string;
}

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
      className="fixed inset-0 z-50 flex flex-col bg-black"
      onClick={onClose}
    >
      <div
        className="flex h-[52px] shrink-0 items-center justify-between px-4 text-white/80"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="text-[13px] tabular-nums">
          {index + 1} / {images.length}
          {scale !== 1 && ` · ${Math.round(scale * 100)}%`}
        </span>
        <div className="flex gap-1">
          <button
            onClick={() => {
              if (document.fullscreenElement) {
                document.exitFullscreen();
              } else {
                containerRef.current?.requestFullscreen();
              }
            }}
            title={fullscreen ? "退出全屏" : "全屏"}
            className="pressable rounded-full bg-white/10 p-2 transition-colors hover:bg-white/20"
          >
            <IconExpand size={15} />
          </button>
          <button
            onClick={onClose}
            title="关闭"
            className="pressable rounded-full bg-white/10 p-2 transition-colors hover:bg-white/20"
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
        <img
          src={current.dataUrl}
          alt={current.title ?? ""}
          draggable={false}
          className="max-h-full max-w-full cursor-grab select-none active:cursor-grabbing"
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          }}
        />
        {index > 0 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onIndexChange(index - 1);
            }}
            className="pressable absolute left-3 rounded-full bg-white/10 p-2.5 text-white transition-colors hover:bg-white/20"
          >
            <IconChevron direction="left" size={18} />
          </button>
        )}
        {index < images.length - 1 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onIndexChange(index + 1);
            }}
            className="pressable absolute right-3 rounded-full bg-white/10 p-2.5 text-white transition-colors hover:bg-white/20"
          >
            <IconChevron direction="right" size={18} />
          </button>
        )}
      </div>
    </motion.div>
  );
}
