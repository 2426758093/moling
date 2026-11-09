import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import {
  formatBytes,
  formatSpeed,
  useUpdateStore,
  type UpdatePhase,
} from "../../stores/updateStore";

function titleOf(phase: UpdatePhase) {
  switch (phase) {
    case "available":
      return "发现新版本" as const;
    case "downloading":
      return "正在下载更新" as const;
    case "downloaded":
      return "更新已就绪" as const;
    case "installing":
      return "正在安装更新" as const;
    case "error":
      return "更新失败" as const;
    default:
      return "软件更新" as const;
  }
}

export default function UpdateDialog() {
  const { t } = useTranslation();
  const dialogOpen = useUpdateStore((s) => s.dialogOpen);
  const phase = useUpdateStore((s) => s.phase);
  const info = useUpdateStore((s) => s.info);
  const progress = useUpdateStore((s) => s.progress);
  const error = useUpdateStore((s) => s.error);
  const download = useUpdateStore((s) => s.download);
  const install = useUpdateStore((s) => s.install);
  const closeDialog = useUpdateStore((s) => s.closeDialog);
  const openDialog = useUpdateStore((s) => s.openDialog);

  const percent =
    progress?.total && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;
  const showProgress =
    progress !== null && (phase === "downloading" || phase === "downloaded");

  const footer = () => {
    switch (phase) {
      case "available":
        return (
          <>
            <Button variant="ghost" onClick={closeDialog}>
              {t("稍后")}
            </Button>
            <Button variant="primary" onClick={() => void download()}>
              {t("下载更新")}
            </Button>
          </>
        );
      case "downloading":
        // 关掉弹窗不打断下载，完成后会重新弹出
        return (
          <Button variant="secondary" onClick={closeDialog}>
            {t("后台下载")}
          </Button>
        );
      case "downloaded":
        return (
          <>
            <Button variant="ghost" onClick={closeDialog}>
              {t("稍后安装")}
            </Button>
            <Button variant="primary" onClick={() => void install()}>
              {t("立即安装并重启")}
            </Button>
          </>
        );
      case "installing":
        return (
          <Button variant="primary" loading>
            {t("正在安装…")}
          </Button>
        );
      case "error":
        return (
          <>
            <Button variant="ghost" onClick={closeDialog}>
              {t("稍后")}
            </Button>
            <Button variant="primary" onClick={() => void download()}>
              {t("重试下载")}
            </Button>
          </>
        );
      default:
        return (
          <Button variant="ghost" onClick={closeDialog}>
            {t("关闭")}
          </Button>
        );
    }
  };

  return (
    <Dialog
      open={dialogOpen}
      onOpenChange={(open) => (open ? openDialog() : closeDialog())}
      title={t(titleOf(phase))}
      description={
        phase === "available" && info
          ? t("新版本 {{version}} 已发布", { version: info.version })
          : undefined
      }
      footer={footer()}
    >
      {info && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-footnote">
            <span className="text-secondary">
              {t("新版本 {{version}}", { version: info.version })}
            </span>
            {info.date && (
              <span className="text-tertiary">{info.date.slice(0, 10)}</span>
            )}
          </div>
          <p className="max-h-64 overflow-y-auto whitespace-pre-wrap text-footnote leading-relaxed text-tertiary">
            {info.notes?.trim() || t("该版本未提供更新说明")}
          </p>
        </div>
      )}

      {showProgress && progress && (
        <div className="mt-3 space-y-1.5">
          <div className="h-1 overflow-hidden rounded-pill bg-sunken">
            <div
              className="h-full rounded-pill bg-accent-fill transition-[width] duration-200 ease-ios"
              style={{ width: `${percent ?? 5}%` }}
            />
          </div>
          <p className="text-footnote text-tertiary">
            {phase === "downloaded"
              ? t("下载完成，安装后应用会自动重启")
              : percent !== null
                ? t(
                    "{{percent}}% · {{downloaded}} / {{total}} · {{speed}} · {{route}}",
                    {
                      percent,
                      downloaded: formatBytes(progress.downloaded),
                      total: formatBytes(progress.total ?? 0),
                      speed: formatSpeed(progress.speed),
                      route: progress.route || t("自动选择线路"),
                    },
                  )
                : t("已下载 {{downloaded}} · {{speed}} · {{route}}", {
                    downloaded: formatBytes(progress.downloaded),
                    speed: formatSpeed(progress.speed),
                    route: progress.route || t("自动选择线路"),
                  })}
          </p>
        </div>
      )}

      {phase === "installing" && (
        <p className="mt-3 text-body text-secondary">
          {t("正在安装更新，应用即将自动重启…")}
        </p>
      )}

      {phase === "error" && error && (
        <p className="mt-3 text-body text-danger">{error}</p>
      )}
    </Dialog>
  );
}
