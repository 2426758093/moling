import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  RetouchActionId,
  RetouchGateReason,
} from "../../../lib/retouchActions";
import { IconTrash } from "../../Icons";
import { Badge, type BadgeTone } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/Dialog";
import { Input } from "../../ui/Field";
import { IconButton } from "../../ui/IconButton";
import MaskTools from "./MaskTools";

/** 一个待提交的区域：蒙版在「添加」时就固化，避免之后换步错位 */
export interface RegionDraft {
  id: string;
  prompt: string;
  /** 全尺寸 alpha-hole PNG（透明 = 要重绘），来自 MaskCanvas.toAlphaPng() */
  maskB64: string;
}

/** 每批上限与后端 MAX_REGION_BATCH 对齐：再多就该分批确认计费。
 *  与 RetouchView 的 addRegion 共用同一份上限，避免两处 4 各自漂移。 */
// eslint-disable-next-line react-refresh/only-export-components
export const MAX_REGION_BATCH = 4;

type RegionRunState = "running" | "ok" | "error";

interface Props {
  /** 云门禁原因（GIF / 离线 / 无服务商 / 模型不支持局部编辑） */
  reason: RetouchGateReason | null;
  busy: RetouchActionId | null;
  drafts: RegionDraft[];
  status: Record<string, RegionRunState>;
  progress: { done: number; total: number } | null;
  brushSize: number;
  onBrushSizeChange: (value: number) => void;
  eraser: boolean;
  onEraserChange: (value: boolean) => void;
  onClearMask: () => void;
  /** 返回 true 表示已收下这块蒙版，面板据此清空自己的提示词 */
  onAdd: (prompt: string) => boolean;
  onRemove: (id: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

/// 多区域面板：一次涂抹并存下 ≤4 块带提示词的蒙版，逐区计费、逐区进度。
/// 提交前的确认弹窗由这里负责，蒙版与空提示词的校验在 RetouchView（不进弹窗）。
export default function RegionPanel({
  reason,
  busy,
  drafts,
  status,
  progress,
  brushSize,
  onBrushSizeChange,
  eraser,
  onEraserChange,
  onClearMask,
  onAdd,
  onRemove,
  onSubmit,
  onCancel,
}: Props) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const blocked = !!reason;
  const running = busy === "region";
  const full = drafts.length >= MAX_REGION_BATCH;
  const done = progress?.done ?? 0;
  const total = progress?.total ?? drafts.length;

  /// 列表状态文案与色调：未提交 / 重绘中 / 已完成 / 失败
  const statusView = (
    state?: RegionRunState,
  ): { label: string; tone: BadgeTone } => {
    if (state === "running") return { label: t("重绘中…"), tone: "accent" };
    if (state === "ok") return { label: t("已完成"), tone: "success" };
    if (state === "error") return { label: t("失败"), tone: "danger" };
    return { label: t("待提交"), tone: "neutral" };
  };

  return (
    <section className="flex flex-col gap-3 p-3" aria-label={t("多区域")}>
      <header className="flex flex-col gap-0.5">
        <h2 className="text-title3 text-primary">{t("多区域")}</h2>
        <p className="text-footnote text-tertiary">
          {t("涂抹多个区域并分别填写要求，逐区重绘后本地合成")}
        </p>
      </header>

      <MaskTools
        brushSize={brushSize}
        onBrushSizeChange={onBrushSizeChange}
        eraser={eraser}
        onEraserChange={onEraserChange}
        onClear={onClearMask}
        disabled={blocked || !!busy}
        min={8}
        max={160}
      />

      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        label={t("区域提示词")}
        placeholder={t("该区域画什么")}
        disabled={blocked || !!busy}
      />

      <Button
        variant="secondary"
        size="sm"
        block
        disabled={blocked || !!busy || full || !draft.trim()}
        onClick={() => {
          if (onAdd(draft)) setDraft("");
        }}
      >
        {t("添加区域")}
      </Button>

      <div className="flex flex-col gap-2">
        {drafts.length === 0 ? (
          <p className="py-4 text-center text-footnote text-tertiary">
            {t("请先涂抹区域并填写提示词")}
          </p>
        ) : (
          drafts.map((item, index) => {
            const view = statusView(status[item.id]);
            return (
              <div
                key={item.id}
                className="flex items-start gap-2 rounded-card border border-line p-2"
              >
                <img
                  src={item.maskB64}
                  alt=""
                  className="h-10 w-10 shrink-0 rounded-btn bg-sunken object-cover"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-footnote text-secondary">
                      {t("区域 {{index}}", { index: index + 1 })}
                    </span>
                    <Badge tone={view.tone}>{view.label}</Badge>
                  </div>
                  <p className="mt-1 truncate text-caption text-tertiary">
                    {item.prompt}
                  </p>
                </div>
                <IconButton
                  label={t("删除")}
                  size="sm"
                  icon={<IconTrash size={13} />}
                  disabled={!!busy}
                  onClick={() => onRemove(item.id)}
                />
              </div>
            );
          })
        )}
      </div>

      {reason && <p className="text-footnote text-tertiary">{t(reason)}</p>}

      {running && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-footnote tabular-nums text-tertiary">
            {t("已重绘 {{done}} / {{total}} 个区域", { done, total })}
          </span>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("取消分区重绘")}
          </Button>
        </div>
      )}

      <Button
        variant="primary"
        size="sm"
        block
        loading={running}
        disabled={blocked || !!busy || drafts.length === 0}
        onClick={() => setConfirmOpen(true)}
      >
        {t("提交 {{count}} 个区域", { count: drafts.length })}
      </Button>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("提交 {{count}} 个区域", { count: drafts.length })}
        description={
          t("将调用 {{count}} 次服务商接口，按区域分别计费", {
            count: drafts.length,
          }) +
          " " +
          t("每个区域都会单独调用一次，费用 ×{{count}}", {
            count: drafts.length,
          })
        }
        confirmLabel={t("开始重绘")}
        onConfirm={() => {
          setConfirmOpen(false);
          onSubmit();
        }}
      />
    </section>
  );
}
