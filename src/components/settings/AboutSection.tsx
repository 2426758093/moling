import { useEffect } from "react";
import { Button } from "../ui/Button";
import { Row, Section } from "../ui/List";
import { useUpdateStore } from "../../stores/updateStore";

export default function AboutSection() {
  const phase = useUpdateStore((s) => s.phase);
  const currentVersion = useUpdateStore((s) => s.currentVersion);
  const info = useUpdateStore((s) => s.info);
  const notice = useUpdateStore((s) => s.notice);
  const error = useUpdateStore((s) => s.error);
  const checked = useUpdateStore((s) => s.checked);
  const check = useUpdateStore((s) => s.check);
  const openDialog = useUpdateStore((s) => s.openDialog);

  // 启动检查可能被跳过（未配置）或静默失败：进入设置时补一次，顺带拿到当前版本号
  useEffect(() => {
    if (!checked) void check(false);
  }, [checked, check]);

  const hint =
    phase === "error" && error ? `下载失败：${error}` : notice || undefined;
  const busy = phase === "downloading" || phase === "installing";

  return (
    <Section title="关于与更新">
      <Row label="当前版本">
        <span className="text-subhead text-tertiary">
          {currentVersion || "—"}
        </span>
      </Row>
      <Row label="检查更新" hint={hint}>
        <Button
          size="sm"
          loading={phase === "checking"}
          disabled={busy}
          onClick={() => void check(true)}
        >
          检查更新
        </Button>
        {info && (
          <Button size="sm" variant="primary" onClick={openDialog}>
            {phase === "downloaded"
              ? `安装 ${info.version}`
              : phase === "downloading"
                ? "查看下载进度"
                : "查看更新"}
          </Button>
        )}
      </Row>

      {info && (
        <div className="border-b border-separator px-4 py-3 last:border-b-0">
          <div className="flex items-center justify-between text-footnote">
            <span className="text-secondary">新版本 {info.version}</span>
            {info.date && (
              <span className="text-tertiary">{info.date.slice(0, 10)}</span>
            )}
          </div>
          <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-footnote leading-relaxed text-tertiary">
            {info.notes?.trim() || "该版本未提供更新说明"}
          </p>
        </div>
      )}
    </Section>
  );
}
