import { useTranslation } from "react-i18next";
import { ProviderKeyView } from "../../../lib/api";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Field";

export function KeyManager({
  keys,
  newKey,
  onNewKeyChange,
  keyError,
  onAdd,
  onDelete,
  onReset,
}: {
  keys: ProviderKeyView[];
  newKey: string;
  onNewKeyChange: (v: string) => void;
  keyError: string;
  onAdd: () => void;
  onDelete: (index: number) => void;
  onReset: (index: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-card border border-line p-3">
      <div className="mb-2 flex items-center justify-between text-footnote">
        <span className="text-secondary">
          {t("Key 池（鉴权失败时自动切换到下一个）")}
        </span>
        <span className="text-tertiary">
          {t("{{n}} 个", { n: keys.length })}
          {keys.some((k) => k.invalid) &&
            ` ${t("· {{n}} 失效", {
              n: keys.filter((k) => k.invalid).length,
            })}`}
        </span>
      </div>
      <div className="space-y-1.5">
        {keys.map((k) => (
          <div key={k.index} className="flex items-center gap-2 text-footnote">
            <span className="font-mono text-secondary">
              {k.index + 1}. {k.masked}
            </span>
            {k.invalid ? (
              <span className="rounded-pill border border-danger/25 bg-danger/10 px-1.5 py-0.5 text-caption text-danger">
                {t("已失效")}
              </span>
            ) : (
              <span className="text-caption text-tertiary">{t("可用")}</span>
            )}
            <div className="ml-auto flex gap-1">
              {k.invalid && (
                <Button
                  size="sm"
                  onClick={() => void onReset(k.index)}
                  aria-label={t("恢复 Key {{n}}", { n: k.index + 1 })}
                >
                  {t("恢复")}
                </Button>
              )}
              <Button
                size="sm"
                variant="danger"
                onClick={() => void onDelete(k.index)}
                aria-label={t("删除 Key {{n}}", { n: k.index + 1 })}
              >
                {t("删除")}
              </Button>
            </div>
          </div>
        ))}
        {keys.length === 0 && (
          <div className="text-footnote text-tertiary">
            {t("还没有 Key，可在上方 API Key 里填写主 Key 后保存。")}
          </div>
        )}
      </div>
      <div className="mt-2 flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Input
            type="password"
            value={newKey}
            onChange={(e) => onNewKeyChange(e.target.value)}
            placeholder={t("添加备用 Key")}
            aria-label={t("添加备用 Key")}
          />
        </div>
        <Button
          size="md"
          disabled={!newKey.trim()}
          onClick={() => void onAdd()}
        >
          {t("添加")}
        </Button>
      </div>
      {keyError && (
        <div className="mt-1 text-footnote text-danger">{keyError}</div>
      )}
    </div>
  );
}
