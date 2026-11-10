import { useTranslation } from "react-i18next";
import { IconEraser } from "../../Icons";
import {
  type RetouchActionId,
  type RetouchGateReason,
} from "../../../lib/retouchActions";
import { Button } from "../../ui/Button";
import { Slider } from "../../ui/Slider";

interface Props {
  /** 云动作被禁用时的原因（面板里再写一行，不靠颜色表达） */
  reason: RetouchGateReason | null;
  brushSize: number;
  onBrushSizeChange: (value: number) => void;
  eraser: boolean;
  onEraserChange: (value: boolean) => void;
  onClearMask: () => void;
  busy: RetouchActionId | null;
  onConfirm: () => void;
}

/// AI 消除面板：画笔 + 橡皮擦 + 清除 + 确认。蒙版画在舞台的当前步上。
export default function ErasePanel({
  reason,
  brushSize,
  onBrushSizeChange,
  eraser,
  onEraserChange,
  onClearMask,
  busy,
  onConfirm,
}: Props) {
  const { t } = useTranslation();
  const blocked = !!reason;

  return (
    <section className="flex flex-col gap-3 p-3" aria-label={t("AI 消除")}>
      <header className="flex flex-col gap-0.5">
        <h2 className="text-title3 text-primary">{t("AI 消除")}</h2>
        <p className="text-footnote text-tertiary">
          {t("涂抹要消除的对象，其余区域保持不变")}
        </p>
      </header>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between text-footnote text-secondary">
          <span>{t("画笔大小")}</span>
          <span className="tabular-nums text-tertiary">{brushSize}</span>
        </div>
        <Slider
          value={brushSize}
          min={8}
          max={160}
          step={2}
          label={t("画笔大小")}
          disabled={blocked || !!busy}
          onValueChange={onBrushSizeChange}
        />
      </div>

      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant={eraser ? "secondary" : "ghost"}
          icon={<IconEraser size={14} />}
          aria-pressed={eraser}
          disabled={blocked || !!busy}
          onClick={() => onEraserChange(!eraser)}
        >
          {t("橡皮擦")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={blocked || !!busy}
          onClick={onClearMask}
        >
          {t("清除蒙版")}
        </Button>
      </div>

      {reason && <p className="text-footnote text-tertiary">{t(reason)}</p>}

      <Button
        variant="primary"
        size="sm"
        block
        loading={busy === "erase"}
        disabled={blocked || (!!busy && busy !== "erase")}
        onClick={onConfirm}
      >
        {t("确认消除")}
      </Button>
    </section>
  );
}
