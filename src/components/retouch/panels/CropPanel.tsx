import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  PixelSize,
  RetouchActionId,
  RetouchGateReason,
} from "../../../lib/retouchActions";
import {
  CROP_RATIOS,
  buildCropEditOps,
  cropRectForRatio,
  rotatedSize,
  type CropRatio,
  type CropState,
  type ToneValues,
} from "../../../lib/retouchGeometry";
import { renderCropPreview } from "../../../lib/retouchCanvas";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { Slider } from "../../ui/Slider";
import { IconCrop, IconFlip, IconRotate } from "../../Icons";

/** 与滑杆预览同一节奏：拖滑块时每 250ms 最多算一次 */
const PREVIEW_DEBOUNCE_MS = 250;

/** 三个调色滑杆：label 即 i18n key */
const TONE_SLIDERS = [
  { key: "brightness", label: "亮度" },
  { key: "contrast", label: "对比度" },
  { key: "saturation", label: "饱和度" },
] as const;

interface Props {
  /** 只有 GIF 会命中 */
  reason: RetouchGateReason | null;
  busy: RetouchActionId | null;
  src: string;
  inputSize: PixelSize | null;
  onPreview: (dataUrl: string | null) => void;
  onConfirm: (state: CropState) => void;
}

/// 裁剪调色：旋转 / 翻转 / 比例裁剪 / 调色全部本地完成，离线可用、永不计费。
/// 只负责收集参数与实时预览；提交（落库、步骤条）交给 RetouchView。
export default function CropPanel({
  reason,
  busy,
  src,
  inputSize,
  onPreview,
  onConfirm,
}: Props) {
  const { t } = useTranslation();
  const [deg, setDeg] = useState<0 | 90 | 180 | 270>(0);
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [ratio, setRatio] = useState<CropRatio>("original");
  const [tone, setTone] = useState<ToneValues>({
    brightness: 0,
    contrast: 0,
    saturation: 0,
  });

  // 回调走 ref：父组件每次渲染都传新函数，放进依赖会让防抖永远等不到点
  const previewRef = useRef(onPreview);
  useEffect(() => {
    previewRef.current = onPreview;
  }, [onPreview]);

  const inputW = inputSize?.width ?? 0;
  const inputH = inputSize?.height ?? 0;
  const canvas = inputSize ? rotatedSize(inputSize, deg) : null;
  const rect = canvas ? cropRectForRatio(canvas, ratio) : null;
  const state: CropState | null =
    canvas && rect ? { deg, flipH, flipV, rect, canvas, tone } : null;
  const ops = state ? buildCropEditOps(state) : [];
  const { brightness, contrast, saturation } = tone;

  // 实时预览：依赖全是原始值，变化时先清定时器；量不到尺寸就不预览
  useEffect(() => {
    if (!(inputW > 0) || !(inputH > 0)) return;
    const box = rotatedSize({ width: inputW, height: inputH }, deg);
    const crop = cropRectForRatio(box, ratio);
    const timer = window.setTimeout(() => {
      renderCropPreview(src, {
        deg,
        flipH,
        flipV,
        rect: crop,
        brightness,
        contrast,
        saturation,
      })
        .then((url) => previewRef.current(url))
        .catch(() => undefined);
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [
    src,
    deg,
    flipH,
    flipV,
    ratio,
    inputW,
    inputH,
    brightness,
    contrast,
    saturation,
  ]);

  // 关闭面板意味着放弃这次预览：只在卸载时把舞台还给已提交结果，
  // 依赖数组留空，免得每次微调都先闪一下原图
  useEffect(() => () => previewRef.current(null), []);

  const rotate = (delta: 90 | 270) => {
    setDeg((current) => ((current + delta) % 360) as 0 | 90 | 180 | 270);
  };

  return (
    <section className="flex flex-col gap-3 p-3" aria-label={t("裁剪调色")}>
      <header className="flex flex-col gap-0.5">
        <h2 className="text-title3 text-primary">{t("裁剪调色")}</h2>
        <p className="text-footnote text-tertiary">
          {t("旋转、翻转与比例裁剪全在本机完成，不消耗接口额度")}
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-1.5">
        <IconButton
          label={t("左转 90°")}
          icon={<IconRotate size={16} className="-scale-x-100" />}
          disabled={!!busy}
          onClick={() => rotate(270)}
        />
        <IconButton
          label={t("右转 90°")}
          icon={<IconRotate size={16} />}
          disabled={!!busy}
          onClick={() => rotate(90)}
        />
        <IconButton
          label={t("水平翻转")}
          icon={<IconFlip size={16} />}
          variant={flipH ? "secondary" : "ghost"}
          aria-pressed={flipH}
          disabled={!!busy}
          onClick={() => setFlipH((value) => !value)}
        />
        <IconButton
          label={t("垂直翻转")}
          icon={<IconFlip size={16} className="rotate-90" />}
          variant={flipV ? "secondary" : "ghost"}
          aria-pressed={flipV}
          disabled={!!busy}
          onClick={() => setFlipV((value) => !value)}
        />
      </div>

      <SegmentedControl
        label={t("裁剪比例")}
        value={ratio}
        onValueChange={setRatio}
        size="sm"
        options={CROP_RATIOS.map((option) => ({
          value: option.id,
          label: t(option.label),
          disabled: !!reason || !!busy,
        }))}
      />

      <div className="flex items-center gap-2">
        <span className="text-tertiary">
          <IconCrop size={14} />
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={!!busy}
          onClick={() => setRatio("original")}
        >
          {t("全图")}
        </Button>
        <span className="ml-auto text-footnote tabular-nums text-tertiary">
          {rect
            ? t("输出 {{w}} × {{h}}", { w: rect.width, h: rect.height })
            : "—"}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        {TONE_SLIDERS.map((slider) => (
          <div key={slider.key} className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-footnote text-tertiary">
              {t(slider.label)}
            </span>
            <div className="min-w-0 flex-1">
              <Slider
                value={tone[slider.key]}
                min={-100}
                max={100}
                label={t(slider.label)}
                disabled={!!busy}
                onValueChange={(value) =>
                  setTone((prev) => ({ ...prev, [slider.key]: value }))
                }
              />
            </div>
            <span className="w-8 shrink-0 text-right text-footnote tabular-nums text-tertiary">
              {tone[slider.key]}
            </span>
          </div>
        ))}
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            disabled={!!busy}
            onClick={() =>
              setTone({ brightness: 0, contrast: 0, saturation: 0 })
            }
          >
            {t("重置色彩")}
          </Button>
        </div>
      </div>

      {reason && <p className="text-footnote text-tertiary">{t(reason)}</p>}

      <Button
        variant="primary"
        size="sm"
        block
        loading={busy === "crop"}
        disabled={!state || !!reason || !!busy || ops.length === 0}
        onClick={() => state && onConfirm(state)}
      >
        {t("应用裁剪")}
      </Button>
    </section>
  );
}
