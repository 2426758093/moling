import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  RetouchActionId,
  RetouchGateReason,
} from "../../../lib/retouchActions";
import { useStylePresets } from "../../../stores/stylePresetStore";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Field";

interface Props {
  reason: RetouchGateReason | null;
  busy: RetouchActionId | null;
  onConfirm: (prompt: string) => void;
}

/// 风格面板：预设 + 补充描述拼成一句风格提示词。模型沿用默认模型。
/// 预设的 label 可能是用户自定义的运行时文本，直接原样渲染，不走 t()。
export default function StylePanel({ reason, busy, onConfirm }: Props) {
  const { t } = useTranslation();
  const presets = useStylePresets();
  const [preset, setPreset] = useState("");
  const [extra, setExtra] = useState("");
  const prompt = [preset, extra.trim()].filter(Boolean).join(", ");

  return (
    <section className="flex flex-col gap-3 p-3" aria-label={t("风格")}>
      <header className="flex flex-col gap-0.5">
        <h2 className="text-title3 text-primary">{t("风格")}</h2>
        <p className="text-footnote text-tertiary">
          {t("按风格描述重新绘制，构图与主体保持不变")}
        </p>
      </header>

      <div className="flex flex-wrap gap-1.5">
        {presets.map((item) => {
          const selected = preset === item.prompt;
          return (
            <Button
              key={item.id}
              size="sm"
              variant={selected ? "secondary" : "ghost"}
              aria-pressed={selected}
              disabled={!!reason || !!busy}
              onClick={() => setPreset(selected ? "" : item.prompt)}
            >
              {item.label}
            </Button>
          );
        })}
      </div>

      <Input
        value={extra}
        onChange={(e) => setExtra(e.target.value)}
        label={t("补充描述（可选）")}
        placeholder={t("例如：暖色调、柔和光线…")}
        disabled={!!reason || !!busy}
      />

      {reason && <p className="text-footnote text-tertiary">{t(reason)}</p>}

      <Button
        variant="primary"
        size="sm"
        block
        loading={busy === "style"}
        disabled={!!reason || !!busy || prompt === ""}
        onClick={() => onConfirm(prompt)}
      >
        {t("应用风格")}
      </Button>
    </section>
  );
}
