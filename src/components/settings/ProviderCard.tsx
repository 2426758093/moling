import { useState } from "react";
import { api, parseAdapterError, ProviderItem } from "../../lib/api";
import { useProviderStore } from "../../stores/providerStore";
import { KIND_OPTIONS } from "./ui";

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
    <div className="rounded-[var(--radius-card)] border border-theme p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium">{p.name}</span>
            <span className="rounded bg-hover px-1.5 py-0.5 text-[10px] text-secondary">
              {KIND_OPTIONS.find((k) => k.id === p.kind)?.label ?? p.kind}
            </span>
          </div>
          <div className="mt-1 text-xs text-tertiary">
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
            <div className="mt-1 inline-flex items-center gap-1 rounded-full border border-danger/25 bg-danger/10 px-2 py-0.5 text-[11px] text-danger">
              Key 失效：请重新填写
            </div>
          )}
          {status && (
            <div className="mt-1 text-xs text-secondary">{status}</div>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs">
          <label className="flex cursor-pointer items-center gap-1 text-secondary">
            <input
              type="radio"
              name="defaultProvider"
              checked={defaultProviderId === p.id}
              onChange={() => setDefaultProvider(p.id!)}
            />
            默认
          </label>
          <button
            onClick={onEdit}
            aria-label={`编辑服务商 ${p.name}`}
            className="rounded-[8px] border border-theme px-2 py-1"
          >
            编辑
          </button>
          <button
            onClick={doTest}
            aria-label={`测试服务商 ${p.name}`}
            className="rounded-[8px] border border-theme px-2 py-1"
          >
            测试
          </button>
          <button
            onClick={() => p.id && remove(p.id)}
            aria-label={`删除服务商 ${p.name}`}
            className="rounded-[8px] border border-theme px-2 py-1 text-danger"
          >
            删除
          </button>
        </div>
      </div>
    </div>
  );
}
