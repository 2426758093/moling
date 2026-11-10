import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/appStore";
import { useProviderStore } from "../stores/providerStore";
import {
  api,
  parseAdapterError,
  adapterErrorTitle,
  isUnconfirmedError,
  AdapterError,
} from "../lib/api";
import { deliverEditResult } from "../lib/deliverEditResult";
import { toast } from "../lib/notify";
import { DUR, EASE } from "../lib/motion";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Input } from "./ui/Field";
import { Slider } from "./ui/Slider";
import { ConfirmDialog } from "./ui/Dialog";
import { ToolbarGroup, ToolbarSeparator } from "./ui/Toolbar";
import { IconBrush, IconClose, IconEraser } from "./Icons";
import SafeImg from "./SafeImg";
import MaskCanvas, { MaskCanvasHandle } from "./MaskCanvas";

export default function EditorView() {
  const { t } = useTranslation();
  const editTarget = useAppStore((s) => s.editTarget);
  const closeEditor = useAppStore((s) => s.closeEditor);
  const defaultProviderId = useProviderStore((s) => s.defaultProviderId);
  const providers = useProviderStore((s) => s.providers);

  const source = editTarget;

  const containerRef = useRef<HTMLDivElement>(null);
  const maskRef = useRef<MaskCanvasHandle>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [display, setDisplay] = useState({ w: 0, h: 0 });
  const [brushSize, setBrushSize] = useState(48);
  const [eraser, setEraser] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastError, setLastError] = useState<AdapterError | null>(null);
  const [confirmRetry, setConfirmRetry] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  // 智能蒙版：设置关闭或模型不可用时整块入口隐藏，行为回到纯手动画笔
  const [smartReady, setSmartReady] = useState(false);
  const [pickMode, setPickMode] = useState(false);
  const [picking, setPicking] = useState(false);
  const canvasInline = useAppStore((s) => s.canvasInline);
  const reduce = useReducedMotion();

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
    if (!source) return;
    const img = new Image();
    img.onload = () => setImage(img);
    img.src = source.dataUrl;
  }, [source]);

  useEffect(() => {
    if (!image || !containerRef.current) return;
    const box = containerRef.current.getBoundingClientRect();
    const scale = Math.min(
      (box.width - 48) / image.naturalWidth,
      (box.height - 48) / image.naturalHeight,
      1,
    );
    setDisplay({
      w: Math.round(image.naturalWidth * scale),
      h: Math.round(image.naturalHeight * scale),
    });
    setResultUrl(null);
  }, [image]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeEditor();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeEditor]);

  if (!source) return null;

  const inline = canvasInline && source.host === "canvas";

  const submit = async (force = false) => {
    if (!image || !source) return;
    // 上一次结果未确认：再点一次就会重新计费，必须先让用户确认
    if (lastError && isUnconfirmedError(lastError) && !force) {
      setConfirmRetry(true);
      return;
    }
    const isErase = source.mode === "erase";
    if (!isErase && !prompt.trim()) {
      toast(t("请输入重绘描述"), "error");
      return;
    }
    if (defaultProviderId == null) {
      toast(t("请先在「设置」中配置服务商"), "error");
      return;
    }
    const item = providers.find((p) => p.provider.id === defaultProviderId);
    const model = item?.provider.defaultModel;
    if (!model) {
      toast(t("请先在「设置」中选择默认模型"), "error");
      return;
    }
    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = image.naturalWidth;
    srcCanvas.height = image.naturalHeight;
    srcCanvas.getContext("2d")!.drawImage(image, 0, 0);
    if (!maskRef.current?.hasStrokes()) {
      toast(t("请先涂抹要修改的区域"), "error");
      return;
    }
    const maskB64 = maskRef.current.toAlphaPng();
    if (!maskB64) return;
    setBusy(true);
    setError(null);
    const sentPrompt = source.mode === "erase" ? "" : prompt;
    // 消除不需要负向词（提示词由后端补全），重绘沿用全局负向设置
    const prefs = useAppStore.getState().prefs;
    try {
      const out = await api.editImage({
        providerId: defaultProviderId,
        prompt: sentPrompt,
        negativePrompt:
          source.mode === "erase" ? null : prefs.negativePrompt.trim() || null,
        model,
        imageB64: srcCanvas.toDataURL("image/png"),
        maskB64,
        width: image.naturalWidth,
        height: image.naturalHeight,
        op: isErase ? "erase" : "edit",
        parentId: source.historyId,
      });
      setResultUrl(out.dataUrl);
      if (out.warning) toast(out.warning, "error");
      const displayPrompt = isErase ? t("（AI 消除）") : prompt;
      await deliverEditResult(
        source,
        { ...out, width: image.naturalWidth, height: image.naturalHeight },
        displayPrompt,
      );
      setLastError(null);
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
        outcome.failed > 0
          ? t("（{{n}} 张仍失败）", { n: outcome.failed })
          : "";
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

  const isErase = source.mode === "erase";

  const handlePick = async (
    x: number,
    y: number,
    mods: { shift: boolean; alt: boolean },
  ) => {
    if (!source || picking) return;
    setPicking(true);
    try {
      const out = await api.segmentAtPoint(
        source.dataUrl,
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
      {/* 栏头与工具条合并为同一块玻璃：中间不夹第二条分割玻璃 */}
      <header className="relative z-10 shrink-0 glass">
        <div className="flex min-h-12 items-center gap-3 px-6 py-2">
          <div className="flex min-w-0 flex-col">
            <h1 className="truncate text-title3 text-primary">
              {isErase ? t("AI 消除") : t("局部重绘")}
            </h1>
            <p className="truncate text-footnote text-tertiary">
              {pickMode
                ? t(
                    "点击要修改的物体自动选中；Shift 加选、Alt 减选，可继续用画笔修整",
                  )
                : isErase
                  ? t("涂抹要消除的对象，一键补全背景")
                  : t("涂抹要修改的区域，其余像素保持不变")}
            </p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              onClick={() => void submit()}
            >
              {isErase ? t("一键消除") : t("局部重绘")}
            </Button>
            <IconButton
              label={t("关闭编辑器")}
              icon={<IconClose size={16} />}
              onClick={closeEditor}
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
                // 点选模式下画笔不生效，点橡皮擦视为退出点选、回到手动涂抹
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

          {!isErase && (
            <>
              <ToolbarSeparator />
              <div className="min-w-0 flex-1">
                <Input
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={t("描述要重绘的内容…")}
                  aria-label={t("重绘描述")}
                  compact
                />
              </div>
            </>
          )}
        </div>
      </header>

      <div
        ref={containerRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-6"
      >
        {resultUrl ? (
          <div className="flex h-full min-h-0 flex-col items-center gap-3">
            <SafeImg
              src={resultUrl}
              alt={t("重绘结果")}
              className="min-h-0 max-h-full max-w-full rounded-card border border-line object-contain shadow-pop"
            />
            <div className="flex shrink-0 gap-2">
              <Button size="sm" onClick={() => setResultUrl(null)}>
                {t("继续编辑")}
              </Button>
              <Button size="sm" variant="primary" onClick={closeEditor}>
                {inline ? t("完成，返回画布") : t("完成，返回对话")}
              </Button>
            </div>
          </div>
        ) : image ? (
          <div
            className="relative overflow-hidden rounded-card shadow-pop"
            style={{ width: display.w, height: display.h }}
          >
            <SafeImg
              src={source.dataUrl}
              alt={t("编辑对象")}
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

      {error && (
        <div
          role="alert"
          className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-danger/25 bg-danger/10 px-6 py-2 text-footnote text-danger"
        >
          <span className="min-w-0 flex-1">{error}</span>
          {unconfirmed && (
            <span className="text-warning">
              {t("可能已计费，重试会再次扣费")}
            </span>
          )}
          {requestId && (
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
          )}
          {requestId && (
            <Button
              size="sm"
              variant="ghost"
              loading={recovering}
              onClick={() => void recover()}
            >
              {t("尝试恢复")}
            </Button>
          )}
        </div>
      )}

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
    </motion.div>
  );
}
