import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BasicEditTarget, useAppStore } from "../stores/appStore";
import { api } from "../lib/api";
import { deliverEditResult } from "../lib/deliverEditResult";
import { toast } from "../lib/notify";
import { ensureRasterDataUrl } from "../lib/file";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Slider } from "./ui/Slider";
import { ToolbarGroup, ToolbarSeparator } from "./ui/Toolbar";
import { IconCrop, IconFlip, IconRotate } from "./Icons";
import EditorShell from "./editors/EditorShell";
import {
  buildBasicEditOps,
  normalizeFreeDeg,
  rotationBoundingBox,
  FREE_DEG_EPSILON,
  type QuarterTurns,
} from "../lib/basicEditRotation";

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
  const [quarterTurns, setQuarterTurns] = useState<QuarterTurns>(0);
  const [freeDeg, setFreeDeg] = useState(0);
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [crop, setCrop] = useState<Crop | null>(null);
  const [brightness, setBrightness] = useState(0);
  const [contrast, setContrast] = useState(0);
  const [saturation, setSaturation] = useState(0);
  const [busy, setBusy] = useState(false);
  const [straightening, setStraightening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvasInline = useAppStore((s) => s.canvasInline);
  const inline = canvasInline && target.host === "canvas";

  useEffect(() => {
    const img = new Image();
    img.onload = () => setImage(img);
    img.src = target.dataUrl;
  }, [target.dataUrl]);

  // 总角度 = 直角档 × 90 + 自由角；预览与提交都按总角度计算
  const rotation = quarterTurns * 90 + freeDeg;
  const natW = image?.naturalWidth ?? 0;
  const natH = image?.naturalHeight ?? 0;
  const { w: canvasW, h: canvasH } = image
    ? rotationBoundingBox(natW, natH, rotation)
    : { w: 0, h: 0 };
  // 与后端 rotate_free 的恒等阈值一致：极小角（仅自动拉直可能产生）不算自由旋转
  const free = Math.abs(freeDeg) >= FREE_DEG_EPSILON;
  // 自由旋转会留透明边，裁剪坐标失去意义，禁用框选与手柄
  const cropLocked = free;

  // 进入 / 换图 / 旋转时重新贴合容器，并把裁剪框重置为全图
  useEffect(() => {
    if (!image || !containerRef.current) return;
    const box = containerRef.current.getBoundingClientRect();
    const { w, h } = rotationBoundingBox(
      image.naturalWidth,
      image.naturalHeight,
      rotation,
    );
    setScale(Math.min((box.width - 48) / w, (box.height - 48) / h, 1));
    setCrop({ x: 0, y: 0, w, h });
  }, [image, rotation]);

  const displayW = Math.round(canvasW * scale);
  const displayH = Math.round(canvasH * scale);
  const shown = crop ?? { x: 0, y: 0, w: canvasW, h: canvasH };

  const outW = Math.round(shown.w);
  const outH = Math.round(shown.h);
  const changed = useMemo(
    () =>
      quarterTurns !== 0 ||
      free ||
      flipH ||
      flipV ||
      brightness !== 0 ||
      contrast !== 0 ||
      saturation !== 0 ||
      outW !== canvasW ||
      outH !== canvasH,
    [
      quarterTurns,
      free,
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
    if (e.button !== 0 || busy || cropLocked) return;
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
    if (e.button !== 0 || busy || cropLocked) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { mode: "resize", corner, base: shown };
  };

  const resetCrop = () => setCrop({ x: 0, y: 0, w: canvasW, h: canvasH });

  /// 自动拉直：后端返回的就是「可抵消的倾斜角」（正值 = 顺时针），
  /// 直接作为自由角即可拉正；失败只提示，不影响手动旋转。
  const autoStraighten = async () => {
    if (!image || busy || straightening) return;
    setStraightening(true);
    try {
      const angle = normalizeFreeDeg(
        await api.estimateSkew(await ensureRasterDataUrl(target.dataUrl)),
      );
      setFreeDeg(angle);
      if (Math.abs(angle) < 0.1) toast(t("画面已经很正"));
    } catch (e) {
      toast(t("自动拉直失败：{{error}}", { error: String(e) }), "error");
    } finally {
      setStraightening(false);
    }
  };

  const submit = async () => {
    if (!image || busy) return;
    if (!changed) {
      toast(t("还没有任何改动"), "error");
      return;
    }
    const ops = buildBasicEditOps({
      quarterTurns,
      freeDeg,
      flipH,
      flipV,
      canvasW,
      canvasH,
      crop: cropLocked ? null : shown,
      brightness,
      contrast,
      saturation,
    });
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
    <EditorShell
      inline={inline}
      onClose={close}
      title={t("基础编辑")}
      subtitle={t("裁剪、旋转、翻转与调色全在本地完成，不消耗接口额度")}
      headerExtra={
        <Button
          variant="primary"
          size="sm"
          loading={busy}
          disabled={!image || !changed}
          onClick={() => void submit()}
        >
          {t("应用编辑")}
        </Button>
      }
      toolbar={
        <div
          role="toolbar"
          aria-label={t("基础编辑工具")}
          className="flex flex-wrap items-center gap-2 px-6 pb-2.5"
        >
          <ToolbarGroup>
            <IconButton
              label={t("左转 90°")}
              icon={<IconRotate size={16} className="-scale-x-100" />}
              onClick={() =>
                setQuarterTurns((q) => ((q + 3) % 4) as QuarterTurns)
              }
            />
            <IconButton
              label={t("右转 90°")}
              icon={<IconRotate size={16} />}
              onClick={() =>
                setQuarterTurns((q) => ((q + 1) % 4) as QuarterTurns)
              }
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

          <div className="flex items-center gap-2">
            <span className="px-1 text-footnote text-tertiary">
              {t("任意角度")}
            </span>
            <div className="w-28">
              <Slider
                value={freeDeg}
                onValueChange={(v) => setFreeDeg(normalizeFreeDeg(v))}
                min={-180}
                max={180}
                step={1}
                disabled={busy}
                label={t("旋转角度")}
              />
            </div>
            <span className="w-9 text-right text-footnote tabular-nums text-tertiary">
              {Math.round(freeDeg)}°
            </span>
            <Button
              size="sm"
              variant="ghost"
              loading={straightening}
              disabled={!image || busy}
              onClick={() => void autoStraighten()}
            >
              {t("自动拉直")}
            </Button>
          </div>

          <ToolbarSeparator />

          <ToolbarGroup>
            <span className="px-1 text-tertiary">
              <IconCrop size={16} />
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={cropLocked}
              onClick={resetCrop}
            >
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
      }
      footer={
        <>
          <footer className="flex shrink-0 items-center gap-3 border-t border-line px-6 py-2">
            <span className="text-footnote tabular-nums text-tertiary">
              {t("输出 {{w}} × {{h}}", { w: outW, h: outH })}
            </span>
            <span className="text-footnote text-tertiary">
              {cropLocked
                ? t("自由旋转时不可裁剪")
                : t("在图上拖拽框选裁剪区域，拖动角点可微调")}
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
        </>
      }
    >
      <div
        ref={containerRef}
        className="relative flex h-full w-full items-center justify-center overflow-hidden p-6"
      >
        {image ? (
          <div
            ref={stageRef}
            className="relative touch-none overflow-hidden rounded-card shadow-pop"
            style={{
              width: displayW,
              height: displayH,
              cursor: cropLocked ? "default" : "crosshair",
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
                }) scaleY(${flipV ? -1 : 1}) rotate(${rotation}deg)`,
                filter,
              }}
            />
            {!cropLocked && (
              <>
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
                          c === "nw" || c === "se"
                            ? "nwse-resize"
                            : "nesw-resize",
                        touchAction: "none",
                      }}
                    />
                  );
                })}
              </>
            )}
          </div>
        ) : (
          <span className="text-body text-tertiary">{t("加载中…")}</span>
        )}
      </div>
    </EditorShell>
  );
}
