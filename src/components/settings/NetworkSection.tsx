import { useEffect, useState } from "react";
import { api, ProxyInputPayload, ProxyMode } from "../../lib/api";
import { useProviderStore } from "../../stores/providerStore";
import { Button } from "../ui/Button";
import { Input } from "../ui/Field";
import { Row, Section } from "../ui/List";
import { Select } from "../ui/Select";

const MODES: { value: ProxyMode; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "direct", label: "直连（不使用代理）" },
  { value: "manual", label: "手动代理" },
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
    <Section
      title="网络与代理"
      description="下载模型与生成图片都会走这里的设置"
    >
      <Row label="代理模式">
        <Select
          value={mode}
          onValueChange={(v) => setMode(v as ProxyMode)}
          options={MODES}
          label="代理模式"
          widthClass="w-48"
        />
      </Row>

      {mode === "manual" && (
        <>
          <Row label="代理地址">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://127.0.0.1:7890"
              aria-label="代理地址"
              widthClass="w-64"
            />
          </Row>
          <Row label="用户名">
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="可选"
              aria-label="代理用户名"
              widthClass="w-64"
            />
          </Row>
          <Row label="密码">
            <Input
              type="password"
              value={password ?? ""}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={hasPassword ? "已保存，留空不修改" : "可选"}
              aria-label="代理密码"
              widthClass="w-64"
            />
          </Row>
          <Row label="跳过代理" hint="逗号分隔的主机名不经过代理">
            <Input
              value={noProxy}
              onChange={(e) => setNoProxy(e.target.value)}
              placeholder="localhost,127.0.0.1"
              aria-label="跳过代理的主机"
              widthClass="w-64"
            />
          </Row>
        </>
      )}

      <Row
        label="应用设置"
        hint={
          msg ? (
            <span className={msg.includes("失败") ? "text-danger" : undefined}>
              {msg}
            </span>
          ) : (
            "目前只支持 HTTP/HTTPS 代理"
          )
        }
      >
        <Button
          size="sm"
          variant="primary"
          loading={busy}
          onClick={() => void save()}
        >
          保存
        </Button>
        <Button size="sm" onClick={() => void test()} disabled={busy}>
          测试代理
        </Button>
      </Row>
    </Section>
  );
}
