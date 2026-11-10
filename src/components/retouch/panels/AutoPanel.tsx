import { useTranslation } from "react-i18next";
import type { RetouchAnalysis } from "../../../lib/api";
import {
  analysisSuggestionText,
  type RetouchActionId,
} from "../../../lib/retouchActions";
import { Button } from "../../ui/Button";
import { Slider } from "../../ui/Slider";

interface Props {
  /** 专家模式才有滑杆；简单模式不出现任何参数 */
  expert: boolean;
  strength: number;
  onStrengthChange: (value: number) => void;
  analysis: RetouchAnalysis | null;
  busy: RetouchActionId | null;
  onApply: () => void;
}

/// 一键优化面板：强度滑杆（专家）+ 分析建议 + 应用。
export default function AutoPanel({
  expert,
  strength,
  onStrengthChange,
  analysis,
  busy,
  onApply,
}: Props) {
  const { t } = useTranslation();
  const suggestions = analysis?.suggestions ?? [];

  return (
    <section className="flex flex-col gap-3 p-3" aria-label={t("一键优化")}>
      <header className="flex flex-col gap-0.5">
        <h2 className="text-title3 text-primary">{t("一键优化")}</h2>
        <p className="text-footnote text-tertiary">
          {t("自动校正曝光、白平衡与对比，只改色彩不动构图")}
        </p>
      </header>

      {expert && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-footnote text-secondary">
            <span>{t("强度")}</span>
            <span className="tabular-nums text-tertiary">
              {Math.round(strength * 100)}%
            </span>
          </div>
          <Slider
            value={strength}
            min={0}
            max={1}
            step={0.05}
            label={t("强度")}
            onValueChange={onStrengthChange}
          />
        </div>
      )}

      {suggestions.length > 0 && analysis && (
        <div className="flex flex-col gap-1.5">
          <span className="text-caption text-tertiary">{t("分析建议")}</span>
          <div className="flex flex-wrap gap-1">
            {suggestions.map((suggestion) => (
              <span
                key={suggestion}
                className="rounded-pill bg-sunken px-2 py-0.5 text-caption text-secondary"
              >
                {t(analysisSuggestionText(suggestion, analysis))}
              </span>
            ))}
          </div>
        </div>
      )}

      <Button
        variant="primary"
        size="sm"
        block
        loading={busy === "auto"}
        disabled={!!busy && busy !== "auto"}
        onClick={onApply}
      >
        {t("应用")}
      </Button>
    </section>
  );
}
