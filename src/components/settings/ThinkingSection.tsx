import { useEffect, useState } from "react";
import { api, ThinkingConfig } from "../../lib/api";
import { useProviderStore } from "../../stores/providerStore";
import { inputCls } from "./ui";

export default function ThinkingSection() {
  const [config, setConfig] = useState<ThinkingConfig | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState("");
  const providers = useProviderStore((s) => s.providers);

  useEffect(() => {
    api
      .getThinkingConfig()
      .then(setConfig)
      .catch(() => undefined);
  }, []);

  if (!config) return null;

  const save = async (patch: Partial<ThinkingConfig>) => {
    const next = { ...config, ...patch };
    setConfig(await api.saveThinkingConfig(next, apiKey || null));
    setApiKey("");
  };

  const doTest = async () => {
    setStatus("测试中…");
    try {
      const r = await api.testThinkingConnection();
      setStatus(
        r.ok
          ? `连接正常 · ${r.latencyMs}ms`
          : `连接失败：${r.error?.message ?? "未知"}`,
      );
    } catch (e) {
      setStatus(`连接失败：${String(e)}`);
    }
  };

  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold">思考模型</h2>
      <div className="space-y-3 rounded-[var(--radius-card)] border border-theme p-4">
        <div className="flex items-center justify-between text-sm">
          <div>
            <div className="text-primary">启用思考模型</div>
            <div className="mt-0.5 text-xs text-tertiary">
              生成前先用大模型理解意图、扩写提示词
            </div>
          </div>
          <button
            onClick={() => save({ enabled: !config.enabled })}
            className={`relative h-5 w-9 rounded-full transition-colors duration-200 ${
              config.enabled ? "bg-success" : "bg-sunken"
            }`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all duration-200 ${
                config.enabled ? "left-[18px]" : "left-0.5"
              }`}
            />
          </button>
        </div>

        {config.enabled && (
          <>
            <div className="flex gap-2 text-xs">
              {(
                [
                  { id: "reuse", label: "复用绘图服务商" },
                  { id: "standalone", label: "独立配置" },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  onClick={() => save({ mode: m.id })}
                  className={`rounded-full border px-3 py-1 transition-colors ${
                    config.mode === m.id
                      ? "border-accent bg-accent-soft"
                      : "border-theme text-secondary"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {config.mode === "reuse" ? (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="mb-1 text-xs text-secondary">服务商</div>
                  <select
                    value={config.providerId ?? ""}
                    onChange={(e) =>
                      save({
                        providerId:
                          e.target.value === "" ? null : Number(e.target.value),
                      })
                    }
                    className={inputCls}
                  >
                    <option value="">（未选择）</option>
                    {providers.map((p) => (
                      <option key={p.provider.id} value={p.provider.id!}>
                        {p.provider.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="mb-1 text-xs text-secondary">模型</div>
                  <input
                    className={inputCls}
                    value={config.model}
                    onChange={(e) =>
                      setConfig({ ...config, model: e.target.value })
                    }
                    onBlur={() => save({ model: config.model })}
                    placeholder="如 gpt-4o-mini / deepseek-chat"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="mb-1 text-xs text-secondary">API 地址</div>
                    <input
                      className={inputCls}
                      value={config.baseUrl}
                      onChange={(e) =>
                        setConfig({ ...config, baseUrl: e.target.value })
                      }
                      onBlur={() => save({ baseUrl: config.baseUrl })}
                      placeholder="https://api.example.com/v1"
                    />
                  </div>
                  <div>
                    <div className="mb-1 text-xs text-secondary">模型</div>
                    <input
                      className={inputCls}
                      value={config.model}
                      onChange={(e) =>
                        setConfig({ ...config, model: e.target.value })
                      }
                      onBlur={() => save({ model: config.model })}
                      placeholder="如 gpt-4o-mini"
                    />
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-xs text-secondary">
                    API Key
                    {config.apiKeyMasked && (
                      <span className="ml-2 text-tertiary">
                        已保存 {config.apiKeyMasked}（留空则不变）
                      </span>
                    )}
                  </div>
                  <input
                    className={inputCls}
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    onBlur={() => apiKey && save({})}
                    placeholder="sk-..."
                  />
                </div>
              </div>
            )}

            <div className="flex items-center gap-3">
              <button
                onClick={doTest}
                className="rounded-[8px] border border-theme px-3 py-1 text-xs"
              >
                测试连接
              </button>
              {status && (
                <span className="text-xs text-tertiary">{status}</span>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
