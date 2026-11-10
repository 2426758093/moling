import { useTranslation } from "react-i18next";
import type { RetouchActionId } from "../../../lib/retouchActions";
import { Button } from "../../ui/Button";
import { Slider } from "../../ui/Slider";

interface Props {
  /** 专家模式才有滑杆 */
  expert: boolean;
  amount: number;
  onAmountChange: (value: number) => void;
  busy: RetouchActionId | null;
  onApply: () => void;
}

/// 美颜面板：磨皮力度滑杆（专家）+ 应用。全程本地运算。
export default function BeautyPanel({
  expert,
  amount,
  onAmountChange,
  busy,
  onApply,
}: Props) {
  const { t } = useTranslation();

  return (
    <section className="flex flex-col gap-3 p-3" aria-label={t("美颜")}>
      <header className="flex flex-col gap-0.5">
        <h2 className="text-title3 text-primary">{t("美颜")}</h2>
        <p className="text-footnote text-tertiary">
          {t("柔化肤色并轻微锐化，全程在本机完成")}
        </p>
      </header>

      {expert && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-footnote text-secondary">
            <span>{t("磨皮力度")}</span>
            <span className="tabular-nums text-tertiary">
              {Math.round(amount * 100)}%
            </span>
          </div>
          <Slider
            value={amount}
            min={0}
            max={1}
            step={0.05}
            label={t("磨皮力度")}
            onValueChange={onAmountChange}
          />
        </div>
      )}

      <Button
        variant="primary"
        size="sm"
        block
        loading={busy === "beauty"}
        disabled={!!busy && busy !== "beauty"}
        onClick={onApply}
      >
        {t("应用")}
      </Button>
    </section>
  );
}
