import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/appStore";
import { useProviderStore } from "../stores/providerStore";
import {
  CanvasRegion,
  MAX_REGION_FEATHER,
  MAX_REGIONS_PER_NODE,
  useCanvasStore,
} from "../stores/canvasStore";
import {
  api,
  parseAdapterError,
  adapterErrorTitle,
  isUnconfirmedError,
  RegionProgressEvent,
} from "../lib/api";
import { toast } from "../lib/notify";
import { DUR, EASE } from "../lib/motion";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Input } from "./ui/Field";
import { Slider } from "./ui/Slider";
import { Badge } from "./ui/Badge";
import { ConfirmDialog } from "./ui/Dialog";
import { ToolbarGroup, ToolbarSeparator } from "./ui/Toolbar";
import { IconBrush, IconClose, IconEraser, IconPlus, IconTrash } from "./Icons";
import SafeImg from "./SafeImg";
import MaskCanvas, { MaskCanvasHandle } from "./MaskCanvas";

/// 每批上限与后端 MAX_REGION_BATCH 对齐：再多就该分批确认计费
const MAX_BATCH = 4;
const DEFAULT_FEATHER = 24;

let jobSeq = 0;
/// 批次 id 只在提交时生成一次；放在模块层避免渲染期调用 Date.now
function newRegionJobId(): string {
  jobSeq += 1;
  return `region-${Date.now()}-${jobSeq}`;
}

type RegionStatus = { state: "running" | "ok" | "error"; message?: string };

export default function RegionEditView() {
  const { t } = useTranslation();
  const target = useAppStore((s) => s.regionTarget);
  const closeRegionEdit = useAppStore((s) => s.closeRegionEdit);
  const canvasInline = useAppStore((s) => s.canvasInline);
  const defaultProviderId = useProviderStore((s) => s.defaultProviderId);
  const providers = useProviderStore((s) => s.providers);
  const node = useCanvasStore((s) => {
    if (!target) return null;
    return s.nodes.find((n) => n.id === target.nodeId) ?? null;
  });
  const addRegion = useCanvasStore((s) => s.addRegion);
  const updateRegion = useCanvasStore((s) => s.updateRegion);
  const removeRegion = useCanvasStore((s) => s.removeRegion);
  const appendLayer = useCanvasStore((s) => s.appendLayer);
  const markRegionApplied = useCanvasStore((s) => s.markRegionApplied);

  const containerRef = useRef<HTMLDivElement>(null);
  const maskRef = useRef<MaskCanvasHandle>(null);
  const requestedMasks = useRef<Set<string>>(new Set());
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [display, setDisplay] = useState({ w: 0, h: 0 });
  const [brushSize, setBrushSize] = useState(48);
  const [eraser, setEraser] = useState(false);
  const [smartReady, setSmartReady] = useState(false);
  const [pickMode, setPickMode] = useState(false);
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState("");
  const [maskThumbs, setMaskThumbs] = useState<Record<string, string>>({});
  const [savingMask, setSavingMask] = useState(false);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const [status, setStatus] = useState<Record<string, RegionStatus>>({});
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const reduce = useReducedMotion();

  const regions = useMemo(() => node?.regions ?? [], [node]);
  const maskPaths = useMemo(() => regions.map((r) => r.maskPath), [regions]);
  const pending = useMemo(
    () => regions.filter((r) => !r.appliedHistoryId),
    [regions],
  );
  const batch = pending.slice(0, MAX_BATCH);
  // 超过一批就分批：先把当前这批提交完，下一批才可再提交
  const tooMany = pending.length > MAX_BATCH;

  useEffect(() => {
    let alive = true;
    api
      .getSetting("smartMask")
      .then((v) => {
        if (!alive || v === "off") return undefined;
        return api
          .segmentModelStatus()
          .then((s) => {
            if (alive) setSmartReady(s.available);
          })
          .catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!target) return;
    const img = new Image();
    img.onload = () => setImage(img);
    img.src = target.dataUrl;
  }, [target]);

  useEffect(() => {
    if (!image) return;
    const fit = () => {
      const box = containerRef.current?.getBoundingClientRect();
      if (!box || box.width < 48 || box.height < 48) return;
      const scale = Math.min(
        (box.width - 32) / image.naturalWidth,
        (box.height - 32) / image.naturalHeight,
        1,
      );
      setDisplay({
        w: Math.round(image.naturalWidth * scale),
        h: Math.round(image.naturalHeight * scale),
      });
    };
    fit();
    const observer = new ResizeObserver(fit);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [image]);

  // 区域蒙版缩略图：只读一次，失败后允许重试
  useEffect(() => {
    let cancelled = false;
    for (const path of maskPaths) {
      if (requestedMasks.current.has(path)) continue;
      requestedMasks.current.add(path);
      void api
        .readMediaImage(path)
        .then((res) => {
          if (!cancelled) {
            setMaskThumbs((m) => ({ ...m, [path]: res.dataUrl }));
          }
        })
        .catch(() => {
          requestedMasks.current.delete(path);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [maskPaths]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRegionEdit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeRegionEdit]);

  if (!target) return null;

  const inline = canvasInline && target.host === "canvas";

  const loadMask = async (region: CanvasRegion) => {
    try {
      const dataUrl =
        maskThumbs[region.maskPath] ??
        (await api.readMediaImage(region.maskPath)).dataUrl;
      await maskRef.current?.applyMask(dataUrl, "alpha");
      setDraft(region.prompt);
    } catch (e) {
      toast(t("载入蒙版失败：{{error}}", { error: String(e) }), "error");
    }
  };

  const addCurrent = async () => {
    if (!target || !node) return;
    if (!draft.trim() || !maskRef.current?.hasStrokes()) {
      toast(t("请先涂抹区域并填写提示词"), "error");
      return;
    }
    const maskB64 = maskRef.current.toAlphaPng();
    if (!maskB64) return;
    setSavingMask(true);
    try {
      const { path } = await api.saveCanvasLayerAsset(maskB64);
      const id = addRegion(target.nodeId, {
        prompt: draft.trim(),
        maskPath: path,
        feather: DEFAULT_FEATHER,
      });
      if (id) {
        requestedMasks.current.add(path);
        setMaskThumbs((m) => ({ ...m, [path]: maskB64 }));
        maskRef.current?.clear();
        setDraft("");
      }
    } catch (e) {
      toast(t("添加区域失败：{{error}}", { error: String(e) }), "error");
    } finally {
      setSavingMask(false);
    }
  };

  const handlePick = async (
    x: number,
    y: number,
    mods: { shift: boolean; alt: boolean },
  ) => {
    if (!target || picking) return;
    setPicking(true);
    try {
      const out = await api.segmentAtPoint(
        target.dataUrl,
        Math.round(x),
        Math.round(y),
      );
      const mode = mods.shift ? "add" : mods.alt ? "subtract" : "replace";
      await maskRef.current?.applyMask(out.dataUrl, mode);
    } catch (e) {
      toast(parseAdapterError(String(e)).message, "error");
    } finally {
      setPicking(false);
    }
  };

  const submit = async () => {
    if (!target || !node || batch.length === 0 || busy) return;
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
    const masks: { region: CanvasRegion; maskB64: string }[] = [];
    try {
      for (const region of batch) {
        const maskB64 =
          maskThumbs[region.maskPath] ??
          (await api.readMediaImage(region.maskPath)).dataUrl;
        masks.push({ region, maskB64 });
      }
    } catch (e) {
      toast(t("载入蒙版失败：{{error}}", { error: String(e) }), "error");
      return;
    }

    const job = newRegionJobId();
    setJobId(job);
    setBusy(true);
    setError(null);
    setProgress({ done: 0, total: batch.length });
    setStatus(
      Object.fromEntries(
        batch.map((r) => [r.id, { state: "running" as const }]),
      ),
    );
    const unlisten = await listen<RegionProgressEvent>(
      "image:region-progress",
      (event) => {
        const p = event.payload;
        setProgress({ done: p.done, total: p.total });
        if (p.regionId) {
          const id = p.regionId;
          setStatus((s) => ({
            ...s,
            [id]: p.ok
              ? { state: "ok" }
              : { state: "error", message: s[id]?.message },
          }));
        }
      },
    );
    try {
      const out = await api.regionEditBatch({
        providerId: defaultProviderId,
        model,
        negativePrompt:
          useAppStore.getState().prefs.negativePrompt.trim() || null,
        baseHistoryId: target.baseHistoryId,
        baseB64: target.dataUrl,
        jobId: job,
        regions: masks.map(({ region, maskB64 }) => ({
          id: region.id,
          prompt: region.prompt,
          maskB64,
          feather: region.feather,
        })),
      });

      const next: Record<string, RegionStatus> = {};
      const failures: string[] = [];
      let layered = 0;
      for (const item of out.results) {
        const region = regions.find((r) => r.id === item.id);
        if (!item.ok || !item.historyId || !region) {
          const parsed = parseAdapterError(item.error ?? "");
          const message = item.error
            ? t("{{title}}：{{message}}", {
                title: adapterErrorTitle(parsed),
                message: parsed.message,
              })
            : "";
          next[item.id] = { state: "error", message };
          if (message) failures.push(message);
          continue;
        }
        const index = regions.findIndex((r) => r.id === item.id) + 1;
        const maskLayerId = appendLayer(target.nodeId, {
          kind: "mask",
          path: region.maskPath,
          name: t("蒙版 {{index}}", { index }),
          visible: false,
          opacity: 1,
          locked: false,
          regionId: item.id,
        });
        const imageLayerId = maskLayerId
          ? appendLayer(target.nodeId, {
              kind: "image",
              historyId: item.historyId,
              name: t("区域 {{index}}", { index }),
              visible: true,
              opacity: 1,
              locked: false,
              maskLayerId,
              regionId: item.id,
              prompt: region.prompt,
            })
          : null;
        if (imageLayerId) {
          markRegionApplied(
            target.nodeId,
            item.id,
            item.historyId,
            imageLayerId,
          );
          layered += 1;
          next[item.id] = { state: "ok" };
        } else {
          const message = t("每个节点最多 {{max}} 层，可合并后继续", {
            max: 24,
          });
          next[item.id] = { state: "error", message };
          failures.push(message);
        }
      }
      setStatus((s) => ({ ...s, ...next }));

      const okCount = out.results.filter((r) => r.ok).length;
      toast(
        t("已重绘 {{done}} / {{total}} 个区域", {
          done: okCount,
          total: out.results.length,
        }),
        okCount > 0 ? "info" : "error",
      );
      if (failures.length > 0) {
        setError(t("部分区域失败：{{error}}", { error: failures[0] }));
      }
      if (
        out.anySucceeded &&
        !out.cancelled &&
        failures.length === 0 &&
        layered === out.results.length &&
        pending.length <= MAX_BATCH
      ) {
        closeRegionEdit();
      }
    } catch (e) {
      const parsed = parseAdapterError(String(e));
      const unconfirmed = isUnconfirmedError(parsed);
      setStatus(
        Object.fromEntries(
          batch.map((r) => [
            r.id,
            { state: "error" as const, message: parsed.message },
          ]),
        ),
      );
      setError(
        [
          t("{{title}}：{{message}}", {
            title: adapterErrorTitle(parsed),
            message: parsed.message,
          }),
          unconfirmed ? t("结果可能已计费，请在请求记录中确认") : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
    } finally {
      unlisten();
      setBusy(false);
      setJobId(null);
    }
  };

  const cancel = () => {
    if (jobId) void api.cancelGeneration(jobId).catch(() => undefined);
  };

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
              {t("分区重绘")}
            </h1>
            <p className="truncate text-footnote text-tertiary">
              {t("涂抹多个区域，逐区重绘后本地羽化合成")}
            </p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {busy ? (
              <Button variant="ghost" size="sm" onClick={cancel}>
                {t("取消分区重绘")}
              </Button>
            ) : null}
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              disabled={tooMany || batch.length === 0}
              onClick={() => setConfirmOpen(true)}
            >
              {tooMany
                ? t("一批最多 {{max}} 个区域", { max: MAX_BATCH })
                : batch.length > 0
                  ? t("提交 {{count}} 个区域", { count: batch.length })
                  : t("没有待重绘的区域")}
            </Button>
            <IconButton
              label={t("关闭分区重绘")}
              icon={<IconClose size={16} />}
              onClick={closeRegionEdit}
            />
          </div>
        </div>

        <div
          role="toolbar"
          aria-label={t("蒙版工具")}
          className="flex flex-wrap items-center gap-2 px-6 pb-2.5"
        >
          <ToolbarGroup>
            <span className="pl-1 text-tertiary">
              <IconBrush size={16} />
            </span>
            <div className="w-28 shrink-0">
              <Slider
                value={brushSize}
                onValueChange={setBrushSize}
                min={8}
                max={200}
                label={t("画笔大小")}
              />
            </div>
            <span className="w-8 text-right text-footnote tabular-nums text-tertiary">
              {brushSize}
            </span>
          </ToolbarGroup>

          <ToolbarSeparator />

          <ToolbarGroup>
            <IconButton
              label={eraser ? t("关闭橡皮擦") : t("橡皮擦")}
              icon={<IconEraser size={16} />}
              variant={eraser ? "secondary" : "ghost"}
              aria-pressed={eraser}
              onClick={() => {
                setPickMode(false);
                setEraser((v) => !v);
              }}
            />
            {smartReady && (
              <Button
                size="sm"
                variant={pickMode ? "secondary" : "ghost"}
                aria-pressed={pickMode}
                loading={picking}
                title={t("AI 识别物体：点击选中，Shift 加选，Alt 减选")}
                onClick={() => {
                  setEraser(false);
                  setPickMode((v) => !v);
                }}
              >
                {t("点选物体")}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => maskRef.current?.fillAll()}
            >
              {t("全选")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => maskRef.current?.clear()}
            >
              {t("清除蒙版")}
            </Button>
          </ToolbarGroup>

          {progress && busy && (
            <span className="ml-auto text-footnote tabular-nums text-tertiary">
              {t("已重绘 {{done}} / {{total}} 个区域", {
                done: progress.done,
                total: progress.total,
              })}
            </span>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div
          ref={containerRef}
          className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden p-4"
        >
          {image ? (
            <div
              className="relative overflow-hidden rounded-card shadow-pop"
              style={{ width: display.w, height: display.h }}
            >
              <SafeImg
                src={target.dataUrl}
                alt={t("当前合成")}
                className="absolute inset-0 h-full w-full"
              />
              <MaskCanvas
                ref={maskRef}
                image={image}
                brushSize={brushSize}
                eraser={eraser}
                onPick={
                  pickMode
                    ? (x, y, mods) => {
                        void handlePick(x, y, mods);
                      }
                    : undefined
                }
                className={`absolute inset-0 h-full w-full opacity-60 ${
                  pickMode ? "cursor-crosshair" : ""
                }`}
              />
            </div>
          ) : (
            <span className="text-body text-tertiary">{t("加载中…")}</span>
          )}
        </div>

        <aside
          aria-label={t("区域列表")}
          className="flex w-72 min-w-0 shrink-0 flex-col border-l border-line bg-base"
        >
          <div className="shrink-0 border-b border-line p-3">
            <Input
              label={t("区域提示词")}
              value={draft}
              maxLength={2000}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t("该区域画什么")}
              compact
            />
            <Button
              className="mt-2 w-full"
              size="sm"
              variant="secondary"
              icon={<IconPlus size={14} />}
              loading={savingMask}
              disabled={
                busy || regions.length >= MAX_REGIONS_PER_NODE || !draft.trim()
              }
              onClick={() => void addCurrent()}
            >
              {t("添加区域")}
            </Button>
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
            {regions.length === 0 && (
              <p className="px-2 py-6 text-center text-footnote text-tertiary">
                {t("请先涂抹区域并填写提示词")}
              </p>
            )}
            {regions.map((region, index) => {
              const state = status[region.id];
              const applied = region.appliedHistoryId != null;
              const tone =
                state?.state === "error"
                  ? "danger"
                  : state?.state === "ok" || applied
                    ? "success"
                    : state?.state === "running"
                      ? "accent"
                      : "neutral";
              const label =
                state?.state === "error"
                  ? t("失败")
                  : state?.state === "ok" || applied
                    ? t("已完成")
                    : state?.state === "running"
                      ? t("重绘中…")
                      : t("待提交");
              return (
                <div
                  key={region.id}
                  className="rounded-card border border-line p-2"
                >
                  <div className="flex items-start gap-2">
                    <img
                      src={maskThumbs[region.maskPath] ?? undefined}
                      alt=""
                      className="h-10 w-10 shrink-0 rounded-btn bg-sunken object-cover"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-footnote text-secondary">
                          {t("区域 {{index}}", { index: index + 1 })}
                        </span>
                        <Badge tone={tone}>{label}</Badge>
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <span className="text-caption text-tertiary">
                          {t("羽化")}
                        </span>
                        <Slider
                          value={region.feather}
                          min={0}
                          max={MAX_REGION_FEATHER}
                          step={4}
                          label={`${t("羽化")} ${index + 1}`}
                          onValueChange={(v) => {
                            if (node) {
                              updateRegion(node.id, region.id, { feather: v });
                            }
                          }}
                          className="w-16"
                        />
                        <span className="w-6 text-right text-caption tabular-nums text-tertiary">
                          {region.feather}
                        </span>
                      </div>
                    </div>
                    <IconButton
                      label={t("载入蒙版")}
                      size="sm"
                      icon={<IconBrush size={13} />}
                      disabled={busy}
                      onClick={() => void loadMask(region)}
                    />
                    <IconButton
                      label={t("删除")}
                      size="sm"
                      icon={<IconTrash size={13} />}
                      disabled={busy}
                      onClick={() => {
                        if (node) removeRegion(node.id, region.id);
                      }}
                    />
                  </div>
                  <Input
                    value={region.prompt}
                    maxLength={2000}
                    aria-label={t("区域提示词")}
                    compact
                    className="mt-2"
                    onChange={(e) => {
                      if (node) {
                        updateRegion(node.id, region.id, {
                          prompt: e.target.value,
                        });
                      }
                    }}
                  />
                  {state?.message && (
                    <p className="mt-1 break-words text-caption text-danger">
                      {state.message}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </aside>
      </div>

      {error && (
        <div
          role="alert"
          className="shrink-0 border-t border-danger/25 bg-danger/10 px-6 py-2 text-footnote text-danger"
        >
          {error}
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("提交 {{count}} 个区域", { count: batch.length })}
        description={`${t("将调用 {{count}} 次服务商接口，按区域分别计费", {
          count: batch.length,
        })} ${t("每个区域都会单独调用一次，费用 ×{{count}}", {
          count: batch.length,
        })}`}
        confirmLabel={t("开始重绘")}
        onConfirm={() => {
          setConfirmOpen(false);
          void submit();
        }}
      />
    </motion.div>
  );
}
