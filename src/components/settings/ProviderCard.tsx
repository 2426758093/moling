import { useState } from "react";
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
  const remove = useProviderStore((s) => s.remove);
  const defaultProviderId = useProviderStore((s) => s.defaultProviderId);
  const setDefaultProvider = useProviderStore((s) => s.setDefaultProvider);
  const [status, setStatus] = useState("");
  const p = item.provider;
  const isDefault = defaultProviderId === p.id;

  const doTest = async () => {
    setStatus("测试中…");
    try {
      const r = await api.testConnection(p.id!);
      setStatus(
        r.ok
          ? `连接正常 · ${r.latencyMs}ms · ${r.modelCount} 个模型`
          : `连接失败：${r.error ? parseAdapterError(r.error).message : "未知错误"}`,
      );
    } catch (e) {
      setStatus(`连接失败：${String(e)}`);
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
              {KIND_OPTIONS.find((k) => k.id === p.kind)?.label ?? p.kind}
            </span>
            {isDefault && (
              <span className="rounded-chip bg-accent-soft px-1.5 py-0.5 text-caption text-accent">
                默认
              </span>
            )}
          </div>
          <div className="truncate text-footnote text-tertiary">
            {p.baseUrl || "（无地址）"} ·{" "}
            {item.keyCount > 1
              ? `${item.keyCount} 个 Key${
                  item.invalidKeyCount > 0
                    ? ` · ${item.invalidKeyCount} 失效`
                    : ""
                }`
              : `Key: ${item.apiKeyMasked}`}
            {p.defaultModel && ` · 默认: ${p.defaultModel}`}
          </div>
          {item.keyError && (
            <div className="mt-1 inline-flex w-fit items-center gap-1 rounded-pill border border-danger/25 bg-danger/10 px-2 py-0.5 text-caption text-danger">
              Key 失效：请重新填写
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
              aria-label={`把 ${p.name} 设为默认服务商`}
              className="size-4 cursor-pointer accent-accent-fill"
            />
            默认
          </label>
          <Button
            size="sm"
            onClick={onEdit}
            aria-label={`编辑服务商 ${p.name}`}
          >
            编辑
          </Button>
          <Button
            size="sm"
            onClick={() => void doTest()}
            aria-label={`测试服务商 ${p.name}`}
          >
            测试
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => p.id && remove(p.id)}
            aria-label={`删除服务商 ${p.name}`}
          >
            删除
          </Button>
        </div>
      </div>
    </div>
  );
}
