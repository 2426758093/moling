import { useTranslation } from "react-i18next";
import {
  type RetouchActionId,
  type RetouchGateReason,
} from "../../../lib/retouchActions";
import { Button } from "../../ui/Button";
import MaskTools from "./MaskTools";

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

      <MaskTools
        brushSize={brushSize}
        onBrushSizeChange={onBrushSizeChange}
        eraser={eraser}
        onEraserChange={onEraserChange}
        onClear={onClearMask}
        disabled={blocked || !!busy}
      />

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
