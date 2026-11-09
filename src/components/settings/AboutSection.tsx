import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import { Row, Section } from "../ui/List";
import { useUpdateStore } from "../../stores/updateStore";

export default function AboutSection() {
  const { t } = useTranslation();
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
    phase === "error" && error
      ? t("下载失败：{{error}}", { error })
      : notice || undefined;
  const busy = phase === "downloading" || phase === "installing";

  return (
    <Section title={t("关于与更新")}>
      <Row label={t("当前版本")}>
        <span className="text-subhead text-tertiary">
          {currentVersion || "—"}
        </span>
      </Row>
      <Row label={t("检查更新")} hint={hint}>
        <Button
          size="sm"
          loading={phase === "checking"}
          disabled={busy}
          onClick={() => void check(true)}
        >
          {t("检查更新")}
        </Button>
        {info && (
          <Button size="sm" variant="primary" onClick={openDialog}>
            {phase === "downloaded"
              ? t("安装 {{version}}", { version: info.version })
              : phase === "downloading"
                ? t("查看下载进度")
                : t("查看更新")}
          </Button>
        )}
      </Row>

      {info && (
        <div className="border-b border-separator px-4 py-3 last:border-b-0">
          <div className="flex items-center justify-between text-footnote">
            <span className="text-secondary">
              {t("新版本 {{version}}", { version: info.version })}
            </span>
            {info.date && (
              <span className="text-tertiary">{info.date.slice(0, 10)}</span>
            )}
          </div>
          <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-footnote leading-relaxed text-tertiary">
            {info.notes?.trim() || t("该版本未提供更新说明")}
          </p>
        </div>
      )}
    </Section>
  );
}
