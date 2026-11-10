import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  RetouchActionId,
  RetouchGateReason,
} from "../../../lib/retouchActions";
import { Button } from "../../ui/Button";
import { SegmentedControl } from "../../ui/SegmentedControl";

interface Props {
  reason: RetouchGateReason | null;
  busy: RetouchActionId | null;
  onConfirm: (scale: 2 | 4, mode: "detail" | "faithful") => void;
}

/// 高清面板：倍数 + 模式就两张分段控件。模型沿用默认模型（计划里的「简单 UI」）。
export default function UpscalePanel({ reason, busy, onConfirm }: Props) {
  const { t } = useTranslation();
  const [scale, setScale] = useState<2 | 4>(2);
  const [mode, setMode] = useState<"detail" | "faithful">("detail");

  return (
    <section className="flex flex-col gap-3 p-3" aria-label={t("高清")}>
      <header className="flex flex-col gap-0.5">
        <h2 className="text-title3 text-primary">{t("高清")}</h2>
        <p className="text-footnote text-tertiary">
          {t("按倍数重新绘制，细节更清晰")}
        </p>
      </header>

      <div className="flex flex-col gap-1.5">
        <span className="text-footnote text-secondary">{t("放大倍数")}</span>
        <SegmentedControl
          label={t("放大倍数")}
          value={String(scale)}
          onValueChange={(value) => setScale(value === "4" ? 4 : 2)}
          size="sm"
          options={[
            { value: "2", label: "2x", disabled: !!reason || !!busy },
            { value: "4", label: "4x", disabled: !!reason || !!busy },
          ]}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-footnote text-secondary">{t("放大模式")}</span>
        <SegmentedControl
          label={t("放大模式")}
          value={mode}
          onValueChange={setMode}
          size="sm"
          options={[
            {
              value: "detail",
              label: t("细节增强"),
              disabled: !!reason || !!busy,
            },
            {
              value: "faithful",
              label: t("忠实还原"),
              disabled: !!reason || !!busy,
            },
          ]}
        />
      </div>

      {reason && <p className="text-footnote text-tertiary">{t(reason)}</p>}

      <Button
        variant="primary"
        size="sm"
        block
        loading={busy === "upscale"}
        disabled={!!reason || (!!busy && busy !== "upscale")}
        onClick={() => onConfirm(scale, mode)}
      >
        {t("开始放大")}
      </Button>
    </section>
  );
}
