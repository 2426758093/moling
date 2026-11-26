import { useRef } from "react";
import { useTranslation } from "react-i18next";
import type { AdapterError } from "../../../lib/api";
import { adapterErrorTitle } from "../../../lib/api";
import { Button } from "../../ui/Button";
import { Textarea } from "../../ui/Field";
import SafeImg from "../../SafeImg";
import { IconImage } from "../../Icons";

export default function ReverseTab({
  img,
  busy,
  error,
  result,
  onResultChange,
  onFile,
  onApply,
}: {
  img: string | null;
  busy: boolean;
  error: AdapterError | null;
  result: string;
  onResultChange: (value: string) => void;
  onFile: (file: File) => void;
  onApply: (text: string) => void;
}) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-2.5">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
      {!img ? (
        <button
          onClick={() => fileRef.current?.click()}
          className="pressable flex w-full flex-col items-center gap-2 rounded-btn border border-dashed border-line py-6 text-tertiary transition-colors hover:bg-hover hover:text-secondary"
        >
          <IconImage size={22} strokeWidth={1.4} />
          <span className="text-footnote">{t("上传图片，反推绘制提示词")}</span>
        </button>
      ) : (
        <div className="flex gap-2.5">
          <SafeImg
            src={img}
            alt={t("反推对象")}
            className="h-16 w-16 shrink-0 rounded-xl border border-line object-cover"
          />
          <div className="min-w-0 flex-1">
            {busy ? (
              <div className="flex h-16 items-center gap-2 text-footnote text-tertiary">
                <span className="flex gap-1">
                  <span className="thinking-dot h-1.5 w-1.5 rounded-pill bg-accent" />
                  <span className="thinking-dot h-1.5 w-1.5 rounded-pill bg-accent" />
                  <span className="thinking-dot h-1.5 w-1.5 rounded-pill bg-accent" />
                </span>
                {t("正在反推…")}
              </div>
            ) : error ? (
              <div className="text-footnote leading-snug text-danger">
                {adapterErrorTitle(error)}
                <div className="mt-0.5 break-all text-caption text-tertiary">
                  {error.message}
                </div>
              </div>
            ) : (
              <Textarea
                value={result}
                onChange={(e) => onResultChange(e.target.value)}
                rows={3}
                compact
                aria-label={t("反推结果")}
              />
            )}
          </div>
        </div>
      )}
      {result && !busy && (
        <div className="flex justify-end gap-2">
          <Button size="sm" onClick={() => fileRef.current?.click()}>
            {t("换一张")}
          </Button>
          <Button size="sm" variant="primary" onClick={() => onApply(result)}>
            {t("填入输入框")}
          </Button>
        </div>
      )}
    </div>
  );
}
