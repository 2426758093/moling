import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/appStore";
import { useProviderStore } from "../stores/providerStore";
import { api, parseAdapterError, adapterErrorTitle } from "../lib/api";
import { deliverEditResult } from "../lib/deliverEditResult";
import { toast } from "../lib/notify";
import { DUR, EASE } from "../lib/motion";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Input } from "./ui/Field";
import { SegmentedControl } from "./ui/SegmentedControl";
import { IconClose } from "./Icons";
import SafeImg from "./SafeImg";

type Side = "top" | "right" | "bottom" | "left";

interface Offsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/// 目标比例：只有「自由」需要翻译，数值比例直接展示原值
const PRESET_RATIOS = ["16:9", "9:16", "1:1"] as const;

const SIDE_LABEL = {
  top: "上",
  right: "右",
  bottom: "下",
  left: "左",
} as const;

export default function OutpaintView() {
  const { t } = useTranslation();
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
  const canvasInline = useAppStore((s) => s.canvasInline);
  const reduce = useReducedMotion();

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeOutpaint();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeOutpaint]);

  if (!target) return null;

  const inline = canvasInline && target.host === "canvas";

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
      toast(t("请先在「设置」中配置服务商"), "error");
      return;
    }
    const model = providers.find((p) => p.provider.id === defaultProviderId)
      ?.provider.defaultModel;
    if (!model) {
      toast(t("请先在「设置」中选择默认模型"), "error");
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
        op: "outpaint",
        parentId: target.historyId,
      });
      if (out.warning) toast(out.warning, "error");
      const displayPrompt = t("（扩图 {{w}}×{{h}}）", { w: tw, h: th });
      await deliverEditResult(
        target,
        { ...out, width: tw, height: th },
        displayPrompt,
      );
      closeOutpaint();
    } catch (e) {
      const parsed = parseAdapterError(String(e));
      setError(
        t("{{title}}：{{message}}", {
          title: adapterErrorTitle(parsed),
          message: parsed.message,
        }),
      );
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
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduce ? 0 : DUR.base, ease: EASE.ios }}
      className={
        inline
          ? "flex h-full min-h-0 w-full flex-col bg-base"
          : "fixed inset-x-0 bottom-0 top-12 z-30 flex flex-col bg-base"
      }
    >
      <header className="relative z-10 shrink-0 glass">
        <div className="flex min-h-12 items-center gap-3 px-6 py-2">
          <div className="flex min-w-0 flex-col">
            <h1 className="truncate text-title3 text-primary">{t("扩图")}</h1>
            <p className="truncate text-footnote text-tertiary">
              {t("向外拖动手柄扩展画面，AI 补全内容")}
            </p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              disabled={!changed}
              onClick={() => void submit()}
            >
              {t("生成扩图")}
            </Button>
            <IconButton
              label={t("关闭扩图")}
              icon={<IconClose size={16} />}
              onClick={closeOutpaint}
            />
          </div>
        </div>

        <div
          role="toolbar"
          aria-label={t("扩图工具")}
          className="flex flex-wrap items-center gap-3 px-6 pb-2.5"
        >
          <span className="text-footnote text-tertiary">{t("目标比例")}</span>
          <SegmentedControl
            value={preset}
            onValueChange={applyPreset}
            options={[
              { value: "free", label: t("自由") },
              ...PRESET_RATIOS.map((ratio) => ({ value: ratio, label: ratio })),
            ]}
            label={t("目标比例")}
            size="sm"
          />
          <span className="text-footnote tabular-nums text-tertiary">
            {targetW} × {targetH}
          </span>
          <div className="min-w-0 flex-1">
            <Input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t("补充描述（可选）：如“延伸出海面与晚霞”")}
              aria-label={t("补全描述")}
              compact
            />
          </div>
        </div>
      </header>

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
                className="pointer-events-none absolute rounded-card border-2 border-dashed border-accent/60"
                style={{
                  top: -offsets.top,
                  left: -offsets.left,
                  width: display.w + offsets.left + offsets.right,
                  height: display.h + offsets.top + offsets.bottom,
                }}
              />
            )}
            <div
              className="relative overflow-hidden rounded-card shadow-pop"
              style={{ width: display.w, height: display.h }}
            >
              <SafeImg
                src={target.dataUrl}
                alt={t("扩图对象")}
                className="absolute inset-0 h-full w-full"
              />
            </div>
            {handles.map((h) => (
              <div
                key={h.side}
                style={h.style}
                role="slider"
                aria-label={t("向{{side}}扩图", {
                  side: t(SIDE_LABEL[h.side]),
                })}
                aria-valuemin={0}
                aria-valuemax={4096}
                aria-valuenow={offsets[h.side]}
                aria-orientation={
                  h.side === "top" || h.side === "bottom"
                    ? "vertical"
                    : "horizontal"
                }
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
                className="absolute z-10 h-3.5 w-12 touch-none rounded-pill border border-line bg-elevated shadow-card transition-transform focus-visible:ring-2 focus-visible:ring-accent active:scale-110"
              />
            ))}
          </div>
        ) : (
          <span className="text-body text-tertiary">{t("加载中…")}</span>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="shrink-0 border-t border-danger/25 bg-danger/10 px-6 py-2 text-footnote text-danger"
        >
          {error}
        </div>
      )}
    </motion.div>
  );
}
