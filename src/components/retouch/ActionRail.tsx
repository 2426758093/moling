import type { FormEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IconBrush, IconChat, IconEraser, IconSparkle } from "../Icons";
import { Button } from "../ui/Button";
import { Input } from "../ui/Field";
import { cn } from "../ui/cn";
import {
  RETOUCH_ACTIONS,
  type RetouchActionId,
  type RetouchActionLabel,
  type RetouchGateReason,
} from "../../lib/retouchActions";

const ICONS: Record<RetouchActionId, ReactNode> = {
  auto: <IconSparkle size={14} />,
  beauty: <IconBrush size={14} />,
  erase: <IconEraser size={14} />,
  instruction: <IconChat size={14} />,
};

interface Props {
  /** 当前展开的面板 */
  panel: RetouchActionId | null;
  busy: RetouchActionId | null;
  /** 每个动作的禁用原因；null = 可点 */
  reasons: Record<RetouchActionId, RetouchGateReason | null>;
  instruction: string;
  onInstructionChange: (value: string) => void;
  onInstructionFocus: () => void;
  onInstructionSubmit: () => void;
  onAction: (id: RetouchActionId) => void;
}

interface ReasonGroup {
  reason: RetouchGateReason;
  labels: RetouchActionLabel[];
}

/// 禁用原因按相同文案合并：两个云动作同时离线时只出现一行。
function groupedReasons(
  reasons: Record<RetouchActionId, RetouchGateReason | null>,
): ReasonGroup[] {
  const groups = new Map<RetouchGateReason, RetouchActionLabel[]>();
  for (const action of RETOUCH_ACTIONS) {
    const reason = reasons[action.id];
    if (!reason) continue;
    const labels = groups.get(reason) ?? [];
    labels.push(action.label);
    groups.set(reason, labels);
  }
  return Array.from(groups, ([reason, labels]) => ({ reason, labels }));
}

function BusyDots() {
  return (
    <span aria-hidden className="inline-flex items-center gap-0.5">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="thinking-dot h-1 w-1 rounded-pill bg-current"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

/// 底部动作栏：4 个 Chip + 一句话输入框。简单模式也只有这两样。
export default function ActionRail({
  panel,
  busy,
  reasons,
  instruction,
  onInstructionChange,
  onInstructionFocus,
  onInstructionSubmit,
  onAction,
}: Props) {
  const { t } = useTranslation();
  const groups = groupedReasons(reasons);
  const instructionReason = reasons.instruction;
  // 一行放不下时靠 title 兜底：完整原因不能被 truncate 吃掉
  const reasonText = groups
    .map(
      (group) =>
        `${group.labels.map((label) => t(label)).join("、")}：${t(group.reason)}`,
    )
    .join(" · ");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onInstructionSubmit();
  };

  return (
    <div className="shrink-0 border-t border-separator px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {RETOUCH_ACTIONS.map((action) => {
          const reason = reasons[action.id];
          const active = panel === action.id;
          const loading = busy === action.id;
          return (
            <button
              key={action.id}
              type="button"
              disabled={!!reason || (!!busy && !loading)}
              aria-pressed={active}
              aria-busy={loading || undefined}
              title={reason ? t(reason) : undefined}
              onClick={() => onAction(action.id)}
              className={cn(
                "pressable inline-flex h-7 items-center gap-1.5 rounded-pill border px-3 text-subhead select-none",
                active
                  ? "border-accent/40 bg-accent-soft text-accent-text"
                  : "border-line bg-elevated text-secondary hover:text-primary",
                reason && "cursor-not-allowed opacity-40",
              )}
            >
              {loading ? <BusyDots /> : ICONS[action.id]}
              {t(action.label)}
            </button>
          );
        })}
      </div>

      <form className="mt-2 flex items-center gap-1.5" onSubmit={submit}>
        <div className="min-w-0 flex-1">
          <Input
            compact
            value={instruction}
            onChange={(e) => onInstructionChange(e.target.value)}
            onFocus={onInstructionFocus}
            disabled={!!instructionReason || !!busy}
            placeholder={t("描述你想怎么改，例如：把背景换成海边日落")}
            aria-label={t("一句话改图")}
          />
        </div>
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          loading={busy === "instruction"}
          disabled={!!instructionReason || !!busy || !instruction.trim()}
        >
          {t("改图")}
        </Button>
      </form>

      {groups.length > 0 && (
        <p
          title={reasonText}
          className="mt-1.5 truncate text-caption text-tertiary"
        >
          {reasonText}
        </p>
      )}
    </div>
  );
}
