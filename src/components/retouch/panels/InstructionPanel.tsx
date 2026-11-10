import { useTranslation } from "react-i18next";
import {
  type RetouchActionId,
  type RetouchGateReason,
} from "../../../lib/retouchActions";
import { Button } from "../../ui/Button";
import { Textarea } from "../../ui/Field";

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** 云动作被禁用时的原因 */
  reason: RetouchGateReason | null;
  busy: RetouchActionId | null;
  onSubmit: () => void;
}

/// 一句话改图：用户原话直接发送，不加护栏后缀。
export default function InstructionPanel({
  value,
  onChange,
  reason,
  busy,
  onSubmit,
}: Props) {
  const { t } = useTranslation();
  const blocked = !!reason;

  return (
    <section className="flex flex-col gap-3 p-3" aria-label={t("一句话改图")}>
      <header className="flex flex-col gap-0.5">
        <h2 className="text-title3 text-primary">{t("一句话改图")}</h2>
        <p className="text-footnote text-tertiary">
          {t("按你的原话改图，其余部分交给模型判断")}
        </p>
      </header>

      <Textarea
        compact
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={blocked || !!busy}
        placeholder={t("描述你想怎么改，例如：把背景换成海边日落")}
        aria-label={t("一句话改图")}
      />

      {reason && <p className="text-footnote text-tertiary">{t(reason)}</p>}

      <Button
        variant="primary"
        size="sm"
        block
        loading={busy === "instruction"}
        disabled={blocked || (!!busy && busy !== "instruction")}
        onClick={onSubmit}
      >
        {t("开始改图")}
      </Button>
    </section>
  );
}
