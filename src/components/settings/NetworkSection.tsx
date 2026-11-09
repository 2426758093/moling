import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, ProxyInputPayload, ProxyMode } from "../../lib/api";
import {
  BODY_IDLE_DEFAULT,
  BODY_IDLE_MAX,
  BODY_IDLE_MIN,
  BODY_TOTAL_DEFAULT,
  BODY_TOTAL_MAX,
  BODY_TOTAL_MIN,
  parseBodyTimeouts,
} from "../../lib/bodyTimeouts";
import { useProviderStore } from "../../stores/providerStore";
import { Button } from "../ui/Button";
import { Input } from "../ui/Field";
import { Row, Section } from "../ui/List";
import { Select } from "../ui/Select";

const MODES = [
  { value: "system", label: "跟随系统" },
  { value: "direct", label: "直连（不使用代理）" },
  { value: "manual", label: "手动代理" },
] as const;

export default function NetworkSection() {
  const { t } = useTranslation();
  const providers = useProviderStore((s) => s.providers);
  const defaultProviderId = useProviderStore((s) => s.defaultProviderId);
  const [mode, setMode] = useState<ProxyMode>("system");
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  // null = 保持已保存密码；"" = 显式清除；其余为新密码
  const [password, setPassword] = useState<string | null>(null);
  const [noProxy, setNoProxy] = useState("");
  const [hasPassword, setHasPassword] = useState(false);
  const [idleTimeout, setIdleTimeout] = useState(String(BODY_IDLE_DEFAULT));
  const [totalTimeout, setTotalTimeout] = useState(String(BODY_TOTAL_DEFAULT));
  const [msg, setMsg] = useState("");
  const [msgError, setMsgError] = useState(false);
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
      .catch((e) => {
        setMsg(t("读取代理设置失败：{{error}}", { error: String(e) }));
        setMsgError(true);
      });
    api
      .getSetting("bodyIdleTimeoutSecs")
      .then((v) => {
        if (v) setIdleTimeout(v);
      })
      .catch(() => undefined);
    api
      .getSetting("bodyTotalTimeoutSecs")
      .then((v) => {
        if (v) setTotalTimeout(v);
      })
      .catch(() => undefined);
    // 语言切换后重读一次，让错误提示跟随界面语言
  }, [t]);

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
    setMsgError(false);
    try {
      const timeouts = parseBodyTimeouts(idleTimeout, totalTimeout);
      const cfg = await api.saveProxyConfig(payload());
      setHasPassword(cfg.hasPassword);
      setPassword(null);
      await api.setSetting("bodyIdleTimeoutSecs", String(timeouts.idle));
      await api.setSetting("bodyTotalTimeoutSecs", String(timeouts.total));
      setIdleTimeout(String(timeouts.idle));
      setTotalTimeout(String(timeouts.total));
      setMsg(t("已保存并生效"));
    } catch (e) {
      setMsg(t("保存失败：{{error}}", { error: String(e) }));
      setMsgError(true);
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    const providerId = defaultProviderId ?? providers[0]?.provider.id;
    if (!providerId) {
      setMsg(t("请先在「服务商管理」中添加服务商，再测试代理"));
      setMsgError(true);
      return;
    }
    setBusy(true);
    setMsg(t("正在测试…"));
    setMsgError(false);
    try {
      const r = await api.testProxy(payload(), providerId);
      setMsg(
        r.ok
          ? t("代理链路可达（{{ms}}ms，HTTP {{status}}）", {
              ms: r.latencyMs ?? 0,
              status: r.status ?? "-",
            })
          : t("测试失败：{{error}}", {
              error: r.error ?? t("未知错误"),
            }),
      );
      setMsgError(!r.ok);
    } catch (e) {
      setMsg(t("测试失败：{{error}}", { error: String(e) }));
      setMsgError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title={t("网络与代理")}
      description={t("下载模型与生成图片都会走这里的设置")}
    >
      <Row label={t("代理模式")}>
        <Select
          value={mode}
          onValueChange={(v) => setMode(v as ProxyMode)}
          options={MODES.map((m) => ({ value: m.value, label: t(m.label) }))}
          label={t("代理模式")}
          widthClass="w-48"
        />
      </Row>

      {mode === "manual" && (
        <>
          <Row
            label={t("代理地址")}
            hint={t(
              "支持 http / https / socks5 / socks5h；应用内更新不支持 socks5",
            )}
          >
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t(
                "http://127.0.0.1:7890 或 socks5://127.0.0.1:1080",
              )}
              aria-label={t("代理地址")}
              widthClass="w-64"
            />
          </Row>
          <Row label={t("用户名")}>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t("可选")}
              aria-label={t("代理用户名")}
              widthClass="w-64"
            />
          </Row>
          <Row label={t("密码")}>
            <Input
              type="password"
              value={password ?? ""}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={hasPassword ? t("已保存，留空不修改") : t("可选")}
              aria-label={t("代理密码")}
              widthClass="w-64"
            />
          </Row>
          <Row label={t("跳过代理")} hint={t("逗号分隔的主机名不经过代理")}>
            <Input
              value={noProxy}
              onChange={(e) => setNoProxy(e.target.value)}
              placeholder="localhost,127.0.0.1"
              aria-label={t("跳过代理的主机")}
              widthClass="w-64"
            />
          </Row>
        </>
      )}

      <Row
        label={t("无数据超时")}
        hint={t(
          "连续 {{idle}} 秒收不到新数据才判定失败（{{min}}–{{max}} 秒）",
          {
            idle: idleTimeout || "?",
            min: BODY_IDLE_MIN,
            max: BODY_IDLE_MAX,
          },
        )}
      >
        <Input
          type="number"
          min={BODY_IDLE_MIN}
          max={BODY_IDLE_MAX}
          value={idleTimeout}
          onChange={(e) => setIdleTimeout(e.target.value)}
          suffix={t("秒")}
          aria-label={t("响应体无数据超时")}
          widthClass="w-32"
        />
      </Row>
      <Row
        label={t("响应体总超时")}
        hint={t(
          "整段响应体下载的最长耗时，不能小于无数据超时（{{min}}–{{max}} 秒）",
          {
            min: BODY_TOTAL_MIN,
            max: BODY_TOTAL_MAX,
          },
        )}
      >
        <Input
          type="number"
          min={BODY_TOTAL_MIN}
          max={BODY_TOTAL_MAX}
          value={totalTimeout}
          onChange={(e) => setTotalTimeout(e.target.value)}
          suffix={t("秒")}
          aria-label={t("响应体总超时")}
          widthClass="w-32"
        />
      </Row>

      <Row
        label={t("应用设置")}
        hint={
          msg ? (
            <span className={msgError ? "text-danger" : undefined}>{msg}</span>
          ) : (
            t("目前只支持 HTTP/HTTPS 代理")
          )
        }
      >
        <Button
          size="sm"
          variant="primary"
          loading={busy}
          onClick={() => void save()}
        >
          {t("保存")}
        </Button>
        <Button size="sm" onClick={() => void test()} disabled={busy}>
          {t("测试代理")}
        </Button>
      </Row>
    </Section>
  );
}
