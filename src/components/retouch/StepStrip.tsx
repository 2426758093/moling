import { useTranslation } from "react-i18next";
import SafeImg from "../SafeImg";
import { Button } from "../ui/Button";
import { Tooltip } from "../ui/Tooltip";
import { cn } from "../ui/cn";
import type {
  RetouchActionId,
  RetouchStepLabel,
} from "../../lib/retouchActions";

/** 修图台的一步：首帧是原图，之后每一步都是一个已提交的动作 */
export interface RetouchStep {
  /** `s0`、`s1`… 只用于 React key 与调试 */
  key: string;
  /** 全尺寸图；还原出来的非当前步可能为空（按需懒加载） */
  dataUrl: string;
  /** 缩略图：步骤条只在有它时才不必为旧步取全图 */
  thumbUrl?: string;
  historyId: number | null;
  width?: number;
  height?: number;
  label: RetouchStepLabel;
  op?: string;
}

interface Props {
  steps: RetouchStep[];
  current: number;
  busy: RetouchActionId | null;
  onSelect: (index: number) => void;
  onContinue: () => void;
}

/// 底部步骤条：横向缩略图 + 「从这一步继续」。
/// 点缩略图只是回看，不删后续步骤；要继续必须显式点按钮。
export default function StepStrip({
  steps,
  current,
  busy,
  onSelect,
  onContinue,
}: Props) {
  const { t } = useTranslation();
  const canContinue = current < steps.length - 1;

  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-separator px-3 py-2">
      <ol
        aria-label={t("步骤")}
        className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto"
      >
        {steps.map((step, index) => {
          const active = index === current;
          const meta =
            step.historyId != null ? `#${step.historyId}` : t("未入库");
          return (
            <li key={step.key} className="shrink-0">
              <Tooltip label={`${t(step.label)} · ${meta}`}>
                <button
                  type="button"
                  aria-label={`${index + 1}. ${t(step.label)}`}
                  aria-current={active ? "step" : undefined}
                  // 提交 / 预览进行中禁止换步：新步骤会接到别的底图上
                  disabled={!!busy}
                  onClick={() => {
                    if (busy) return;
                    onSelect(index);
                  }}
                  className={cn(
                    "pressable relative h-14 w-14 overflow-hidden rounded-btn border bg-sunken",
                    active
                      ? "border-accent ring-1 ring-accent/30"
                      : "border-line opacity-70 hover:opacity-100",
                    busy && "cursor-not-allowed opacity-50",
                  )}
                >
                  <SafeImg
                    src={step.thumbUrl ?? step.dataUrl}
                    alt={t(step.label)}
                    className="h-full w-full object-cover"
                    decoding="async"
                  />
                  <span className="absolute inset-x-0 bottom-0 bg-scrim/45 py-0.5 text-center text-caption text-on-accent tabular-nums">
                    {index + 1}
                  </span>
                </button>
              </Tooltip>
            </li>
          );
        })}
      </ol>
      {canContinue && (
        <Button size="sm" disabled={!!busy} onClick={onContinue}>
          {t("从这一步继续")}
        </Button>
      )}
    </div>
  );
}
