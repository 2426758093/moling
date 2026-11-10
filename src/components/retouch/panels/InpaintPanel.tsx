import { useTranslation } from "react-i18next";
import type {
  RetouchActionId,
  RetouchGateReason,
} from "../../../lib/retouchActions";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Field";
import MaskTools from "./MaskTools";

interface Props {
  /** 云门禁原因（GIF / 离线 / 无服务商 / 模型不支持局部编辑） */
  reason: RetouchGateReason | null;
  busy: RetouchActionId | null;
  /** 受控：提交成功后由 RetouchView 清空 */
  prompt: string;
  onPromptChange: (value: string) => void;
  brushSize: number;
  onBrushSizeChange: (value: number) => void;
  eraser: boolean;
  onEraserChange: (value: boolean) => void;
  onClearMask: () => void;
  onConfirm: (prompt: string) => void;
}

/// 局部重绘面板：涂抹 + 重绘要求。蒙版画在舞台的当前步上，
/// 空蒙版 / 空提示词的拦截在 RetouchView（提交前校验，绝不进计费确认）。
export default function InpaintPanel({
  reason,
  busy,
  prompt,
  onPromptChange,
  brushSize,
  onBrushSizeChange,
  eraser,
  onEraserChange,
  onClearMask,
  onConfirm,
}: Props) {
  const { t } = useTranslation();
  const blocked = !!reason;

  return (
    <section className="flex flex-col gap-3 p-3" aria-label={t("局部重绘")}>
      <header className="flex flex-col gap-0.5">
        <h2 className="text-title3 text-primary">{t("局部重绘")}</h2>
        <p className="text-footnote text-tertiary">
          {t("涂抹要重绘的区域，填写提示词，其余区域保持不变")}
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
        value={prompt}
        onChange={(e) => onPromptChange(e.target.value)}
        label={t("重绘要求")}
        placeholder={t("描述该区域要变成什么")}
        disabled={blocked || !!busy}
      />

      {reason && <p className="text-footnote text-tertiary">{t(reason)}</p>}

      <Button
        variant="primary"
        size="sm"
        block
        loading={busy === "inpaint"}
        disabled={blocked || !!busy || !prompt.trim()}
        onClick={() => onConfirm(prompt)}
      >
        {t("确认重绘")}
      </Button>
    </section>
  );
}
