import { useEffect, useImperativeHandle, useRef } from "react";

export interface MaskCanvasHandle {
  clear: () => void;
  fillAll: () => void;
  /** 黑底 + 透明孔：OpenAI 兼容 inpainting 的蒙版口径 */
  toAlphaPng: () => string | null;
  /** 黑底 + 白笔画：本地合成用的「白 = 替换」口径 */
  toLumaPng: () => string | null;
  hasStrokes: () => boolean;
}

interface MaskCanvasProps {
  image: HTMLImageElement | null;
  brushSize: number;
  eraser: boolean;
  className?: string;
  ref?: React.Ref<MaskCanvasHandle>;
}

/// 蒙版画布：局部重绘 / AI 消除 / 换背景三处共用。
/// 画布像素尺寸始终等于原图，显示尺寸交给外层 CSS，蒙版导出与上游像素对齐。
export default function MaskCanvas({
  image,
  brushSize,
  eraser,
  className,
  ref,
}: MaskCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }, [image]);

  const toNatural = (e: React.PointerEvent) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const paintAt = (e: React.PointerEvent, line: boolean) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { x, y } = toNatural(e);
    ctx.globalCompositeOperation = eraser ? "destination-out" : "source-over";
    if (line) {
      ctx.strokeStyle = "#ff383c";
      ctx.lineWidth = brushSize;
      ctx.lineTo(x, y);
      ctx.stroke();
      return;
    }
    ctx.fillStyle = "#ff383c";
    ctx.beginPath();
    ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
  };

  const alphaData = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return null;
    return {
      canvas,
      data: ctx.getImageData(0, 0, canvas.width, canvas.height),
    };
  };

  const exportMask = (mode: "alpha" | "luma"): string | null => {
    const got = alphaData();
    if (!got) return null;
    const { canvas, data } = got;
    const off = document.createElement("canvas");
    off.width = canvas.width;
    off.height = canvas.height;
    const ctx = off.getContext("2d");
    if (!ctx) return null;
    const out = ctx.createImageData(off.width, off.height);
    for (let i = 0; i < data.data.length; i += 4) {
      const a = data.data[i + 3];
      if (mode === "luma") {
        // 白 = 替换区域
        out.data[i] = a;
        out.data[i + 1] = a;
        out.data[i + 2] = a;
        out.data[i + 3] = 255;
      } else {
        // 黑底 + 透明孔（画笔处 alpha=0）
        out.data[i] = 0;
        out.data[i + 1] = 0;
        out.data[i + 2] = 0;
        out.data[i + 3] = 255 - a;
      }
    }
    ctx.putImageData(out, 0, 0);
    return off.toDataURL("image/png");
  };

  useImperativeHandle(ref, () => ({
    clear: () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
    fillAll: () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#ff383c";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    },
    toAlphaPng: () => exportMask("alpha"),
    toLumaPng: () => exportMask("luma"),
    hasStrokes: () => {
      const got = alphaData();
      if (!got) return false;
      for (let i = 3; i < got.data.data.length; i += 4) {
        if (got.data.data[i] !== 0) return true;
      }
      return false;
    },
  }));

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ touchAction: "none" }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const ctx = canvasRef.current?.getContext("2d");
        if (ctx) {
          const { x, y } = toNatural(e);
          ctx.globalCompositeOperation = eraser
            ? "destination-out"
            : "source-over";
          ctx.strokeStyle = "#ff383c";
          ctx.fillStyle = "#ff383c";
          ctx.lineWidth = brushSize;
          ctx.beginPath();
          ctx.moveTo(x, y);
        }
        paintAt(e, false);
      }}
      onPointerMove={(e) => {
        if (e.buttons === 1) paintAt(e, true);
      }}
      onPointerUp={() => {
        canvasRef.current?.getContext("2d")?.beginPath();
      }}
    />
  );
}
