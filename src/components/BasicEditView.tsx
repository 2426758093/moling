import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { BasicEditTarget, useAppStore } from "../stores/appStore";
import { api } from "../lib/api";
import { deliverEditResult } from "../lib/deliverEditResult";
import { toast } from "../lib/notify";
import { DUR, EASE } from "../lib/motion";
import { ensureRasterDataUrl } from "../lib/file";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Slider } from "./ui/Slider";
import { ToolbarGroup, ToolbarSeparator } from "./ui/Toolbar";
import { IconClose, IconCrop, IconFlip, IconRotate } from "./Icons";

/** 裁剪框（变换后坐标：旋转 / 翻转之后的画布） */
interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Corner = "nw" | "ne" | "sw" | "se";

type DragState =
  | { mode: "draw"; startX: number; startY: number; moved: boolean }
  | { mode: "resize"; corner: Corner; base: Crop };

const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));

function normalize(x0: number, y0: number, x1: number, y1: number): Crop {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    w: Math.abs(x1 - x0),
    h: Math.abs(y1 - y0),
  };
}

/// 基础编辑：裁剪 / 旋转 / 翻转 / 调色全部本地完成。
/// 预览用 CSS transform + filter 实时呈现（零延迟），确认时一次性提交 Rust 落盘，
/// 避免前后端各算一套像素导致所见非所得。
export default function BasicEditView() {
  const target = useAppStore((s) => s.basicEditTarget);
  const close = useAppStore((s) => s.closeBasicEdit);
  if (!target) return null;
  // key 变化重建内部状态：换图不用手动清像素缓存与裁剪框
  return (
    <BasicEditBody
      key={`${target.historyId}-${target.dataUrl.length}`}
      target={target}
      close={close}
    />
  );
}

function BasicEditBody({
  target,
  close,
}: {
  target: BasicEditTarget;
  close: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const { t } = useTranslation();
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [scale, setScale] = useState(1);
  const [deg, setDeg] = useState<0 | 90 | 180 | 270>(0);
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [crop, setCrop] = useState<Crop | null>(null);
  const [brightness, setBrightness] = useState(0);
  const [contrast, setContrast] = useState(0);
  const [saturation, setSaturation] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvasInline = useAppStore((s) => s.canvasInline);
  const reduce = useReducedMotion();
  const inline = canvasInline && target.host === "canvas";

  useEffect(() => {
    const img = new Image();
    img.onload = () => setImage(img);
    img.src = target.dataUrl;
  }, [target.dataUrl]);

  // 旋转后画布尺寸（90/270 长宽互换）
  const natW = image?.naturalWidth ?? 0;
  const natH = image?.naturalHeight ?? 0;
  const canvasW = deg % 180 === 0 ? natW : natH;
  const canvasH = deg % 180 === 0 ? natH : natW;

  // 进入 / 换图 / 转向时重新贴合容器，并把裁剪框重置为全图
  useEffect(() => {
    if (!image || !containerRef.current) return;
    const box = containerRef.current.getBoundingClientRect();
    const w = deg % 180 === 0 ? image.naturalWidth : image.naturalHeight;
    const h = deg % 180 === 0 ? image.naturalHeight : image.naturalWidth;
    setScale(Math.min((box.width - 48) / w, (box.height - 48) / h, 1));
    setCrop({ x: 0, y: 0, w, h });
  }, [image, deg]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const displayW = Math.round(canvasW * scale);
  const displayH = Math.round(canvasH * scale);
  const shown = crop ?? { x: 0, y: 0, w: canvasW, h: canvasH };

  const outW = Math.round(shown.w);
  const outH = Math.round(shown.h);
  const changed = useMemo(
    () =>
      deg !== 0 ||
      flipH ||
      flipV ||
      brightness !== 0 ||
      contrast !== 0 ||
      saturation !== 0 ||
      outW !== canvasW ||
      outH !== canvasH,
    [
      deg,
      flipH,
      flipV,
      brightness,
      contrast,
      saturation,
      outW,
      outH,
      canvasW,
      canvasH,
    ],
  );

  const pointOf = (e: React.PointerEvent) => {
    const rect = stageRef.current!.getBoundingClientRect();
    return {
      x: clamp((e.clientX - rect.left) / scale, 0, canvasW),
      y: clamp((e.clientY - rect.top) / scale, 0, canvasH),
    };
  };

  const onStageDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || busy) return;
    const p = pointOf(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      mode: "draw",
      startX: p.x,
      startY: p.y,
      moved: false,
    };
  };

  const onStageMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const p = pointOf(e);
    if (drag.mode === "draw") {
      if (Math.abs(p.x - drag.startX) + Math.abs(p.y - drag.startY) > 2) {
        drag.moved = true;
      }
      if (drag.moved) {
        const r = normalize(drag.startX, drag.startY, p.x, p.y);
        // 拖拽过小按点击处理，保留原裁剪框
        setCrop(r.w >= 4 && r.h >= 4 ? r : crop);
      }
      return;
    }
    const b = drag.base;
    let next = { ...b };
    switch (drag.corner) {
      case "nw":
        next = normalize(p.x, p.y, b.x + b.w, b.y + b.h);
        break;
      case "ne":
        next = normalize(b.x, p.y, p.x, b.y + b.h);
        break;
      case "sw":
        next = normalize(p.x, b.y, b.x + b.w, p.y);
        break;
      case "se":
        next = normalize(b.x, b.y, p.x, p.y);
        break;
    }
    if (next.w >= 4 && next.h >= 4) setCrop(next);
  };

  const onStageUp = () => {
    dragRef.current = null;
  };

  const startResize = (corner: Corner) => (e: React.PointerEvent) => {
    if (e.button !== 0 || busy) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { mode: "resize", corner, base: shown };
  };

  const resetCrop = () => setCrop({ x: 0, y: 0, w: canvasW, h: canvasH });

  const submit = async () => {
    if (!image || busy) return;
    if (!changed) {
      toast(t("还没有任何改动"), "error");
      return;
    }
    const ops: Parameters<typeof api.applyEdit>[0]["ops"] = [];
    if (deg !== 0) ops.push({ type: "rotate", deg });
    if (flipH) ops.push({ type: "flip", axis: "horizontal" });
    if (flipV) ops.push({ type: "flip", axis: "vertical" });
    if (shown.x > 0 || shown.y > 0 || outW < canvasW || outH < canvasH) {
      const x = clamp(Math.round(shown.x), 0, Math.max(0, canvasW - 1));
      const y = clamp(Math.round(shown.y), 0, Math.max(0, canvasH - 1));
      ops.push({
        type: "crop",
        x,
        y,
        width: clamp(outW, 1, canvasW - x),
        height: clamp(outH, 1, canvasH - y),
      });
    }
    if (brightness !== 0 || contrast !== 0 || saturation !== 0) {
      ops.push({ type: "adjust", brightness, contrast, saturation });
    }
    setBusy(true);
    setError(null);
    try {
      const out = await api.applyEdit({
        imageB64: await ensureRasterDataUrl(target.dataUrl),
        ops,
        parentId: target.historyId,
      });
      await deliverEditResult(target, out, t("基础编辑"));
      close();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const filter = `brightness(${1 + brightness / 100}) contrast(${
    1 + contrast / 100
  }) saturate(${1 + saturation / 100})`;

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
            <h1 className="truncate text-title3 text-primary">
              {t("基础编辑")}
            </h1>
            <p className="truncate text-footnote text-tertiary">
              {t("裁剪、旋转、翻转与调色全在本地完成，不消耗接口额度")}
            </p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              disabled={!image || !changed}
              onClick={() => void submit()}
            >
              {t("应用编辑")}
            </Button>
            <IconButton
              label={t("关闭编辑器")}
              icon={<IconClose size={16} />}
              onClick={close}
            />
          </div>
        </div>

        <div
          role="toolbar"
          aria-label={t("基础编辑工具")}
          className="flex flex-wrap items-center gap-2 px-6 pb-2.5"
        >
          <ToolbarGroup>
            <IconButton
              label={t("左转 90°")}
              icon={<IconRotate size={16} className="-scale-x-100" />}
              onClick={() => setDeg((d) => ((d + 270) % 360) as typeof d)}
            />
            <IconButton
              label={t("右转 90°")}
              icon={<IconRotate size={16} />}
              onClick={() => setDeg((d) => ((d + 90) % 360) as typeof d)}
            />
            <IconButton
              label={flipH ? t("取消水平翻转") : t("水平翻转")}
              icon={<IconFlip size={16} />}
              variant={flipH ? "secondary" : "ghost"}
              aria-pressed={flipH}
              onClick={() => setFlipH((v) => !v)}
            />
            <IconButton
              label={flipV ? t("取消垂直翻转") : t("垂直翻转")}
              icon={<IconFlip size={16} className="rotate-90" />}
              variant={flipV ? "secondary" : "ghost"}
              aria-pressed={flipV}
              onClick={() => setFlipV((v) => !v)}
            />
          </ToolbarGroup>

          <ToolbarSeparator />

          <ToolbarGroup>
            <span className="px-1 text-tertiary">
              <IconCrop size={16} />
            </span>
            <Button size="sm" variant="ghost" onClick={resetCrop}>
              {t("全图")}
            </Button>
          </ToolbarGroup>

          <ToolbarSeparator />

          {(
            [
              { label: "亮度", value: brightness, set: setBrightness },
              { label: "对比度", value: contrast, set: setContrast },
              { label: "饱和度", value: saturation, set: setSaturation },
            ] as const
          ).map((s) => (
            <div key={s.label} className="flex items-center gap-2">
              <span className="text-footnote text-tertiary">{t(s.label)}</span>
              <div className="w-24">
                <Slider
                  value={s.value}
                  onValueChange={s.set}
                  min={-100}
                  max={100}
                  label={t(s.label)}
                />
              </div>
              <span className="w-8 text-right text-footnote tabular-nums text-tertiary">
                {s.value}
              </span>
            </div>
          ))}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setBrightness(0);
              setContrast(0);
              setSaturation(0);
            }}
          >
            {t("重置色彩")}
          </Button>
        </div>
      </header>

      <div
        ref={containerRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-6"
      >
        {image ? (
          <div
            ref={stageRef}
            className="relative touch-none overflow-hidden rounded-card shadow-pop"
            style={{
              width: displayW,
              height: displayH,
              cursor: "crosshair",
            }}
            onPointerDown={onStageDown}
            onPointerMove={onStageMove}
            onPointerUp={onStageUp}
            onPointerCancel={onStageUp}
          >
            <img
              src={target.dataUrl}
              alt={t("编辑对象")}
              draggable={false}
              className="pointer-events-none absolute left-1/2 top-1/2 max-w-none select-none"
              style={{
                width: natW * scale,
                height: natH * scale,
                transform: `translate(-50%, -50%) scaleX(${
                  flipH ? -1 : 1
                }) scaleY(${flipV ? -1 : 1}) rotate(${deg}deg)`,
                filter,
              }}
            />
            <div
              className="pointer-events-none absolute border border-on-accent"
              style={{
                left: shown.x * scale,
                top: shown.y * scale,
                width: Math.max(1, shown.w * scale),
                height: Math.max(1, shown.h * scale),
                boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.45)",
              }}
            />
            {CORNERS.map((c) => {
              const left =
                (c === "nw" || c === "sw" ? shown.x : shown.x + shown.w) *
                scale;
              const top =
                (c === "nw" || c === "ne" ? shown.y : shown.y + shown.h) *
                scale;
              return (
                <span
                  key={c}
                  role="presentation"
                  onPointerDown={startResize(c)}
                  className="absolute z-10 block h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-chip border border-on-accent bg-elevated"
                  style={{
                    left,
                    top,
                    cursor:
                      c === "nw" || c === "se" ? "nwse-resize" : "nesw-resize",
                    touchAction: "none",
                  }}
                />
              );
            })}
          </div>
        ) : (
          <span className="text-body text-tertiary">{t("加载中…")}</span>
        )}
      </div>

      <footer className="flex shrink-0 items-center gap-3 border-t border-line px-6 py-2">
        <span className="text-footnote tabular-nums text-tertiary">
          {t("输出 {{w}} × {{h}}", { w: outW, h: outH })}
        </span>
        <span className="text-footnote text-tertiary">
          {t("在图上拖拽框选裁剪区域，拖动角点可微调")}
        </span>
      </footer>

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
