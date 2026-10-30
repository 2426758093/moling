import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, UpdateStatus } from "../../lib/api";
import { Button } from "../ui/Button";
import { Row, Section } from "../ui/List";

interface DownloadProgress {
  downloaded: number;
  total: number | null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function AboutSection() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [msg, setMsg] = useState("");
  const installingRef = useRef(false);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    listen<DownloadProgress>("update:progress", (e) => {
      setProgress({
        downloaded: e.payload.downloaded,
        total: e.payload.total ?? null,
      });
    })
      .then((fn) => {
        // StrictMode 下 effect 会跑两遍：卸载后才拿到的监听要立刻退订
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const check = async () => {
    setChecking(true);
    setMsg("");
    try {
      const s = await api.getUpdateStatus();
      setStatus(s);
      if (!s.configured) setMsg("当前版本未接入更新源，无法检查更新");
      else if (s.error) setMsg(`检查更新失败：${s.error}`);
      else if (!s.available) setMsg("当前已是最新版本");
    } catch (e) {
      setMsg(`检查更新失败：${String(e)}`);
    } finally {
      setChecking(false);
    }
  };

  const install = async () => {
    if (installingRef.current) return;
    installingRef.current = true;
    setInstalling(true);
    setProgress({ downloaded: 0, total: null });
    setMsg("正在下载更新…");
    try {
      // 成功后进程会重启，这里通常不会返回
      await api.installUpdate();
      setMsg("安装完成，正在重启…");
    } catch (e) {
      setMsg(`安装更新失败：${String(e)}`);
      setProgress(null);
      installingRef.current = false;
      setInstalling(false);
    }
  };

  const available = status?.available ?? null;
  const percent =
    progress?.total && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;

  return (
    <Section title="关于与更新">
      <Row label="当前版本">
        <span className="text-subhead text-tertiary">
          {status?.currentVersion ?? "—"}
        </span>
      </Row>
      <Row
        label="检查更新"
        hint={
          msg || (installing ? "安装过程中应用会自动退出并重新启动" : undefined)
        }
      >
        <Button
          size="sm"
          loading={checking}
          disabled={installing}
          onClick={() => void check()}
        >
          检查更新
        </Button>
        {available && (
          <Button
            size="sm"
            variant="primary"
            loading={installing}
            onClick={() => void install()}
          >
            下载并安装 {available.version}
          </Button>
        )}
      </Row>

      {available && (
        <div className="border-b border-separator px-4 py-3 last:border-b-0">
          <div className="flex items-center justify-between text-footnote">
            <span className="text-secondary">新版本 {available.version}</span>
            {available.date && (
              <span className="text-tertiary">
                {available.date.slice(0, 10)}
              </span>
            )}
          </div>
          {available.notes && (
            <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-footnote leading-relaxed text-tertiary">
              {available.notes}
            </p>
          )}
        </div>
      )}

      {progress && (
        <div className="space-y-1.5 px-4 py-3">
          <div className="h-1 overflow-hidden rounded-pill bg-sunken">
            <div
              className="h-full rounded-pill bg-accent-fill transition-[width] duration-200 ease-ios"
              style={{ width: `${percent ?? 5}%` }}
            />
          </div>
          <p className="text-footnote text-tertiary">
            {percent !== null
              ? `${percent}% · ${formatBytes(progress.downloaded)} / ${formatBytes(progress.total ?? 0)}`
              : `已下载 ${formatBytes(progress.downloaded)}`}
          </p>
        </div>
      )}
    </Section>
  );
}
