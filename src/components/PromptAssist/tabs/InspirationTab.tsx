import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { IconSparkle } from "../../Icons";

export default function InspirationTab({
  inspiration,
  onRoll,
  onApply,
}: {
  inspiration: string;
  onRoll: () => void;
  onApply: (text: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-3 py-2">
      <div className="w-full rounded-btn bg-fill px-4 py-3 text-center text-subhead leading-relaxed text-primary">
        {inspiration}
      </div>
      <div className="flex gap-2">
        <Button size="sm" icon={<IconSparkle size={13} />} onClick={onRoll}>
          {t("再掷一次")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={() => onApply(inspiration)}
        >
          {t("使用这条")}
        </Button>
      </div>
    </div>
  );
}
