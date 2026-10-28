import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useAppStore } from "../stores/appStore";
import { useChatStore } from "../stores/chatStore";
import { useProviderStore } from "../stores/providerStore";
import { api, parseAdapterError, adapterErrorTitle } from "../lib/api";
import { toast } from "../lib/notify";
import { IconClose } from "./Icons";
import SafeImg from "./SafeImg";

type Side = "top" | "right" | "bottom" | "left";

interface Offsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const PRESETS = [
  { id: "free", label: "自由" },
  { id: "16:9", label: "16:9" },
  { id: "9:16", label: "9:16" },
  { id: "1:1", label: "1:1" },
];

export default function OutpaintView() {
  const target = useAppStore((s) => s.outpaintTarget);
  const closeOutpaint = useAppStore((s) => s.closeOutpaint);
  const defaultProviderId = useProviderStore((s) => s.defaultProviderId);
  const providers = useProviderStore((s) => s.providers);

  const containerRef = useRef<HTMLDivElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [display, setDisplay] = useState({ w: 0, h: 0, scale: 1 });
  const [offsets, setOffsets] = useState<Offsets>({
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  });
  const [preset, setPreset] = useState("free");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dragSide = useRef<Side | null>(null);
  const dragStart = useRef({ x: 0, y: 0, offsets: offsets });

  useEffect(() => {
    if (!target) return;
    const img = new Image();
    img.onload = () => setImage(img);
    img.src = target.dataUrl;
  }, [target]);

  useEffect(() => {
    if (!image || !containerRef.current) return;
    const box = containerRef.current.getBoundingClientRect();
    const scale = Math.min(
      (box.width - 220) / image.naturalWidth,
      (box.height - 220) / image.naturalHeight,
      1,
    );
    setDisplay({
      w: Math.round(image.naturalWidth * scale),
      h: Math.round(image.naturalHeight * scale),
      scale,
    });
    setOffsets({ top: 0, right: 0, bottom: 0, left: 0 });
  }, [image]);

  if (!target) return null;

  const naturalW = image?.naturalWidth ?? 1;
  const naturalH = image?.naturalHeight ?? 1;

  const applyPreset = (id: string) => {
    setPreset(id);
    if (id === "free") return;
    const [tw, th] = id.split(":").map(Number);
    const targetAspect = tw / th;
    const curW = naturalW;
    const curH = naturalH;
    const curAspect = curW / curH;
    let off: Offsets;
    if (curAspect > targetAspect) {
      // 太宽：上下加
      const newH = Math.round(curW / targetAspect);
      const add = Math.round((newH - curH) / 2);
      off = { top: add, bottom: add, right: 0, left: 0 };
    } else {
      const newW = Math.round(curH * targetAspect);
      const add = Math.round((newW - curW) / 2);
      off = { right: add, left: add, top: 0, bottom: 0 };
    }
    // 转为显示像素
    const s = display.scale || 1;
    setOffsets({
      top: Math.round(off.top * s),
      bottom: Math.round(off.bottom * s),
      right: Math.round(off.right * s),
      left: Math.round(off.left * s),
    });
  };

  const startDrag = (side: Side) => (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragSide.current = side;
    dragStart.current = { x: e.clientX, y: e.clientY, offsets };
  };

  /** 键盘微调：手柄拿到焦点后用方向键推 8px（拖拽之外的第二条操作路径） */
  const nudge = (side: Side, delta: number) => {
    setPreset("free");
    setOffsets((o) => ({
      ...o,
      [side]: Math.max(0, Math.min(4096, o[side] + delta)),
    }));
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragSide.current) return;
    const side = dragSide.current;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    const next = { ...dragStart.current.offsets };
    const maxPad = 4096;
    if (side === "right")
      next.right = Math.max(
        0,
        Math.min(maxPad, dragStart.current.offsets.right + dx),
      );
    if (side === "left")
      next.left = Math.max(
        0,
        Math.min(maxPad, dragStart.current.offsets.left - dx),
      );
    if (side === "bottom")
      next.bottom = Math.max(
        0,
        Math.min(maxPad, dragStart.current.offsets.bottom + dy),
      );
    if (side === "top")
      next.top = Math.max(
        0,
        Math.min(maxPad, dragStart.current.offsets.top - dy),
      );
    if (preset !== "free") setPreset("free");
    setOffsets(next);
  };

  const endDrag = () => {
    dragSide.current = null;
  };

  const targetW =
    naturalW +
    Math.round((offsets.left + offsets.right) / (display.scale || 1));
  const targetH =
    naturalH +
    Math.round((offsets.top + offsets.bottom) / (display.scale || 1));
  const changed =
    offsets.left + offsets.right + offsets.top + offsets.bottom > 0;

  const submit = async () => {
    if (!image || !changed) return;
    if (defaultProviderId == null) {
      toast("请先在「设置」中配置服务商", "error");
      return;
    }
    const model = providers.find((p) => p.provider.id === defaultProviderId)
      ?.provider.defaultModel;
    if (!model) {
      toast("请先在「设置」中选择默认模型", "error");
      return;
    }
    const s = display.scale || 1;
    const tw = naturalW + Math.round((offsets.left + offsets.right) / s);
    const th = naturalH + Math.round((offsets.top + offsets.bottom) / s);
    // 透明 padding 到目标尺寸（gpt-image-1 扩图规范）
    const canvas = document.createElement("canvas");
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(
      image,
      Math.round(offsets.left / s),
      Math.round(offsets.top / s),
    );
    const finalPrompt =
      prompt.trim() ||
      "Extend the scene naturally to fill the transparent areas, matching the original style, lighting and content.";
    setBusy(true);
    setError(null);
    try {
      const out = await api.editImage({
        providerId: defaultProviderId,
        prompt: finalPrompt,
        model,
        imageB64: canvas.toDataURL("image/png"),
        maskB64: null,
        width: tw,
        height: th,
      });
      const displayPrompt = `（扩图 ${tw}×${th}）`;
      await useChatStore.getState().appendImageMessage(
        {
          historyId: out.historyId,
          dataUrl: out.dataUrl,
          path: out.filePath,
        },
        displayPrompt,
      );
      closeOutpaint();
    } catch (e) {
      const parsed = parseAdapterError(String(e));
      setError(`${adapterErrorTitle(parsed)}：${parsed.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handles: { side: Side; style: React.CSSProperties }[] = [
    {
      side: "top",
      style: {
        top: -offsets.top - 6,
        left: "50%",
        transform: "translateX(-50%)",
        cursor: "ns-resize",
      },
    },
    {
      side: "bottom",
      style: {
        bottom: -offsets.bottom - 6,
        left: "50%",
        transform: "translateX(-50%)",
        cursor: "ns-resize",
      },
    },
    {
      side: "left",
      style: {
        left: -offsets.left - 6,
        top: "50%",
        transform: "translateY(-50%)",
        cursor: "ew-resize",
      },
    },
    {
      side: "right",
      style: {
        right: -offsets.right - 6,
        top: "50%",
        transform: "translateY(-50%)",
        cursor: "ew-resize",
      },
    },
  ];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-40 flex flex-col bg-base"
    >
      <div className="bg-glass flex h-[52px] shrink-0 items-center gap-3 border-b border-theme px-4">
        <span className="text-sm font-medium text-primary">扩图</span>
        <span className="text-xs text-tertiary">
          向外拖动手柄扩展画面，AI 补全内容
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={submit}
            disabled={busy || !changed}
            className="pressable rounded-[10px] bg-accent px-4 py-1.5 text-sm font-medium text-white transition-opacity disabled:opacity-40"
          >
            {busy ? "扩图中…" : "生成扩图"}
          </button>
          <button
            onClick={closeOutpaint}
            title="关闭"
            className="pressable rounded-[10px] border border-theme p-2 text-secondary transition-colors hover:bg-hover"
          >
            <IconClose size={14} />
          </button>
        </div>
      </div>

      <div className="bg-glass flex shrink-0 flex-wrap items-center gap-2 border-b border-theme px-4 py-2">
        <span className="text-xs text-tertiary">目标比例</span>
        {PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => applyPreset(p.id)}
            className={`pressable rounded-[8px] border px-2.5 py-1 text-xs transition-colors ${
              preset === p.id
                ? "border-accent bg-accent-soft text-accent"
                : "border-theme text-tertiary hover:text-secondary"
            }`}
          >
            {p.label}
          </button>
        ))}
        <span className="text-xs tabular-nums text-tertiary">
          {targetW} × {targetH}
        </span>
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="补充描述（可选）：如“延伸出海面与晚霞”"
          className="min-w-0 flex-1 rounded-lg border border-theme bg-transparent px-3 py-1.5 text-sm outline-none transition-colors focus:border-accent"
        />
      </div>

      <div
        ref={containerRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-8"
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
      >
        {image ? (
          <div className="relative">
            {/* 目标区域虚线框 */}
            {changed && (
              <div
                className="pointer-events-none absolute rounded-lg border-2 border-dashed border-accent/60"
                style={{
                  top: -offsets.top,
                  left: -offsets.left,
                  width: display.w + offsets.left + offsets.right,
                  height: display.h + offsets.top + offsets.bottom,
                }}
              />
            )}
            <div
              className="relative overflow-hidden rounded-lg shadow-pop"
              style={{ width: display.w, height: display.h }}
            >
              <SafeImg
                src={target.dataUrl}
                alt="扩图对象"
                className="absolute inset-0 h-full w-full"
              />
            </div>
            {handles.map((h) => (
              <div
                key={h.side}
                style={h.style}
                role="slider"
                aria-label={`向${h.side === "left" ? "左" : h.side === "right" ? "右" : h.side === "top" ? "上" : "下"}扩图`}
                aria-valuenow={0}
                tabIndex={0}
                onKeyDown={(e) => {
                  // 键盘兜底：方向键按 8px 步进取值（视觉手柄原本只能拖拽）
                  const step = 8;
                  const map: Record<string, () => void> = {
                    ArrowLeft: () => nudge("left", -step),
                    ArrowRight: () => nudge("right", step),
                    ArrowUp: () => nudge("top", -step),
                    ArrowDown: () => nudge("bottom", step),
                  };
                  const fn = map[e.key];
                  if (fn) {
                    e.preventDefault();
                    fn();
                  }
                }}
                onPointerDown={(e) => {
                  // 指针捕获在 startDrag 内完成；这里补 release，避免捕获状态泄漏
                  startDrag(h.side)(e);
                }}
                onPointerUp={(e) => {
                  if (e.currentTarget.hasPointerCapture(e.pointerId))
                    e.currentTarget.releasePointerCapture(e.pointerId);
                }}
                className="absolute z-10 h-3.5 w-12 touch-none rounded-full border border-theme bg-elevated shadow-card"
              />
            ))}
          </div>
        ) : (
          <span className="text-sm text-tertiary">加载中…</span>
        )}
      </div>

      {error && (
        <div className="shrink-0 border-t border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger">
          {error}
        </div>
      )}
    </motion.div>
  );
}
