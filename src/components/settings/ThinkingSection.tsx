import { useEffect, useState } from "react";
import { api, parseAdapterError, ThinkingConfig } from "../../lib/api";
import { useProviderStore } from "../../stores/providerStore";
import { Button } from "../ui/Button";
import { Input } from "../ui/Field";
import { Row, Section } from "../ui/List";
import { Select } from "../ui/Select";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Switch } from "../ui/Switch";

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

  // 弹层类设置项没有可见 label 时用 aria-label 兜底
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
          : `连接失败：${r.error ? parseAdapterError(r.error).message : "未知"}`,
      );
    } catch (e) {
      setStatus(`连接失败：${String(e)}`);
    }
  };

  return (
    <Section
      title="思考模型"
      description="生成前先用大模型理解意图、扩写提示词"
    >
      <Row label="启用思考模型">
        <Switch
          checked={config.enabled}
          onCheckedChange={(v) => void save({ enabled: v })}
          label="启用思考模型"
        />
      </Row>

      {config.enabled && (
        <>
          <Row label="接入方式">
            <SegmentedControl
              value={config.mode}
              onValueChange={(v) => void save({ mode: v })}
              label="接入方式"
              size="sm"
              options={[
                { value: "reuse", label: "复用绘图服务商" },
                { value: "standalone", label: "独立配置" },
              ]}
            />
          </Row>

          {config.mode === "reuse" ? (
            <>
              <Row label="服务商" hint="沿用绘图服务商的地址与 Key">
                <Select
                  value={config.providerId ? String(config.providerId) : "none"}
                  onValueChange={(v) =>
                    void save({ providerId: v === "none" ? null : Number(v) })
                  }
                  options={[
                    { value: "none", label: "（未选择）" },
                    ...providers.map((p) => ({
                      value: String(p.provider.id),
                      label: p.provider.name,
                    })),
                  ]}
                  label="思考模型服务商"
                  widthClass="w-48"
                />
              </Row>
              <Row label="模型">
                <Input
                  value={config.model}
                  onChange={(e) =>
                    setConfig({ ...config, model: e.target.value })
                  }
                  onBlur={() => void save({ model: config.model })}
                  placeholder="如 gpt-4o-mini / deepseek-chat"
                  aria-label="思考模型名称"
                  widthClass="w-56"
                />
              </Row>
            </>
          ) : (
            <>
              <Row label="API 地址">
                <Input
                  value={config.baseUrl}
                  onChange={(e) =>
                    setConfig({ ...config, baseUrl: e.target.value })
                  }
                  onBlur={() => void save({ baseUrl: config.baseUrl })}
                  placeholder="https://api.example.com/v1"
                  aria-label="思考模型 API 地址"
                  widthClass="w-64"
                />
              </Row>
              <Row label="模型">
                <Input
                  value={config.model}
                  onChange={(e) =>
                    setConfig({ ...config, model: e.target.value })
                  }
                  onBlur={() => void save({ model: config.model })}
                  placeholder="如 gpt-4o-mini"
                  aria-label="思考模型名称"
                  widthClass="w-56"
                />
              </Row>
              <Row
                label="API Key"
                hint={
                  config.apiKeyMasked
                    ? `已保存 ${config.apiKeyMasked}（留空则不变）`
                    : "仅保存在本机，不明文回填"
                }
              >
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  onBlur={() => {
                    if (apiKey) void save({});
                  }}
                  placeholder="sk-..."
                  aria-label="思考模型 API Key"
                  widthClass="w-56"
                />
              </Row>
            </>
          )}

          <Row label="连接测试">
            <Button size="sm" loading={status === "测试中…"} onClick={doTest}>
              测试连接
            </Button>
            {status && status !== "测试中…" && (
              <span className="max-w-xs text-footnote text-tertiary">
                {status}
              </span>
            )}
          </Row>
        </>
      )}
    </Section>
  );
}
