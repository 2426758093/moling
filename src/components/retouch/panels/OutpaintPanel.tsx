import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  PixelSize,
  RetouchActionId,
  RetouchGateReason,
} from "../../../lib/retouchActions";
import {
  OUTPAINT_RATIOS,
  outpaintTargetSize,
  type OutpaintRatio,
} from "../../../lib/retouchGeometry";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Field";
import { SegmentedControl } from "../../ui/SegmentedControl";

interface Props {
  reason: RetouchGateReason | null;
  busy: RetouchActionId | null;
  /** 当前步实测尺寸；null = 还没量到，尺寸文案显示 — */
  inputSize: PixelSize | null;
  onConfirm: (ratio: OutpaintRatio, prompt: string) => void;
}

/// 扩图面板：只给比例预设 + 可选描述。自由拖边留在旧 OutpaintView（v2.1.2 退役）。
export default function OutpaintPanel({
  reason,
  busy,
  inputSize,
  onConfirm,
}: Props) {
  const { t } = useTranslation();
  const [ratio, setRatio] = useState<OutpaintRatio>("original");
  const [prompt, setPrompt] = useState("");

  const target = inputSize ? outpaintTargetSize(inputSize, ratio) : null;
  // 原始比例 / 量不到尺寸 / 目标尺寸没变：都没有可扩的空间
  const unchanged =
    ratio === "original" ||
    !inputSize ||
    !target ||
    (target.width === inputSize.width && target.height === inputSize.height);

  return (
    <section className="flex flex-col gap-3 p-3" aria-label={t("扩图")}>
      <header className="flex flex-col gap-0.5">
        <h2 className="text-title3 text-primary">{t("扩图")}</h2>
        <p className="text-footnote text-tertiary">
          {t("按比例向外扩展画面，AI 补全内容")}
        </p>
      </header>

      <SegmentedControl
        label={t("目标比例")}
        value={ratio}
        onValueChange={setRatio}
        size="sm"
        options={OUTPAINT_RATIOS.map((option) => ({
          value: option.id,
          label: t(option.label),
          disabled: !!reason || !!busy,
        }))}
      />

      <p className="text-footnote tabular-nums text-tertiary">
        {!unchanged && target
          ? t("目标尺寸 {{w}} × {{h}}", { w: target.width, h: target.height })
          : t("保持原尺寸")}
      </p>

      <Input
        compact
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={t("补充描述（可选）：如“延伸出海面与晚霞”")}
        aria-label={t("补全描述")}
        disabled={!!reason || !!busy}
      />

      {reason && <p className="text-footnote text-tertiary">{t(reason)}</p>}

      <Button
        variant="primary"
        size="sm"
        block
        loading={busy === "outpaint"}
        disabled={!!reason || !!busy || unchanged}
        onClick={() => onConfirm(ratio, prompt.trim())}
      >
        {t("生成扩图")}
      </Button>
    </section>
  );
}
