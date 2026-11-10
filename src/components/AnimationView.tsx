import { useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/appStore";
import { useProviderStore } from "../stores/providerStore";
import { api, AnimationInfo, StickerResult } from "../lib/api";
import { exportAnimationZip, saveDataUrl } from "../lib/save";
import { emitHistoryChanged } from "../lib/historyEvents";
import { toast } from "../lib/notify";
import { DUR, EASE } from "../lib/motion";
import {
  GIF_FRAME_MAX,
  GIF_FRAME_MS_MAX,
  GIF_FRAME_MS_MIN,
} from "../lib/presets";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Input } from "./ui/Field";
import { SegmentedControl } from "./ui/SegmentedControl";
import { Switch } from "./ui/Switch";
import { IconChevron, IconClose, IconCopy, IconTrash } from "./Icons";
import SafeImg from "./SafeImg";

/// 时间轴条目：source 是源 GIF 的帧序号，重排 / 复制 / 删帧只动这个数组，
/// 保存时整段交给 Rust 重编码（不把像素往 IPC 里搬）。
interface FrameEntry {
  key: string;
  source: number;
  delayMs: number;
  thumbUrl: string;
}

const SPEED_OPTIONS = [
  { value: "0.5", label: "0.5×" },
  { value: "1", label: "1×" },
  { value: "1.5", label: "1.5×" },
  { value: "2", label: "2×" },
] as const;

const OPTIMIZE_OPTIONS = [
  { value: "500", label: "500 KB" },
  { value: "1024", label: "1 MB" },
  { value: "custom", label: "自定义" },
] as const;

const STICKER_OPTIONS = [
  { value: "wechat", label: "微信 240×240" },
  { value: "universal-320", label: "通用 320×320" },
  { value: "universal-512", label: "通用 512×512" },
] as const;

type SpeedValue = (typeof SPEED_OPTIONS)[number]["value"];
type OptimizeValue = (typeof OPTIMIZE_OPTIONS)[number]["value"];
type StickerValue = (typeof STICKER_OPTIONS)[number]["value"];

/// 倍速只改帧时长：20–2000ms 且按 10ms 取整，与后端口径一致
function effectiveDelay(baseMs: number, speed: string): number {
  const factor = Number(speed) || 1;
  const ms = Math.round(baseMs / factor / 10) * 10;
  return Math.max(GIF_FRAME_MS_MIN, Math.min(GIF_FRAME_MS_MAX, ms));
}

function kb(bytes: number): string {
  return String(Math.max(1, Math.round(bytes / 1024)));
}

export default function AnimationView() {
  const { t } = useTranslation();
  const target = useAppStore((s) => s.animationTarget);
  const closeAnimation = useAppStore((s) => s.closeAnimation);
  const canvasInline = useAppStore((s) => s.canvasInline);
  const defaultProviderId = useProviderStore((s) => s.defaultProviderId);
  const providers = useProviderStore((s) => s.providers);
  const reduce = useReducedMotion();

  const targetId = target?.historyId ?? null;
  const [id, setId] = useState<number | null>(targetId);
  const [seenTarget, setSeenTarget] = useState<number | null>(targetId);
  const [info, setInfo] = useState<AnimationInfo | null>(null);
  const [entries, setEntries] = useState<FrameEntry[]>([]);
  const [original, setOriginal] = useState<FrameEntry[]>([]);
  const [baseline, setBaseline] = useState("");
  const [loopPlay, setLoopPlay] = useState(true);
  const [loopBaseline, setLoopBaseline] = useState(true);
  const [speed, setSpeed] = useState<SpeedValue>("1");
  const [current, setCurrent] = useState(0);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [optimizeTarget, setOptimizeTarget] = useState<OptimizeValue>("500");
  const [customKb, setCustomKb] = useState("500");
  const [stickerPreset, setStickerPreset] = useState<StickerValue>("wechat");
  const [sticker, setSticker] = useState<StickerResult | null>(null);
  const [repairOpen, setRepairOpen] = useState(false);
  const [repairPrompt, setRepairPrompt] = useState("");

  // 换目标时在渲染期间重置，替代「effect 内同步 setState」
  if (seenTarget !== targetId) {
    setSeenTarget(targetId);
    setId(targetId);
    setCurrent(0);
    setPlaying(false);
  }

  useEffect(() => {
    if (id == null) return;
    let cancelled = false;
    void Promise.all([
      api.getAnimationInfo(id),
      api.getAnimationFrames(id, 160),
    ])
      .then(([meta, frames]) => {
        if (cancelled) return;
        const list = frames.map((frame, i) => ({
          key: `${frame.index}-${i}`,
          source: frame.index,
          delayMs: frame.delayMs,
          thumbUrl: frame.dataUrl,
        }));
        setInfo(meta);
        setEntries(list);
        setOriginal(list.map((entry) => ({ ...entry })));
        setBaseline(
          JSON.stringify(list.map((entry) => [entry.source, entry.delayMs])),
        );
        setCurrent(0);
        setPlaying(false);
        setLoopPlay(!meta.playOnce);
        setLoopBaseline(!meta.playOnce);
      })
      .catch((e) => {
        if (!cancelled)
          setError(t("读取动图失败：{{error}}", { error: String(e) }));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, t]);

  const currentEntry = entries[current];

  // 大图按需取全尺寸帧；未到货时先显示 160px 时间轴缩略图
  const previewKey =
    id != null && currentEntry ? `${id}-${currentEntry.source}` : null;
  const previewUrl = previewKey
    ? (previewUrls[previewKey] ?? currentEntry?.thumbUrl ?? null)
    : null;

  useEffect(() => {
    if (id == null || !currentEntry || !previewKey) return;
    if (previewUrls[previewKey]) return;
    let cancelled = false;
    void api
      .getAnimationFrame(id, currentEntry.source)
      .then((frame) => {
        if (!cancelled)
          setPreviewUrls((map) => ({ ...map, [previewKey]: frame.dataUrl }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id, currentEntry, previewKey, previewUrls]);

  const signature = useMemo(
    () => JSON.stringify(entries.map((entry) => [entry.source, entry.delayMs])),
    [entries],
  );
  const dirty = signature !== baseline || loopPlay !== loopBaseline;

  useEffect(() => {
    if (!playing || !currentEntry || entries.length < 2) return;
    const timer = window.setTimeout(
      () => {
        if (current + 1 < entries.length) setCurrent(current + 1);
        else if (loopPlay) setCurrent(0);
        else setPlaying(false);
      },
      effectiveDelay(currentEntry.delayMs, speed),
    );
    return () => window.clearTimeout(timer);
  }, [playing, current, currentEntry, entries.length, speed, loopPlay]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, select, [contenteditable='true']")) {
        if (e.key === "Escape") closeAnimation();
        return;
      }
      if (e.key === "Escape") {
        closeAnimation();
      } else if (e.key === " ") {
        e.preventDefault();
        setPlaying((v) => !v);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setCurrent((i) => Math.max(0, i - 1));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setCurrent((i) => Math.min(entries.length - 1, i + 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeAnimation, entries.length]);

  if (!target) return null;

  const inline = canvasInline && target.host === "canvas";

  const updateEntry = (index: number, patch: Partial<FrameEntry>) => {
    setEntries((list) =>
      list.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
    );
  };

  const move = (index: number, delta: number) => {
    const next = index + delta;
    if (next < 0 || next >= entries.length) return;
    setEntries((list) => {
      const copy = [...list];
      [copy[index], copy[next]] = [copy[next], copy[index]];
      return copy;
    });
    setCurrent(next);
  };

  const duplicate = (index: number) => {
    if (entries.length >= GIF_FRAME_MAX) {
      toast(t("最多 {{n}} 帧", { n: GIF_FRAME_MAX }), "error");
      return;
    }
    setEntries((list) => {
      const copy = [...list];
      copy.splice(index + 1, 0, {
        ...list[index],
        key: `${list[index].source}-dup-${Date.now()}`,
      });
      return copy;
    });
    setCurrent(index + 1);
  };

  const remove = (index: number) => {
    if (entries.length <= 2) {
      toast(t("至少保留 2 帧"), "error");
      return;
    }
    setEntries((list) => list.filter((_, i) => i !== index));
    setCurrent((i) => Math.max(0, Math.min(i, entries.length - 2)));
  };

  const resetTimeline = () => {
    setEntries(original.map((entry) => ({ ...entry })));
    setLoopPlay(loopBaseline);
    setSpeed("1");
    setCurrent(0);
  };

  const setDuration = (index: number, raw: string) => {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    updateEntry(index, {
      delayMs: Math.max(GIF_FRAME_MS_MIN, Math.min(GIF_FRAME_MS_MAX, value)),
    });
  };

  const applyDurationToAll = () => {
    if (!currentEntry) return;
    setEntries((list) =>
      list.map((entry) => ({ ...entry, delayMs: currentEntry.delayMs })),
    );
  };

  const adopt = (result: { historyId: number }) => {
    setLoading(true);
    setError(null);
    setPlaying(false);
    setRepairOpen(false);
    setSticker(null);
    setSpeed("1");
    setPreviewUrls({});
    setId(result.historyId);
    emitHistoryChanged();
  };

  const save = async () => {
    if (id == null || !dirty) return;
    setBusy("save");
    setError(null);
    try {
      const order = entries.map((entry) => entry.source);
      const delays = entries.map((entry) =>
        effectiveDelay(entry.delayMs, speed),
      );
      const out = await api.composeAnimation(id, order, delays, loopPlay);
      adopt(out);
      toast(t("已保存为新动图 #{{id}}", { id: out.historyId }), "info");
    } catch (e) {
      setError(t("动图操作失败：{{error}}", { error: String(e) }));
    } finally {
      setBusy(null);
    }
  };

  /// 优化 / 导出 / 表情包都基于已落盘版本：时间轴有改动时先让用户保存
  const requireSaved = (): boolean => {
    if (dirty) {
      toast(t("请先保存时间轴调整"), "error");
      return false;
    }
    return true;
  };

  const optimize = async () => {
    if (id == null || !requireSaved()) return;
    const targetBytes =
      (optimizeTarget === "custom"
        ? Number(customKb)
        : Number(optimizeTarget)) * 1024;
    if (!Number.isFinite(targetBytes) || targetBytes < 10 * 1024) {
      toast(t("目标体积过小"), "error");
      return;
    }
    setBusy("optimize");
    setError(null);
    try {
      const out = await api.optimizeAnimation(id, Math.round(targetBytes));
      adopt(out);
      toast(
        out.reached
          ? t("已压缩到 {{kb}} KB", { kb: kb(out.animation.bytes) })
          : t("已尽力压缩到 {{kb}} KB，仍未达到目标", {
              kb: kb(out.animation.bytes),
            }),
        out.reached ? "info" : "error",
      );
    } catch (e) {
      setError(t("动图操作失败：{{error}}", { error: String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const exportZip = async (mode: "gif" | "png-sequence") => {
    if (id == null || !requireSaved()) return;
    setBusy(mode);
    setError(null);
    try {
      const name =
        mode === "gif" ? `moling_anim_${id}.zip` : `moling_frames_${id}.zip`;
      const out = await exportAnimationZip(id, mode, name);
      if (out) toast(t("已导出到 {{path}}", { path: out.path }), "info");
    } catch (e) {
      setError(t("动图操作失败：{{error}}", { error: String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const makeSticker = async () => {
    if (id == null || !requireSaved()) return;
    setBusy("sticker");
    setError(null);
    try {
      const out = await api.exportSticker(id, stickerPreset);
      setSticker(out);
      toast(
        t("表情包已生成：{{w}}×{{h}} · {{kb}} KB", {
          w: out.animation.width,
          h: out.animation.height,
          kb: kb(out.animation.bytes),
        }),
        out.withinLimit ? "info" : "error",
      );
    } catch (e) {
      setError(t("动图操作失败：{{error}}", { error: String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const saveSticker = async () => {
    if (!sticker) return;
    try {
      const ok = await saveDataUrl(
        sticker.dataUrl,
        `moling_sticker_${sticker.historyId}.gif`,
      );
      if (ok) toast(t("已保存表情包"), "info");
    } catch (e) {
      toast(t("保存失败：{{error}}", { error: String(e) }), "error");
    }
  };

  const saveStickerCover = async () => {
    if (!sticker) return;
    try {
      const ok = await saveDataUrl(
        sticker.coverDataUrl,
        `moling_sticker_${sticker.historyId}_cover.png`,
      );
      if (ok) toast(t("已保存封面"), "info");
    } catch (e) {
      toast(t("保存失败：{{error}}", { error: String(e) }), "error");
    }
  };

  const repairFrame = async () => {
    if (id == null || !currentEntry || !requireSaved()) return;
    if (!repairPrompt.trim()) {
      toast(t("请输入修复描述"), "error");
      return;
    }
    if (defaultProviderId == null) {
      toast(t("请先在「设置」中配置服务商"), "error");
      return;
    }
    const model = providers.find((p) => p.provider.id === defaultProviderId)
      ?.provider.defaultModel;
    if (!model) {
      toast(t("请先在「设置」中选择默认模型"), "error");
      return;
    }
    setBusy("repair");
    setError(null);
    try {
      const frame = await api.getAnimationFrame(id, currentEntry.source);
      const out = await api.editImage({
        providerId: defaultProviderId,
        prompt: repairPrompt.trim(),
        model,
        imageB64: frame.dataUrl,
        maskB64: null,
        width: frame.width,
        height: frame.height,
        op: "anim-frame",
        parentId: id,
        // 单帧结果要回填进 GIF 重编码，必须是可解码的位图
        outputFormat: "png",
      });
      const replaced = await api.replaceAnimationFrame(
        id,
        currentEntry.source,
        out.dataUrl,
      );
      adopt(replaced);
      setRepairOpen(false);
      setRepairPrompt("");
      toast(
        t("第 {{n}} 帧已修复，已生成新动图 #{{id}}", {
          n: currentEntry.source + 1,
          id: replaced.historyId,
        }),
        "info",
      );
    } catch (e) {
      setError(t("单帧修复失败：{{error}}", { error: String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const totalMs =
    entries.reduce(
      (sum, entry) => sum + effectiveDelay(entry.delayMs, speed),
      0,
    ) ||
    info?.totalMs ||
    0;

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduce ? 0 : DUR.base, ease: EASE.ios }}
      className={
        inline
          ? "flex h-full min-h-0 w-full flex-col bg-base"
          : "fixed inset-x-0 bottom-0 top-12 z-30 flex flex-col bg-base"
      }
    >
      <header className="relative z-10 shrink-0 glass">
        <div className="flex min-h-12 items-center gap-3 px-6 py-2">
          <div className="flex min-w-0 flex-col">
            <h1 className="truncate text-title3 text-primary">
              {t("动图编辑器")}
            </h1>
            <p className="truncate text-footnote tabular-nums text-tertiary">
              {info
                ? t(
                    "{{frames}} 帧 · {{w}}×{{h}} · {{seconds}} 秒 · {{kb}} KB",
                    {
                      frames: entries.length,
                      w: info.width,
                      h: info.height,
                      seconds: (totalMs / 1000).toFixed(1),
                      kb: kb(info.bytes),
                    },
                  )
                : t("加载中…")}
            </p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={busy === "save"}
              disabled={!dirty || busy != null}
              onClick={() => void save()}
            >
              {t("保存为新动图")}
            </Button>
            <IconButton
              label={t("关闭动图编辑器")}
              icon={<IconClose size={16} />}
              onClick={closeAnimation}
            />
          </div>
        </div>

        <div
          role="toolbar"
          aria-label={t("动图工具")}
          className="flex flex-wrap items-center gap-3 px-6 pb-2.5"
        >
          <Button
            size="sm"
            variant="secondary"
            disabled={entries.length < 2}
            onClick={() => setPlaying((v) => !v)}
          >
            {playing ? t("暂停") : t("播放")}
          </Button>
          <label className="flex items-center gap-2 text-footnote text-secondary">
            {t("循环播放")}
            <Switch
              checked={loopPlay}
              onCheckedChange={setLoopPlay}
              label={t("循环播放")}
            />
          </label>
          <span className="text-footnote text-tertiary">{t("倍速")}</span>
          <SegmentedControl
            value={speed}
            onValueChange={setSpeed}
            options={SPEED_OPTIONS.map((option) => ({ ...option }))}
            label={t("倍速")}
            size="sm"
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={!dirty}
            onClick={resetTimeline}
          >
            {t("重置时间轴")}
          </Button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-6">
        {loading ? (
          <span className="text-body text-tertiary">{t("加载中…")}</span>
        ) : entries.length === 0 ? (
          <span className="text-body text-tertiary">{t("没有可用的帧")}</span>
        ) : (
          <div className="relative flex h-full min-h-0 w-full flex-col items-center gap-3">
            <SafeImg
              src={previewUrl ?? currentEntry?.thumbUrl ?? ""}
              alt={t("动图预览")}
              className="min-h-0 max-h-full max-w-full rounded-card border border-line object-contain shadow-pop"
            />
            {repairOpen && (
              <div className="w-full max-w-xl shrink-0 rounded-card border border-line bg-elevated p-3">
                <p className="mb-2 text-footnote text-tertiary">
                  {t(
                    "单帧修复会整帧重绘（GIF 无蒙版）；基于已保存版本，未保存的时间轴调整将丢失",
                  )}
                </p>
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <Input
                      value={repairPrompt}
                      onChange={(e) => setRepairPrompt(e.target.value)}
                      placeholder={t("描述这一帧要改的内容…")}
                      aria-label={t("单帧修复描述")}
                      compact
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="primary"
                    loading={busy === "repair"}
                    disabled={busy != null}
                    onClick={() => void repairFrame()}
                  >
                    {t("修复当前帧")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setRepairOpen(false)}
                  >
                    {t("关闭单帧修复")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-line bg-elevated/60 px-4 py-3">
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <span className="text-footnote text-tertiary">{t("帧时长")}</span>
          <div className="w-24">
            <Input
              type="number"
              min={GIF_FRAME_MS_MIN}
              max={GIF_FRAME_MS_MAX}
              step={10}
              value={currentEntry?.delayMs ?? GIF_FRAME_MS_MIN}
              onChange={(e) => setDuration(current, e.target.value)}
              aria-label={t("帧时长")}
              suffix={t("毫秒")}
              compact
            />
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={!currentEntry}
            onClick={applyDurationToAll}
          >
            {t("应用到全部")}
          </Button>
          <span className="text-footnote tabular-nums text-tertiary">
            {t("实际 {{ms}} 毫秒", {
              ms: currentEntry
                ? effectiveDelay(currentEntry.delayMs, speed)
                : 0,
            })}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={!currentEntry}
              onClick={() => setRepairOpen((v) => !v)}
            >
              {t("单帧修复")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              loading={busy === "gif"}
              disabled={busy != null}
              onClick={() => void exportZip("gif")}
            >
              {t("导出 GIF 包")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              loading={busy === "png-sequence"}
              disabled={busy != null}
              onClick={() => void exportZip("png-sequence")}
            >
              {t("导出 PNG 序列")}
            </Button>
          </div>
        </div>

        <div
          role="listbox"
          aria-label={t("时间轴")}
          className="flex gap-2 overflow-x-auto pb-1"
        >
          {entries.map((entry, index) => (
            <div
              key={entry.key}
              role="option"
              aria-selected={index === current}
              aria-label={t("第 {{n}} 帧", { n: index + 1 })}
              tabIndex={0}
              onClick={() => setCurrent(index)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setCurrent(index);
                }
              }}
              className={`shrink-0 rounded-chip p-1 outline-none ring-2 transition-shadow ${
                index === current
                  ? "ring-accent"
                  : "ring-transparent hover:ring-line-strong"
              }`}
            >
              <div className="relative h-16 w-24 overflow-hidden rounded-chip bg-sunken">
                <SafeImg
                  src={entry.thumbUrl}
                  alt={t("第 {{n}} 帧", { n: index + 1 })}
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
                <span className="absolute left-1 top-1 rounded-chip bg-black/55 px-1 text-caption tabular-nums text-white">
                  {index + 1}
                </span>
                <span className="absolute bottom-1 right-1 rounded-chip bg-black/55 px-1 text-caption tabular-nums text-white">
                  {effectiveDelay(entry.delayMs, speed)}ms
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <IconButton
                  label={t("左移")}
                  icon={<IconChevron size={13} direction="left" />}
                  size="sm"
                  disabled={index === 0}
                  onClick={(e) => {
                    e.stopPropagation();
                    move(index, -1);
                  }}
                />
                <IconButton
                  label={t("右移")}
                  icon={<IconChevron size={13} />}
                  size="sm"
                  disabled={index === entries.length - 1}
                  onClick={(e) => {
                    e.stopPropagation();
                    move(index, 1);
                  }}
                />
                <IconButton
                  label={t("复制帧")}
                  icon={<IconCopy size={13} />}
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    duplicate(index);
                  }}
                />
                <IconButton
                  label={t("删除帧")}
                  icon={<IconTrash size={13} />}
                  size="sm"
                  disabled={entries.length <= 2}
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(index);
                  }}
                />
              </div>
            </div>
          ))}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-footnote text-tertiary">{t("压缩体积")}</span>
          <SegmentedControl
            value={optimizeTarget}
            onValueChange={setOptimizeTarget}
            options={OPTIMIZE_OPTIONS.map((option) => ({
              value: option.value,
              label: option.value === "custom" ? t("自定义") : option.label,
            }))}
            label={t("压缩体积")}
            size="sm"
          />
          {optimizeTarget === "custom" && (
            <div className="w-24">
              <Input
                type="number"
                min={10}
                max={10240}
                value={customKb}
                onChange={(e) => setCustomKb(e.target.value)}
                aria-label={t("自定义目标（KB）")}
                suffix="KB"
                compact
              />
            </div>
          )}
          <Button
            size="sm"
            variant="ghost"
            loading={busy === "optimize"}
            disabled={busy != null}
            onClick={() => void optimize()}
          >
            {t("开始压缩")}
          </Button>

          <span className="ml-2 text-footnote text-tertiary">
            {t("表情包")}
          </span>
          <SegmentedControl
            value={stickerPreset}
            onValueChange={setStickerPreset}
            options={STICKER_OPTIONS.map((option) => ({
              value: option.value,
              label: t(option.label),
            }))}
            label={t("表情包")}
            size="sm"
          />
          <Button
            size="sm"
            variant="ghost"
            loading={busy === "sticker"}
            disabled={busy != null}
            onClick={() => void makeSticker()}
          >
            {t("生成表情包")}
          </Button>
          {sticker && (
            <>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void saveSticker()}
              >
                {t("保存表情包")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void saveStickerCover()}
              >
                {t("保存封面")}
              </Button>
              <span
                className={`text-footnote ${
                  sticker.withinLimit ? "text-tertiary" : "text-warning"
                }`}
              >
                {sticker.withinLimit
                  ? t("{{kb}} KB / 上限 {{max}} KB", {
                      kb: kb(sticker.animation.bytes),
                      max: kb(sticker.maxBytes),
                    })
                  : t("超出 {{max}} KB 上限，请降帧或继续压缩", {
                      max: kb(sticker.maxBytes),
                    })}
              </span>
            </>
          )}
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="shrink-0 border-t border-danger/25 bg-danger/10 px-6 py-2 text-footnote text-danger"
        >
          {error}
        </div>
      )}
    </motion.div>
  );
}
