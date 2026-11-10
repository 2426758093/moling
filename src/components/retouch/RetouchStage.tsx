import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import { useTranslation } from "react-i18next";
import SafeImg from "../SafeImg";
import MaskCanvas, { type MaskCanvasHandle } from "../MaskCanvas";
import BeforeAfterCompare from "./BeforeAfterCompare";

/** 舞台内边距（p-3）：算显示尺寸时要扣掉，否则图片会贴边被裁 */
const STAGE_PADDING = 12;

interface Natural {
  width: number;
  height: number;
}

/** 解码结果按 src 记：换图时无需先清状态，派生时自然失效 */
interface Loaded {
  src: string;
  img: HTMLImageElement;
  width: number;
  height: number;
}

/// 等比「塞进」舞台：与 EditorView 同一口径，取 min 缩放比，不放大。
function fitBox(
  boxWidth: number,
  boxHeight: number,
  natural: Natural | null,
): { width: number; height: number } {
  if (!(boxWidth > 0) || !(boxHeight > 0)) return { width: 0, height: 0 };
  if (!natural || !(natural.width > 0) || !(natural.height > 0)) {
    return { width: Math.round(boxWidth), height: Math.round(boxHeight) };
  }
  const scale = Math.min(
    boxWidth / natural.width,
    boxHeight / natural.height,
    1,
  );
  return {
    width: Math.round(natural.width * scale),
    height: Math.round(natural.height * scale),
  };
}

interface Props {
  /** 当前步图（蒙版与尺寸都以它为准） */
  src: string;
  /** 首帧原图 */
  before: string;
  alt: string;
  /** 有可对比的结果时为 true */
  compare: boolean;
  /** 专家预览图；为空表示看已提交的结果 */
  previewUrl: string | null;
  /** 比对左 / 右图角标：由调用方按「首帧是什么」决定 */
  beforeLabel?: string;
  afterLabel?: string;
  /** 消除面板打开时叠加蒙版画布 */
  maskActive: boolean;
  brushSize: number;
  eraser: boolean;
  busy: boolean;
  maskRef: Ref<MaskCanvasHandle>;
}

/// 舞台：图片 / 前后对比 / 蒙版三种形态，尺寸始终按原图比例居中。
export default function RetouchStage({
  src,
  before,
  alt,
  compare,
  previewUrl,
  beforeLabel,
  afterLabel,
  maskActive,
  brushSize,
  eraser,
  busy,
  maskRef,
}: Props) {
  const { t } = useTranslation();
  const boxRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  // 尺寸与蒙版底图共用一次解码：MaskCanvas 需要 HTMLImageElement，
  // 舞台需要原图宽高比才能把对比层与图片对齐。
  useEffect(() => {
    let alive = true;
    const img = new Image();
    img.onload = () => {
      if (!alive) return;
      setLoaded({
        src,
        img,
        width: img.naturalWidth,
        height: img.naturalHeight,
      });
    };
    img.onerror = () => {
      if (alive) setLoaded(null);
    };
    img.src = src;
    return () => {
      alive = false;
    };
  }, [src]);

  const current = loaded && loaded.src === src ? loaded : null;
  const natural = useMemo(
    () => (current ? { width: current.width, height: current.height } : null),
    [current],
  );

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setFrame(
        fitBox(
          rect.width - STAGE_PADDING * 2,
          rect.height - STAGE_PADDING * 2,
          natural,
        ),
      );
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [natural]);

  const frameStyle =
    frame.width > 0 && frame.height > 0
      ? { width: frame.width, height: frame.height }
      : undefined;

  return (
    <div
      ref={boxRef}
      className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-sunken p-3"
    >
      <div
        className={
          frameStyle
            ? "relative overflow-hidden rounded-card"
            : "relative h-full w-full overflow-hidden rounded-card"
        }
        style={frameStyle}
      >
        {maskActive ? (
          <>
            <SafeImg
              src={src}
              alt={alt}
              className="pointer-events-none absolute inset-0 h-full w-full object-contain"
              decoding="async"
            />
            <MaskCanvas
              // 每个 src 一份独立画布：换步后旧笔画不能按旧画布尺寸导出
              key={src}
              ref={maskRef}
              image={current?.img ?? null}
              brushSize={brushSize}
              eraser={eraser}
              className="absolute inset-0 h-full w-full cursor-crosshair opacity-60"
            />
          </>
        ) : (
          <BeforeAfterCompare
            before={before}
            after={previewUrl ?? src}
            alt={alt}
            compare={compare}
            badge={previewUrl ? t("预览") : null}
            beforeLabel={beforeLabel}
            afterLabel={afterLabel}
          />
        )}
      </div>
      {busy && (
        <span className="glass-media pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-pill px-2 py-0.5 text-caption text-on-accent">
          {t("处理中…")}
        </span>
      )}
    </div>
  );
}
