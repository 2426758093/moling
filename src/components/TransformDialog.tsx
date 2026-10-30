import { useState } from "react";
import { TransformTarget, useAppStore } from "../stores/appStore";
import { useChatStore } from "../stores/chatStore";
import { useProviderStore } from "../stores/providerStore";
import { api, adapterErrorTitle, parseAdapterError } from "../lib/api";
import { ensureRasterDataUrl } from "../lib/file";
import { toast } from "../lib/notify";
import { Dialog } from "./ui/Dialog";
import { Button } from "./ui/Button";
import { Input } from "./ui/Field";
import { SegmentedControl } from "./ui/SegmentedControl";
import { Select } from "./ui/Select";
import SafeImg from "./SafeImg";

const STYLE_PRESETS = [
  {
    id: "watercolor",
    label: "水彩",
    prompt: "watercolor painting, soft washes",
  },
  { id: "oil", label: "油画", prompt: "oil painting, visible brush strokes" },
  { id: "anime", label: "动漫", prompt: "anime illustration, clean line art" },
  {
    id: "cyberpunk",
    label: "赛博朋克",
    prompt: "cyberpunk neon lighting, high contrast",
  },
  {
    id: "film",
    label: "胶片",
    prompt: "analog film photography, subtle grain",
  },
  {
    id: "render3d",
    label: "3D 渲染",
    prompt: "3D render, soft studio lighting",
  },
] as const;

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
  const [scale, setScale] = useState<"2" | "4">("2");
  const [mode, setMode] = useState<"detail" | "faithful">("detail");
  const [preset, setPreset] = useState("");
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isUpscale = target.kind === "upscale";
  const stylePrompt = [
    STYLE_PRESETS.find((p) => p.id === preset)?.prompt ?? "",
    extra.trim(),
  ]
    .filter(Boolean)
    .join(", ");
  const canSubmit = !busy && model !== "" && (isUpscale || stylePrompt !== "");

  const submit = async () => {
    if (!canSubmit || defaultProviderId == null) return;
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
        ? `高清放大 ${scale}x`
        : `风格转换：${STYLE_PRESETS.find((p) => p.id === preset)?.label ?? "自定义"}`;
      if (useChatStore.getState().activeId === null) {
        toast("已保存到画廊（当前没有打开的会话）");
      } else {
        await useChatStore.getState().appendImageMessage(
          {
            historyId: out.historyId,
            dataUrl: out.dataUrl,
            path: out.filePath,
            derivedFrom: target.historyId,
          },
          label,
        );
        toast("已生成，结果已放入当前会话");
      }
      close();
    } catch (e) {
      const parsed = parseAdapterError(String(e));
      setError(`${adapterErrorTitle(parsed)}：${parsed.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={isUpscale ? "高清放大" : "风格转换"}
      description={
        isUpscale
          ? "按倍数重新绘制，放大结果会保留原图作为父记录"
          : "按风格描述重新绘制，构图与主体保持不变"
      }
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={close}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={busy}
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            开始处理
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 pb-2">
        <div className="flex items-start gap-3">
          <SafeImg
            src={target.dataUrl}
            alt="待处理图片"
            className="h-24 w-24 shrink-0 rounded-card border border-line object-cover"
          />
          <p className="min-w-0 flex-1 text-footnote text-tertiary">
            {target.prompt || "（无提示词）"}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-caption text-tertiary">模型</span>
          <Select
            label="模型"
            value={model}
            onValueChange={setModel}
            placeholder="（未选择）"
            disabled={models.length === 0}
            options={models.map((m) => ({ value: m, label: m }))}
          />
        </div>

        {isUpscale ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="text-caption text-tertiary">倍数</span>
              <SegmentedControl
                label="放大倍数"
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
              <span className="text-caption text-tertiary">模式</span>
              <SegmentedControl
                label="放大模式"
                value={mode}
                onValueChange={(v) => setMode(v)}
                size="sm"
                options={[
                  { value: "detail", label: "细节增强" },
                  { value: "faithful", label: "忠实还原" },
                ]}
              />
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <span className="text-caption text-tertiary">风格</span>
              <div className="flex flex-wrap gap-1.5">
                {STYLE_PRESETS.map((p) => (
                  <Button
                    key={p.id}
                    size="sm"
                    variant={preset === p.id ? "secondary" : "ghost"}
                    aria-pressed={preset === p.id}
                    onClick={() => setPreset(preset === p.id ? "" : p.id)}
                  >
                    {p.label}
                  </Button>
                ))}
              </div>
            </div>
            <Input
              label="补充描述（可选）"
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              placeholder="例如：暖色调、柔和光线…"
            />
          </>
        )}

        {error && (
          <div
            role="alert"
            className="rounded-card border border-danger/25 bg-danger/10 px-3 py-2 text-footnote text-danger"
          >
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}
