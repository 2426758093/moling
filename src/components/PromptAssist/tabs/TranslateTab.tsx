import { useTranslation } from "react-i18next";
import type { AdapterError } from "../../../lib/api";
import { adapterErrorTitle } from "../../../lib/api";
import { Button } from "../../ui/Button";
import { Textarea } from "../../ui/Field";
import { IconSparkle } from "../../Icons";
import { isCJK } from "../types";

export default function TranslateTab({
  draft,
  busy,
  error,
  result,
  onResultChange,
  onTranslate,
  onApply,
}: {
  draft: string;
  busy: boolean;
  error: AdapterError | null;
  result: string;
  onResultChange: (value: string) => void;
  onTranslate: () => void;
  onApply: (text: string) => void;
}) {
  const { t } = useTranslation();
  const directionLabel = isCJK(draft) ? t("中 → 英") : t("英 → 中");
  return (
    <div className="space-y-2.5">
      <div className="rounded-btn bg-fill px-3 py-2 text-footnote leading-snug text-secondary">
        {draft.trim() || t("先在输入框写好提示词，再回来翻译")}
      </div>
      <div className="flex items-center justify-between">
        <span className="text-caption text-tertiary">
          {draft.trim()
            ? t("方向：{{dir}}", { dir: directionLabel })
            : t("方向：{{dir}}（需要先输入内容）", {
                dir: directionLabel,
              })}
        </span>
        <Button
          size="sm"
          icon={<IconSparkle size={13} />}
          disabled={!draft.trim() || busy}
          onClick={onTranslate}
        >
          {busy ? t("翻译中…") : t("翻译")}
        </Button>
      </div>
      {error && (
        <div className="text-footnote leading-snug text-danger">
          {adapterErrorTitle(error)}
          <div className="mt-0.5 break-all text-caption text-tertiary">
            {error.message}
          </div>
        </div>
      )}
      {result && !busy && (
        <>
          <Textarea
            value={result}
            onChange={(e) => onResultChange(e.target.value)}
            rows={3}
            compact
            aria-label={t("翻译结果")}
          />
          <Button
            size="sm"
            variant="primary"
            block
            onClick={() => onApply(result)}
          >
            {t("填入输入框")}
          </Button>
        </>
      )}
    </div>
  );
}
