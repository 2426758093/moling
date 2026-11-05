import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import {
  formatBytes,
  formatSpeed,
  useUpdateStore,
  type UpdatePhase,
} from "../../stores/updateStore";

function titleOf(phase: UpdatePhase): string {
  switch (phase) {
    case "available":
      return "发现新版本";
    case "downloading":
      return "正在下载更新";
    case "downloaded":
      return "更新已就绪";
    case "installing":
      return "正在安装更新";
    case "error":
      return "更新失败";
    default:
      return "软件更新";
  }
}

export default function UpdateDialog() {
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
              稍后
            </Button>
            <Button variant="primary" onClick={() => void download()}>
              下载更新
            </Button>
          </>
        );
      case "downloading":
        // 关掉弹窗不打断下载，完成后会重新弹出
        return (
          <Button variant="secondary" onClick={closeDialog}>
            后台下载
          </Button>
        );
      case "downloaded":
        return (
          <>
            <Button variant="ghost" onClick={closeDialog}>
              稍后安装
            </Button>
            <Button variant="primary" onClick={() => void install()}>
              立即安装并重启
            </Button>
          </>
        );
      case "installing":
        return (
          <Button variant="primary" loading>
            正在安装…
          </Button>
        );
      case "error":
        return (
          <>
            <Button variant="ghost" onClick={closeDialog}>
              稍后
            </Button>
            <Button variant="primary" onClick={() => void download()}>
              重试下载
            </Button>
          </>
        );
      default:
        return (
          <Button variant="ghost" onClick={closeDialog}>
            关闭
          </Button>
        );
    }
  };

  return (
    <Dialog
      open={dialogOpen}
      onOpenChange={(open) => (open ? openDialog() : closeDialog())}
      title={titleOf(phase)}
      description={
        phase === "available" && info
          ? `新版本 ${info.version} 已发布`
          : undefined
      }
      footer={footer()}
    >
      {info && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-footnote">
            <span className="text-secondary">新版本 {info.version}</span>
            {info.date && (
              <span className="text-tertiary">{info.date.slice(0, 10)}</span>
            )}
          </div>
          <p className="max-h-64 overflow-y-auto whitespace-pre-wrap text-footnote leading-relaxed text-tertiary">
            {info.notes?.trim() || "该版本未提供更新说明"}
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
              ? "下载完成，安装后应用会自动重启"
              : percent !== null
                ? `${percent}% · ${formatBytes(progress.downloaded)} / ${formatBytes(progress.total ?? 0)} · ${formatSpeed(progress.speed)} · ${progress.route || "自动选择线路"}`
                : `已下载 ${formatBytes(progress.downloaded)} · ${formatSpeed(progress.speed)} · ${progress.route || "自动选择线路"}`}
          </p>
        </div>
      )}

      {phase === "installing" && (
        <p className="mt-3 text-body text-secondary">
          正在安装更新，应用即将自动重启…
        </p>
      )}

      {phase === "error" && error && (
        <p className="mt-3 text-body text-danger">{error}</p>
      )}
    </Dialog>
  );
}
