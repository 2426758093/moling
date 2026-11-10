import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import SafeImg from "../SafeImg";
import { IconChevron } from "../Icons";
import { SegmentedControl } from "../ui/SegmentedControl";
import {
  clampPercent,
  clipBefore,
  slidePosition,
  type CompareMode,
} from "../../lib/compareGeometry";

/** 方向键每次挪动的百分点：比指针拖动细一档，够微调又不琐碎 */
const KEY_STEP = 2;

interface Props {
  /** 首帧（原图） */
  before: string;
  /** 当前步（或专家预览） */
  after: string;
  alt: string;
  /** false = 还没有可对比的结果，只显示当前图 */
  compare: boolean;
  /** 覆盖在图片上的角标，例如「预览」 */
  badge?: string | null;
  /** 左图角标 / 无障碍文案：血统被截断时第一格并不是真正的「原图」 */
  beforeLabel?: string;
  /** 右图角标 / 无障碍文案：可能是当前步的动作名，也可能是「预览」 */
  afterLabel?: string;
}

/// 前后对比：滑动叠图（可拖分隔线 / ←→ 微调）或左右分屏。
/// 与 CompareDialog 同一套换算，但只吃 dataUrl，不依赖 HistoryItem。
export default function BeforeAfterCompare({
  before,
  after,
  alt,
  compare,
  badge,
  beforeLabel,
  afterLabel,
}: Props) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<CompareMode>("slide");
  const [pos, setPos] = useState(50);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const beforeText = beforeLabel ?? t("原图");
  const afterText = afterLabel ?? t("结果");

  const updateFromX = (clientX: number) => {
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos(slidePosition(clientX - rect.left, rect.width));
  };

  const badgeNode = badge ? (
    <span className="glass-media pointer-events-none absolute left-2 top-2 z-10 rounded-pill px-2 py-0.5 text-caption text-on-accent">
      {badge}
    </span>
  ) : null;

  if (!compare) {
    return (
      <div className="relative flex h-full w-full items-center justify-center overflow-hidden">
        <SafeImg
          src={after}
          alt={alt}
          className="h-full w-full object-contain"
          decoding="async"
        />
        {badgeNode}
        <span className="glass-media pointer-events-none absolute bottom-2 right-2 rounded-pill px-2 py-0.5 text-caption text-on-accent">
          {t("应用一个动作后即可对比")}
        </span>
      </div>
    );
  }

  // 分段控件浮在拖动层之上：指针/按键事件不能冒泡给底下的分隔线
  const modeSwitch = (
    <div
      className="absolute right-2 top-2 z-10"
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <SegmentedControl
        value={mode}
        onValueChange={setMode}
        label={t("对比模式")}
        size="sm"
        options={[
          { value: "slide", label: t("滑动对比") },
          { value: "side", label: t("并排对比") },
        ]}
      />
    </div>
  );

  if (mode === "side") {
    return (
      <div className="relative grid h-full w-full grid-cols-2 gap-1 overflow-hidden">
        {[before, after].map((url, i) => (
          <div
            key={i}
            className="relative flex min-w-0 items-center justify-center overflow-hidden bg-sunken"
          >
            <SafeImg
              src={url}
              alt={i === 0 ? beforeText : afterText}
              className="h-full w-full object-contain"
              decoding="async"
            />
            <span className="glass-media pointer-events-none absolute bottom-2 left-2 rounded-pill px-2 py-0.5 text-caption text-on-accent">
              {i === 0 ? beforeText : afterText}
            </span>
          </div>
        ))}
        {modeSwitch}
        {badgeNode}
      </div>
    );
  }

  return (
    <div
      ref={stageRef}
      role="slider"
      aria-label={t("对比分隔位置")}
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pos}
      aria-valuetext={t("{{n}}% {{label}}", { n: pos, label: beforeText })}
      tabIndex={0}
      className="relative h-full w-full touch-none select-none overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-accent"
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        updateFromX(e.clientX);
      }}
      onPointerMove={(e) => {
        if (dragging.current) updateFromX(e.clientX);
      }}
      onPointerUp={() => {
        dragging.current = false;
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          setPos((p) => clampPercent(p - KEY_STEP));
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          setPos((p) => clampPercent(p + KEY_STEP));
        }
      }}
    >
      <SafeImg
        src={after}
        alt={alt}
        className="pointer-events-none absolute inset-0 h-full w-full object-contain"
        decoding="async"
      />
      <div
        className="pointer-events-none absolute inset-0"
        style={{ clipPath: clipBefore(pos) }}
      >
        <SafeImg
          src={before}
          alt={beforeText}
          className="h-full w-full object-contain"
          decoding="async"
        />
      </div>
      {/* 标签只是视觉提示：留在 slider 内会让读屏把「原图/结果」当成控件名的一部分 */}
      <span
        aria-hidden
        className="glass-media pointer-events-none absolute bottom-2 left-2 rounded-pill px-2 py-0.5 text-caption text-on-accent"
      >
        {beforeText}
      </span>
      <span
        aria-hidden
        className="glass-media pointer-events-none absolute bottom-2 right-2 rounded-pill px-2 py-0.5 text-caption text-on-accent"
      >
        {afterText}
      </span>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 w-0.5 bg-accent-fill"
        style={{ left: `calc(${pos}% - 1px)` }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-pill border border-line bg-elevated text-secondary shadow-card"
        style={{ left: `${pos}%` }}
      >
        <IconChevron size={10} direction="left" />
        <IconChevron size={10} direction="right" />
      </div>
      {modeSwitch}
      {badgeNode}
    </div>
  );
}
