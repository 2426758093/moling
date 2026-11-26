import { useTranslation } from "react-i18next";
import type { AdapterError } from "../../../lib/api";
import { adapterErrorTitle } from "../../../lib/api";
import { Button } from "../../ui/Button";
import { Textarea } from "../../ui/Field";
import { IconSparkle } from "../../Icons";

export default function OptimizeTab({
  draft,
  busy,
  error,
  result,
  onResultChange,
  onOptimize,
  onApply,
}: {
  draft: string;
  busy: boolean;
  error: AdapterError | null;
  result: string;
  onResultChange: (value: string) => void;
  onOptimize: () => void;
  onApply: (text: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2.5">
      <div className="rounded-btn bg-fill px-3 py-2 text-footnote leading-snug text-secondary">
        {draft.trim() || t("先在输入框写好提示词，再回来优化")}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption text-tertiary">
          {draft.trim()
            ? t("补全场景、构图、光线与质感，保留原意")
            : t("补全场景、构图、光线与质感，保留原意（需要先输入内容）")}
        </span>
        <Button
          size="sm"
          icon={<IconSparkle size={13} />}
          disabled={!draft.trim() || busy}
          onClick={onOptimize}
        >
          {busy ? t("优化中…") : t("优化")}
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
            aria-label={t("优化结果")}
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
