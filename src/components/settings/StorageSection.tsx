import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { api, StorageStats, DirStat } from "../../lib/api";
import { toast } from "../../lib/notify";
import { Button } from "../ui/Button";
import { Section, Row } from "../ui/List";
import { Select } from "../ui/Select";
import { ConfirmDialog } from "../ui/Dialog";

const RETENTION_DAYS = [7, 15, 30, 60, 90, 180, 365] as const;

type CardLabel = "图片" | "缩略图" | "参考图" | "回收站" | "数据库";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

/** 存储路径与缓存：媒体根可迁移，数据库/日志固定；清理与保留天数在此管理 */
export default function StorageSection({ dataDir }: { dataDir: string }) {
  const { t } = useTranslation();
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [retention, setRetention] = useState("30");
  const [busy, setBusy] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [pendingPath, setPendingPath] = useState<string | null>(null);

  const statText = (stat: { files: number; bytes: number }) =>
    t("{{n}} 个 · {{size}}", {
      n: stat.files,
      size: formatBytes(stat.bytes),
    });

  const refreshStats = useCallback(async () => {
    try {
      setStats(await api.storageStats());
    } catch {
      // 统计失败不影响其它设置项
    }
  }, []);

  useEffect(() => {
    let alive = true;
    api
      .storageStats()
      .then((s) => {
        if (alive) setStats(s);
      })
      .catch(() => undefined);
    api
      .getSetting("cacheRetentionDays")
      .then((v) => {
        if (alive && v && /^\d+$/.test(v)) setRetention(v);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const pickFolder = async () => {
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        title: t("选择媒体目录（图片与参考图）"),
      });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (path) setPendingPath(path);
    } catch (e) {
      toast(t("打开目录选择器失败：{{error}}", { error: String(e) }), "error");
    }
  };

  const doMigrate = async () => {
    if (!pendingPath) return;
    setBusy(true);
    try {
      const report = await api.setMediaRoot(pendingPath);
      toast(
        t("已迁移 {{n}} 个文件（{{size}}）", {
          n: report.filesCopied,
          size: formatBytes(report.bytesCopied),
        }),
      );
      await refreshStats();
    } catch (e) {
      toast(t("更改位置失败：{{error}}", { error: String(e) }), "error");
    } finally {
      setBusy(false);
      setPendingPath(null);
    }
  };

  const saveRetention = async (days: string) => {
    setRetention(days);
    try {
      await api.setSetting("cacheRetentionDays", days);
      toast(t("缓存保留期已设为 {{n}} 天", { n: days }));
    } catch (e) {
      toast(t("保存缓存保留期失败：{{error}}", { error: String(e) }), "error");
    }
  };

  const doClean = async () => {
    setCleaning(true);
    try {
      const r = await api.cleanCache(Number(retention));
      const actions = r.moved + r.refsMoved + r.pruned + r.thumbsCreated;
      toast(
        actions > 0
          ? t("已清理：图片 {{images}}、参考图 {{refs}}、过期缓存 {{pruned}}", {
              images: r.moved,
              refs: r.refsMoved,
              pruned: r.pruned,
            })
          : t("没有可清理的缓存"),
      );
      await refreshStats();
    } catch (e) {
      toast(t("清理缓存失败：{{error}}", { error: String(e) }), "error");
    } finally {
      setCleaning(false);
    }
  };

  const cards: Array<[CardLabel, DirStat]> = stats
    ? [
        ["图片", stats.images],
        ["缩略图", stats.thumbs],
        ["参考图", stats.refs],
        ["回收站", stats.trash],
        ["数据库", stats.database],
      ]
    : [];

  return (
    <>
      <Section
        title={t("存储与缓存")}
        description={t(
          "图片与参考图可以放到其它磁盘；数据库与日志始终留在应用数据目录。删除或移动图片前会先进入各自的 .trash，保留期到期后才清理。",
        )}
        action={
          <Button size="sm" onClick={() => void refreshStats()}>
            {t("刷新占用")}
          </Button>
        }
      >
        <Row
          label={t("媒体目录")}
          hint={t("画廊图片、聊天附件、队列与预设参考图")}
        >
          <span className="max-w-xs truncate text-footnote text-tertiary">
            {stats?.mediaRoot ?? t("读取中…")}
          </span>
          <Button size="sm" loading={busy} onClick={() => void pickFolder()}>
            {t("更改位置…")}
          </Button>
        </Row>
        <Row label={t("数据库与日志")} hint={t("固定位置，不随媒体目录迁移")}>
          <span className="max-w-xs truncate text-footnote text-tertiary">
            {dataDir}
          </span>
        </Row>
        {stats && (
          <div className="grid grid-cols-2 gap-2 border-b border-separator px-4 py-3 sm:grid-cols-3">
            {cards.map(([label, stat]) => (
              <div key={label} className="rounded-card bg-fill px-3 py-2">
                <div className="text-caption text-tertiary">{t(label)}</div>
                <div className="text-footnote text-primary">
                  {statText(stat)}
                </div>
              </div>
            ))}
          </div>
        )}
        <Row
          label={t("缓存保留期")}
          hint={t("回收站中的文件超过该天数后，在下次启动或手动清理时删除")}
        >
          <Select
            value={retention}
            onValueChange={(v) => void saveRetention(v)}
            options={RETENTION_DAYS.map((days) => ({
              value: String(days),
              label: t("{{n}} 天", { n: days }),
            }))}
            label={t("缓存保留期")}
            widthClass="w-32"
          />
          <Button size="sm" loading={cleaning} onClick={() => void doClean()}>
            {t("立即清理缓存")}
          </Button>
        </Row>
      </Section>
      <ConfirmDialog
        open={pendingPath !== null}
        onOpenChange={(v) => {
          if (!v) setPendingPath(null);
        }}
        title={t("更改媒体目录")}
        description={
          <>
            {t("将把图片与参考图复制到：")}
            <br />
            <span className="break-all text-primary">{pendingPath}</span>
            <br />
            {t(
              "迁移成功后更新数据库中的路径并删除旧目录中的媒体文件；数据库与日志位置不变。队列有任务运行时会拒绝执行。",
            )}
          </>
        }
        confirmLabel={t("开始迁移")}
        onConfirm={() => void doMigrate()}
      />
    </>
  );
}
