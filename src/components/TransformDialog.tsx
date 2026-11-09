import { useState } from "react";
import { useTranslation } from "react-i18next";
import { TransformTarget, useAppStore } from "../stores/appStore";
import { useProviderStore } from "../stores/providerStore";
import { api, adapterErrorTitle, parseAdapterError, isUnconfirmedError, AdapterError } from "../lib/api";
import { deliverEditResult } from "../lib/deliverEditResult";
import { ensureRasterDataUrl } from "../lib/file";
import { toast } from "../lib/notify";
import { Dialog, ConfirmDialog } from "./ui/Dialog";
import { Button } from "./ui/Button";
import { Input } from "./ui/Field";
import { SegmentedControl } from "./ui/SegmentedControl";
import { Select } from "./ui/Select";
import SafeImg from "./SafeImg";
import { useStylePresets } from "../stores/stylePresetStore";

/// 高清放大 / 风格转换：走服务商 API，结果作为派生图进入当前会话，
/// 并带上「派生自」标注（父记录 id 同时落库）。
export default function TransformDialog() {
  const target = useAppStore((s) => s.transformTarget);
  const close = useAppStore((s) => s.closeTransform);
  if (!target) return null;
  // key 变化即重建内部状态：比在 effect 里重置状态少一轮级联渲染
  return (
    <TransformBody
      key={`${target.historyId}-${target.kind}`}
      target={target}
      close={close}
    />
  );
}

function TransformBody({
  target,
  close,
}: {
  target: TransformTarget;
  close: () => void;
}) {
  const { t } = useTranslation();
  const defaultProviderId = useProviderStore((s) => s.defaultProviderId);
  const providers = useProviderStore((s) => s.providers);
  const item = providers.find((p) => p.provider.id === defaultProviderId);
  let models: string[] = [];
  try {
    const parsed: unknown = JSON.parse(item?.provider.modelsJson || "[]");
    if (Array.isArray(parsed))
      models = parsed.filter((m) => typeof m === "string");
  } catch {
    // 损坏的模型列表按空处理，仍可用默认模型
  }
  if (models.length === 0 && item?.provider.defaultModel) {
    models = [item.provider.defaultModel];
  }
  const [model, setModel] = useState(
    item?.provider.defaultModel || models[0] || "",
  );
  const stylePresets = useStylePresets();
  const [scale, setScale] = useState<"2" | "4">("2");
  const [mode, setMode] = useState<"detail" | "faithful">("detail");
  const [preset, setPreset] = useState("");
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastError, setLastError] = useState<AdapterError | null>(null);
  const [confirmRetry, setConfirmRetry] = useState(false);
  const [recovering, setRecovering] = useState(false);

  const isUpscale = target.kind === "upscale";
  // preset 存提示词文本：历史记录里的 style 字段同样是文本，且自定义风格可重命名
  const stylePrompt = [preset, extra.trim()].filter(Boolean).join(", ");
  const canSubmit = !busy && model !== "" && (isUpscale || stylePrompt !== "");

  const submit = async (force = false) => {
    if (!canSubmit || defaultProviderId == null) return;
    // 上一次结果未确认：再点一次就会重新计费，必须先让用户确认
    if (lastError && isUnconfirmedError(lastError) && !force) {
      setConfirmRetry(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const out = await api.transformImage({
        providerId: defaultProviderId,
        model,
        imageB64: await ensureRasterDataUrl(target.dataUrl),
        scale: isUpscale ? Number(scale) : 1,
        mode,
        prompt: isUpscale ? "" : stylePrompt,
        parentId: target.historyId,
      });
      const label = isUpscale
        ? t("高清放大 {{scale}}x", { scale })
        : t("风格转换：{{style}}", {
            style:
              stylePresets.find((p) => p.prompt === preset)?.label ??
              t("自定义"),
          });
      await deliverEditResult(target, out, label);
      setLastError(null);
      close();
    } catch (e) {
      const parsed = parseAdapterError(String(e));
      setLastError(parsed);
      setError(
        t("{{title}}：{{message}}", {
          title: adapterErrorTitle(parsed),
          message: parsed.message,
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  const unconfirmed = lastError !== null && isUnconfirmedError(lastError);
  const requestId =
    lastError?.type === "unconfirmed" ? lastError.request_id : undefined;

  const recover = async () => {
    if (!requestId) return;
    setRecovering(true);
    try {
      const outcome = await api.recoverImageRequestByClient(requestId);
      const suffix =
        outcome.failed > 0 ? t("（{{n}} 张仍失败）", { n: outcome.failed }) : "";
      toast(
        t("已恢复 {{n}} 张到画廊", { n: outcome.recovered }) + suffix,
        outcome.failed > 0 ? "error" : "info",
      );
      setLastError(null);
      setError(null);
    } catch (e) {
      toast(t("恢复失败：{{error}}", { error: String(e) }), "error");
    } finally {
      setRecovering(false);
    }
  };

  return (
    <>
      <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={isUpscale ? t("高清放大") : t("风格转换")}
      description={
        isUpscale
          ? t("按倍数重新绘制，放大结果会保留原图作为父记录")
          : t("按风格描述重新绘制，构图与主体保持不变")
      }
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={close}>
            {t("取消")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={busy}
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {t("开始处理")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 pb-2">
        <div className="flex items-start gap-3">
          <SafeImg
            src={target.dataUrl}
            alt={t("待处理图片")}
            className="h-24 w-24 shrink-0 rounded-card border border-line object-cover"
          />
          <p className="min-w-0 flex-1 text-footnote text-tertiary">
            {target.prompt || t("（无提示词）")}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-caption text-tertiary">{t("模型")}</span>
          <Select
            label={t("模型")}
            value={model}
            onValueChange={setModel}
            placeholder={t("（未选择）")}
            disabled={models.length === 0}
            options={models.map((m) => ({ value: m, label: m }))}
          />
        </div>

        {isUpscale ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="text-caption text-tertiary">{t("倍数")}</span>
              <SegmentedControl
                label={t("放大倍数")}
                value={scale}
                onValueChange={(v) => setScale(v)}
                size="sm"
                options={[
                  { value: "2", label: "2x" },
                  { value: "4", label: "4x" },
                ]}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-caption text-tertiary">{t("模式")}</span>
              <SegmentedControl
                label={t("放大模式")}
                value={mode}
                onValueChange={(v) => setMode(v)}
                size="sm"
                options={[
                  { value: "detail", label: t("细节增强") },
                  { value: "faithful", label: t("忠实还原") },
                ]}
              />
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <span className="text-caption text-tertiary">{t("风格")}</span>
              <div className="flex flex-wrap gap-1.5">
                {stylePresets.map((p) => (
                  <Button
                    key={p.id}
                    size="sm"
                    variant={preset === p.prompt ? "secondary" : "ghost"}
                    aria-pressed={preset === p.prompt}
                    onClick={() =>
                      setPreset(preset === p.prompt ? "" : p.prompt)
                    }
                  >
                    {p.label}
                  </Button>
                ))}
              </div>
            </div>
            <Input
              label={t("补充描述（可选）")}
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              placeholder={t("例如：暖色调、柔和光线…")}
            />
          </>
        )}

        {error && (
          <div
            role="alert"
            className="flex flex-col gap-1.5 rounded-card border border-danger/25 bg-danger/10 px-3 py-2 text-footnote text-danger"
          >
            <span>{error}</span>
            {unconfirmed && (
              <span className="text-warning">
                {t("可能已计费，重试会再次扣费")}
              </span>
            )}
            {requestId && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(requestId)
                      .then(() => toast(t("已复制请求 ID")))
                      .catch(() => toast(t("复制失败"), "error"));
                  }}
                  className="break-all text-left transition-colors hover:text-primary"
                  title={t("复制请求 ID（对账用）")}
                >
                  {t("请求 ID：{{id}}", { id: requestId })}
                </button>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={recovering}
                  onClick={() => void recover()}
                >
                  {t("尝试恢复")}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
      </Dialog>

      <ConfirmDialog
        open={confirmRetry}
        onOpenChange={setConfirmRetry}
        title={t("确认重新生成？")}
        description={t(
          "这次请求可能已在服务商侧计费。重新生成会再次扣费，请先到服务商后台确认没有出图。",
        )}
        confirmLabel={t("仍然重新生成")}
        danger
        onConfirm={() => void submit(true)}
      />
    </>
  );
}
