import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, ImageRequestItem } from "../../lib/api";
import { toast } from "../../lib/notify";
import { Button } from "../ui/Button";
import { Section, Row } from "../ui/List";
import { Badge, BadgeTone } from "../ui/Badge";
import { ConfirmDialog } from "../ui/Dialog";

const STATE_STYLE: Record<string, { label: string; tone: BadgeTone }> = {
  unknown: { label: "结果未确认", tone: "warning" },
  billed_unrecovered: { label: "已计费未取回", tone: "danger" },
  partial: { label: "部分已保存", tone: "accent" },
};

const ENTRY_LABEL: Record<string, string> = {
  chat: "聊天",
  queue: "队列",
  edit: "编辑",
  transform: "变换",
  background: "换背景",
};

function errorSummary(raw: string | null): string {
  if (!raw) return "";
  try {
    const value = JSON.parse(raw);
    if (typeof value === "string") return value;
    const message = value?.message ?? value?.error;
    return typeof message === "string" ? message : raw;
  } catch {
    return raw;
  }
}

/** 请求记录：可能已计费却没有产物的请求，提供「不重新生成」的恢复入口 */
export default function RequestsSection() {
  const { t, i18n } = useTranslation();
  const [rows, setRows] = useState<ImageRequestItem[] | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [pendingAbandon, setPendingAbandon] = useState<ImageRequestItem | null>(
    null,
  );

  const load = useCallback(async () => {
    try {
      setRows(await api.listImageRequests(true));
    } catch (e) {
      toast(t("加载请求记录失败：{{error}}", { error: String(e) }), "error");
    }
  }, [t]);

  useEffect(() => {
    let alive = true;
    api
      .listImageRequests(true)
      .then((list) => {
        if (alive) setRows(list);
      })
      .catch((e) => {
        if (alive) {
          toast(t("加载请求记录失败：{{error}}", { error: String(e) }), "error");
        }
      });
    return () => {
      alive = false;
    };
  }, [t]);

  const formatTime = (value: string) => {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return value;
    return new Date(seconds * 1000).toLocaleString(i18n.language, {
      hour12: false,
    });
  };

  const requestLabel = (row: ImageRequestItem) =>
    row.providerRequestId || row.clientRequestId;

  const copyReconcile = async (row: ImageRequestItem) => {
    const style = STATE_STYLE[row.state];
    const entryLabel = ENTRY_LABEL[row.entry] ?? row.entry;
    const stateLabel = style ? style.label : row.state;
    const lines = [
      t("时间：{{time}}", { time: formatTime(row.createdAt) }),
      t("服务商：{{name}}", { name: row.providerName || "—" }),
      t("模型：{{model}}", { model: row.model || "—" }),
      t("入口：{{entry}}", { entry: t(entryLabel, entryLabel) }),
      t("张数：{{n}}", { n: row.imageCount }),
      t("状态：{{state}}", { state: t(stateLabel, stateLabel) }),
      t("HTTP 状态：{{status}}", { status: row.httpStatus ?? "—" }),
      t("请求 ID：{{id}}", { id: requestLabel(row) }),
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      toast(t("对账信息已复制"));
    } catch {
      toast(t("复制失败"), "error");
    }
  };

  const recover = async (row: ImageRequestItem) => {
    setBusyId(row.id);
    try {
      const outcome = await api.recoverImageRequest(row.id);
      const suffix =
        outcome.failed > 0
          ? t("（{{n}} 张仍失败）", { n: outcome.failed })
          : "";
      toast(
        t("已恢复 {{n}} 张到画廊", { n: outcome.recovered }) + suffix,
        outcome.failed > 0 ? "error" : "info",
      );
      await load();
    } catch (e) {
      toast(t("恢复失败：{{error}}", { error: String(e) }), "error");
    } finally {
      setBusyId(null);
    }
  };

  const abandon = async (row: ImageRequestItem) => {
    setBusyId(row.id);
    try {
      await api.abandonImageRequest(row.id);
      toast(t("已标记为确认无结果"));
      await load();
    } catch (e) {
      toast(t("标记失败：{{error}}", { error: String(e) }), "error");
    } finally {
      setBusyId(null);
    }
  };

  const openDir = async () => {
    try {
      await revealItemInDir(await api.getRequestsDir());
    } catch (e) {
      toast(t("打开目录失败：{{error}}", { error: String(e) }), "error");
    }
  };

  return (
    <Section
      title={t("请求记录")}
      description={t(
        "只列出可能已计费但没有取回图片的请求。恢复只读取本地缓存或重新下载图片地址，不会再次调用生成接口、不会重新扣费。",
      )}
      action={
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void load()}>
            {t("刷新")}
          </Button>
          <Button size="sm" onClick={() => void openDir()}>
            {t("打开缓存目录")}
          </Button>
        </div>
      }
    >
      {rows === null ? (
        <div className="px-4 py-6 text-subhead text-tertiary">
          {t("加载中…")}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col gap-1 px-4 py-6">
          <p className="text-subhead text-secondary">{t("没有待确认的请求")}</p>
          <p className="text-footnote text-tertiary">
            {t("生成失败且结果未确认时，这里会出现可恢复的记录")}
          </p>
        </div>
      ) : (
        rows.map((row) => {
          const style = STATE_STYLE[row.state];
          const stateLabel = style?.label ?? row.state;
          const entryLabel = ENTRY_LABEL[row.entry] ?? row.entry;
          const requestId = requestLabel(row);
          const summary = errorSummary(row.errorJson);
          return (
            <Row
              key={row.id}
              className="items-start"
              label={
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={style?.tone ?? "neutral"}>
                      {t(stateLabel, stateLabel)}
                    </Badge>
                    <span className="text-callout text-primary">
                      {row.model || "—"}
                    </span>
                    <span className="text-footnote text-tertiary">
                      {t(entryLabel, entryLabel)} ·{" "}
                      {t("{{n}} 张", { n: row.imageCount })}
                    </span>
                  </div>
                  <div className="text-footnote text-tertiary">
                    {formatTime(row.createdAt)}
                    {row.providerName ? ` · ${row.providerName}` : ""}
                    {row.httpStatus ? ` · HTTP ${row.httpStatus}` : ""}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(requestId)
                        .then(() => toast(t("已复制请求 ID")))
                        .catch(() => toast(t("复制失败"), "error"));
                    }}
                    className="w-fit break-all text-left text-footnote text-secondary transition-colors hover:text-primary"
                    title={t("复制请求 ID（对账用）")}
                  >
                    {t("请求 ID：{{id}}", { id: requestId })}
                  </button>
                  {summary && (
                    <p className="line-clamp-2 max-w-xl text-footnote text-tertiary">
                      {summary}
                    </p>
                  )}
                </div>
              }
            >
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  loading={busyId === row.id}
                  onClick={() => void recover(row)}
                >
                  {t("尝试恢复")}
                </Button>
                <Button size="sm" onClick={() => void copyReconcile(row)}>
                  {t("复制对账信息")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busyId === row.id}
                  onClick={() => setPendingAbandon(row)}
                >
                  {t("标记已确认无结果")}
                </Button>
              </div>
            </Row>
          );
        })
      )}
      <ConfirmDialog
        open={pendingAbandon !== null}
        onOpenChange={(open) => {
          if (!open) setPendingAbandon(null);
        }}
        title={t("标记为已确认无结果？")}
        description={t(
          "仅用于让这条记录不再出现在待确认列表，不会影响服务商的计费记录。请先到服务商后台确认确实没有出图。",
        )}
        confirmLabel={t("标记为已确认")}
        danger
        onConfirm={() => {
          const row = pendingAbandon;
          setPendingAbandon(null);
          if (row) void abandon(row);
        }}
      />
    </Section>
  );
}
