import { useTranslation } from "react-i18next";
import { IconEraser } from "../../Icons";
import { Button } from "../../ui/Button";
import { Slider } from "../../ui/Slider";

interface Props {
  brushSize: number;
  onBrushSizeChange: (value: number) => void;
  eraser: boolean;
  onEraserChange: (value: boolean) => void;
  onClear: () => void;
  /** 门禁原因或提交中：所有控件禁用 */
  disabled?: boolean;
  /** 可选：多区域/换背景的「全选」 */
  onFillAll?: () => void;
  /** 可选：智能点选 / 自动选中背景 */
  onAutoSelect?: () => void;
  autoBusy?: boolean;
  /** 中文即 i18n key；默认「自动选中」 */
  autoLabel?: "自动选中" | "自动选中背景";
  /** 中文即 i18n key；默认「全选」 */
  fillLabel?: "全选" | "全选背景";
  min?: number;
  max?: number;
}

/// 共用蒙版工具：画笔大小 + 橡皮擦 + 全选 / 自动选中 + 清除。
/// 消除 / 换背景 / 局部重绘 / 多区域都挂它，外观与文案保持一致。
export default function MaskTools({
  brushSize,
  onBrushSizeChange,
  eraser,
  onEraserChange,
  onClear,
  disabled = false,
  onFillAll,
  onAutoSelect,
  autoBusy = false,
  autoLabel,
  fillLabel,
  min = 8,
  max = 160,
}: Props) {
  const { t } = useTranslation();
  const fillText = t(fillLabel ?? "全选");
  const autoText = t(autoLabel ?? "自动选中");

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-footnote text-secondary">
        <span>{t("画笔大小")}</span>
        <span className="tabular-nums text-tertiary">{brushSize}</span>
      </div>
      <Slider
        value={brushSize}
        min={min}
        max={max}
        step={2}
        label={t("画笔大小")}
        disabled={disabled}
        onValueChange={onBrushSizeChange}
      />

      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant={eraser ? "secondary" : "ghost"}
          icon={<IconEraser size={14} />}
          aria-pressed={eraser}
          aria-label={t("橡皮擦")}
          disabled={disabled}
          onClick={() => onEraserChange(!eraser)}
        >
          {t("橡皮擦")}
        </Button>
        {onFillAll && (
          <Button
            size="sm"
            variant="ghost"
            aria-label={fillText}
            disabled={disabled}
            onClick={() => onFillAll()}
          >
            {fillText}
          </Button>
        )}
        {onAutoSelect && (
          <Button
            size="sm"
            variant="ghost"
            loading={autoBusy}
            aria-label={autoText}
            disabled={disabled}
            onClick={() => onAutoSelect()}
          >
            {autoText}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          aria-label={t("清除蒙版")}
          disabled={disabled}
          onClick={onClear}
        >
          {t("清除蒙版")}
        </Button>
      </div>
    </div>
  );
}
