import type { FormEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  IconBrush,
  IconChat,
  IconCloud,
  IconCrop,
  IconEraser,
  IconExpand,
  IconGrid,
  IconImage,
  IconPalette,
  IconSparkle,
} from "../Icons";
import { Button } from "../ui/Button";
import { Input } from "../ui/Field";
import { cn } from "../ui/cn";
import {
  RETOUCH_ACTIONS,
  type RetouchActionDef,
  type RetouchActionId,
  type RetouchActionLabel,
  type RetouchActionTier,
  type RetouchGateReason,
} from "../../lib/retouchActions";

const ICONS: Record<RetouchActionId, ReactNode> = {
  auto: <IconSparkle size={14} />,
  beauty: <IconBrush size={14} />,
  erase: <IconEraser size={14} />,
  instruction: <IconChat size={14} />,
  background: <IconImage size={14} />,
  upscale: <IconSparkle size={14} />,
  outpaint: <IconExpand size={14} />,
  crop: <IconCrop size={14} />,
  style: <IconPalette size={14} />,
  inpaint: <IconBrush size={14} />,
  region: <IconGrid size={14} />,
};

interface Props {
  /** 简单模式只显示 simple tier 的 Chip */
  mode: RetouchActionTier;
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
/// 只统计当前模式可见的动作，否则简单模式会报「扩图：当前离线」。
function groupedReasons(
  reasons: Record<RetouchActionId, RetouchGateReason | null>,
  actions: RetouchActionDef[],
): ReasonGroup[] {
  const groups = new Map<RetouchGateReason, RetouchActionLabel[]>();
  for (const action of actions) {
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

/// 底部动作栏：按模式过滤的 Chip + 一句话输入框。简单模式恰好 6 个。
export default function ActionRail({
  mode,
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
  const visible = RETOUCH_ACTIONS.filter(
    (action) => mode === "expert" || action.tier === "simple",
  );
  const groups = groupedReasons(reasons, visible);
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
        {visible.map((action) => {
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
              // title 只在没有禁用原因时让位给计费提示：原因更要紧
              title={
                reason ? t(reason) : action.cloud ? t("云端计费") : undefined
              }
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
              {/* 云图标只做视觉信号：不加 sr-only / aria-label，可访问名必须保持动作名 */}
              {action.cloud && (
                <IconCloud size={11} className="text-tertiary" />
              )}
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
