import { useEffect, useState } from "react";
import { api, ProxyInputPayload, ProxyMode } from "../../lib/api";
import { useProviderStore } from "../../stores/providerStore";

const MODES: { id: ProxyMode; label: string }[] = [
  { id: "system", label: "跟随系统" },
  { id: "direct", label: "直连（不使用代理）" },
  { id: "manual", label: "手动代理" },
];

export default function NetworkSection() {
  const providers = useProviderStore((s) => s.providers);
  const defaultProviderId = useProviderStore((s) => s.defaultProviderId);
  const [mode, setMode] = useState<ProxyMode>("system");
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  // null = 保持已保存密码；"" = 显式清除；其余为新密码
  const [password, setPassword] = useState<string | null>(null);
  const [noProxy, setNoProxy] = useState("");
  const [hasPassword, setHasPassword] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .getProxyConfig()
      .then((cfg) => {
        setMode(cfg.mode);
        setUrl(cfg.url);
        setUsername(cfg.username);
        setNoProxy(cfg.noProxy);
        setHasPassword(cfg.hasPassword);
      })
      .catch((e) => setMsg(`读取代理设置失败：${String(e)}`));
  }, []);

  const payload = (): ProxyInputPayload => ({
    mode,
    url,
    username,
    password,
    noProxy,
  });

  const save = async () => {
    setBusy(true);
    setMsg("");
    try {
      const cfg = await api.saveProxyConfig(payload());
      setHasPassword(cfg.hasPassword);
      setPassword(null);
      setMsg("已保存并生效");
    } catch (e) {
      setMsg(`保存失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    const providerId = defaultProviderId ?? providers[0]?.provider.id;
    if (!providerId) {
      setMsg("请先在「服务商管理」中添加服务商，再测试代理");
      return;
    }
    setBusy(true);
    setMsg("正在测试…");
    try {
      const r = await api.testProxy(payload(), providerId);
      setMsg(
        r.ok
          ? `代理链路可达（${r.latencyMs ?? 0}ms，HTTP ${r.status ?? "-"}）`
          : `测试失败：${r.error ?? "未知错误"}`,
      );
    } catch (e) {
      setMsg(`测试失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold">网络与代理</h2>
      <div className="space-y-3 rounded-[var(--radius-card)] border border-theme p-4">
        <div className="flex items-center justify-between text-sm">
          <span className="text-secondary">代理模式</span>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as ProxyMode)}
            className="rounded-[8px] border border-theme bg-transparent px-2 py-1 text-xs"
          >
            {MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>

        {mode === "manual" && (
          <>
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="shrink-0 text-secondary">代理地址</span>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="http://127.0.0.1:7890"
                className="min-w-0 flex-1 rounded-[8px] border border-theme bg-transparent px-2 py-1 text-xs"
              />
            </div>
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="shrink-0 text-secondary">用户名</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="可选"
                className="min-w-0 flex-1 rounded-[8px] border border-theme bg-transparent px-2 py-1 text-xs"
              />
            </div>
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="shrink-0 text-secondary">密码</span>
              <input
                type="password"
                value={password ?? ""}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={hasPassword ? "已保存，留空不修改" : "可选"}
                className="min-w-0 flex-1 rounded-[8px] border border-theme bg-transparent px-2 py-1 text-xs"
              />
            </div>
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="shrink-0 text-secondary">跳过代理</span>
              <input
                value={noProxy}
                onChange={(e) => setNoProxy(e.target.value)}
                placeholder="localhost,127.0.0.1"
                className="min-w-0 flex-1 rounded-[8px] border border-theme bg-transparent px-2 py-1 text-xs"
              />
            </div>
            <p className="text-xs text-tertiary">
              目前只支持 HTTP/HTTPS
              代理；密码留空表示保持原值，清空后保存表示清除。
            </p>
          </>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            onClick={() => void save()}
            disabled={busy}
            className="rounded-[8px] bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-50"
          >
            保存
          </button>
          <button
            onClick={() => void test()}
            disabled={busy}
            className="rounded-[8px] border border-theme px-3 py-1.5 text-xs disabled:opacity-50"
          >
            测试代理
          </button>
          {msg && <span className="w-full text-xs text-tertiary">{msg}</span>}
        </div>
      </div>
    </section>
  );
}
