import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, UpdateStatus } from "../../lib/api";

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
    <section>
      <h2 className="mb-4 text-lg font-semibold">关于与更新</h2>
      <div className="space-y-3 rounded-[var(--radius-card)] border border-theme p-4">
        <div className="flex items-center justify-between text-sm">
          <span className="text-secondary">当前版本</span>
          <span className="text-xs text-tertiary">
            {status?.currentVersion ?? "—"}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void check()}
            disabled={checking || installing}
            className="rounded-[8px] border border-theme px-3 py-1.5 text-xs disabled:opacity-50"
          >
            {checking ? "检查中…" : "检查更新"}
          </button>
          {available && (
            <button
              onClick={() => void install()}
              disabled={installing}
              className="rounded-[8px] bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-50"
            >
              {installing ? "安装中…" : `下载并安装 ${available.version}`}
            </button>
          )}
        </div>

        {available && (
          <div className="space-y-1 rounded-[8px] border border-theme p-3">
            <div className="flex items-center justify-between text-xs">
              <span className="text-secondary">新版本 {available.version}</span>
              {available.date && (
                <span className="text-tertiary">
                  {available.date.slice(0, 10)}
                </span>
              )}
            </div>
            {available.notes && (
              <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-tertiary">
                {available.notes}
              </p>
            )}
          </div>
        )}

        {progress && (
          <div className="space-y-1">
            <div className="h-1.5 overflow-hidden rounded-full bg-black/10">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-200"
                style={{ width: `${percent ?? 5}%` }}
              />
            </div>
            <p className="text-xs text-tertiary">
              {percent !== null
                ? `${percent}% · ${formatBytes(progress.downloaded)} / ${formatBytes(progress.total ?? 0)}`
                : `已下载 ${formatBytes(progress.downloaded)}`}
            </p>
          </div>
        )}

        {installing && (
          <p className="text-xs text-tertiary">
            安装过程中应用会自动退出，安装器完成后会重新启动。
          </p>
        )}
        {msg && <p className="text-xs text-tertiary">{msg}</p>}
      </div>
    </section>
  );
}
