import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, parseAdapterError, ProviderItem } from "../../lib/api";
import { useProviderStore } from "../../stores/providerStore";
import { KIND_OPTIONS } from "./ui";
import { Button } from "../ui/Button";

export default function ProviderCard({
  item,
  onEdit,
}: {
  item: ProviderItem;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const remove = useProviderStore((s) => s.remove);
  const defaultProviderId = useProviderStore((s) => s.defaultProviderId);
  const setDefaultProvider = useProviderStore((s) => s.setDefaultProvider);
  const [status, setStatus] = useState("");
  const p = item.provider;
  const isDefault = defaultProviderId === p.id;
  const kindLabel = KIND_OPTIONS.find((k) => k.id === p.kind)?.label;

  const doTest = async () => {
    setStatus(t("测试中…"));
    try {
      const r = await api.testConnection(p.id!);
      setStatus(
        r.ok
          ? t("连接正常 · {{ms}}ms · {{n}} 个模型", {
              ms: r.latencyMs ?? 0,
              n: r.modelCount ?? 0,
            })
          : t("连接失败：{{error}}", {
              error: r.error
                ? parseAdapterError(r.error).message
                : t("未知错误"),
            }),
      );
    } catch (e) {
      setStatus(t("连接失败：{{error}}", { error: String(e) }));
    }
  };

  return (
    <div className="border-b border-separator px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="truncate text-body font-medium text-primary">
              {p.name}
            </span>
            <span className="rounded-chip bg-fill px-1.5 py-0.5 text-caption text-secondary">
              {kindLabel ? t(kindLabel) : p.kind}
            </span>
            {isDefault && (
              <span className="rounded-chip bg-accent-soft px-1.5 py-0.5 text-caption text-accent-text">
                {t("默认")}
              </span>
            )}
          </div>
          <div className="truncate text-footnote text-tertiary">
            {p.baseUrl || t("（无地址）")} ·{" "}
            {item.keyCount > 1
              ? `${t("{{n}} 个 Key", { n: item.keyCount })}${
                  item.invalidKeyCount > 0
                    ? ` ${t("· {{n}} 失效", { n: item.invalidKeyCount })}`
                    : ""
                }`
              : `Key: ${item.apiKeyMasked}`}
            {p.defaultModel &&
              ` ${t("· 默认: {{model}}", { model: p.defaultModel })}`}
          </div>
          {item.keyError && (
            <div className="mt-1 inline-flex w-fit items-center gap-1 rounded-pill border border-danger/25 bg-danger/10 px-2 py-0.5 text-caption text-danger">
              {t("Key 失效：请重新填写")}
            </div>
          )}
          {status && (
            <div className="mt-0.5 text-footnote text-secondary">{status}</div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <label className="mr-1 flex cursor-pointer items-center gap-1.5 text-subhead text-secondary">
            <input
              type="radio"
              name="defaultProvider"
              checked={isDefault}
              onChange={() => setDefaultProvider(p.id!)}
              aria-label={t("把 {{name}} 设为默认服务商", { name: p.name })}
              className="size-4 cursor-pointer accent-accent-fill"
            />
            {t("默认")}
          </label>
          <Button
            size="sm"
            onClick={onEdit}
            aria-label={t("编辑服务商 {{name}}", { name: p.name })}
          >
            {t("编辑")}
          </Button>
          <Button
            size="sm"
            onClick={() => void doTest()}
            aria-label={t("测试服务商 {{name}}", { name: p.name })}
          >
            {t("测试")}
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => p.id && remove(p.id)}
            aria-label={t("删除服务商 {{name}}", { name: p.name })}
          >
            {t("删除")}
          </Button>
        </div>
      </div>
    </div>
  );
}
