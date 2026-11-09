import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { BackgroundTarget, useAppStore } from "../stores/appStore";
import { useProviderStore } from "../stores/providerStore";
import { api, parseAdapterError, adapterErrorTitle } from "../lib/api";
import { deliverEditResult } from "../lib/deliverEditResult";
import { toast } from "../lib/notify";
import { DUR, EASE } from "../lib/motion";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Input } from "./ui/Field";
import { Slider } from "./ui/Slider";
import { SegmentedControl } from "./ui/SegmentedControl";
import { ColorField } from "./ui/ColorField";
import { ToolbarGroup, ToolbarSeparator } from "./ui/Toolbar";
import { IconBrush, IconClose, IconEraser } from "./Icons";
import SafeImg from "./SafeImg";
import MaskCanvas, { MaskCanvasHandle } from "./MaskCanvas";

type FillKind = "solid" | "gradient" | "ai";
type Direction = "horizontal" | "vertical" | "diagonal";

/// 换背景：蒙版复用局部重绘的画笔工具，纯色 / 渐变本地合成，AI 走服务商编辑接口。
export default function BackgroundView() {
  const target = useAppStore((s) => s.backgroundTarget);
  const close = useAppStore((s) => s.closeBackground);
  if (!target) return null;
  return (
    <BackgroundBody key={target.historyId} target={target} close={close} />
  );
}

function BackgroundBody({
  target,
  close,
}: {
  target: BackgroundTarget;
  close: () => void;
}) {
  const defaultProviderId = useProviderStore((s) => s.defaultProviderId);
  const providers = useProviderStore((s) => s.providers);
  const { t } = useTranslation();
  const provider = providers.find((p) => p.provider.id === defaultProviderId);
  const model = provider?.provider.defaultModel ?? "";

  const containerRef = useRef<HTMLDivElement>(null);
  const maskRef = useRef<MaskCanvasHandle>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [display, setDisplay] = useState({ w: 0, h: 0 });
  const [brushSize, setBrushSize] = useState(48);
  const [eraser, setEraser] = useState(false);
  const [kind, setKind] = useState<FillKind>("solid");
  const [color, setColor] = useState("#f5f5f7");
  const [from, setFrom] = useState("#ff9a8b");
  const [to, setTo] = useState("#6a85ff");
  const [direction, setDirection] = useState<Direction>("horizontal");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  // 智能蒙版：设置关闭或模型不可用时隐藏入口，行为回到手动画笔
  const [smartReady, setSmartReady] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const canvasInline = useAppStore((s) => s.canvasInline);
  const reduce = useReducedMotion();
  const inline = canvasInline && target.host === "canvas";

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
    const img = new Image();
    img.onload = () => setImage(img);
    img.src = target.dataUrl;
  }, [target.dataUrl]);

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
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const canSubmit =
    !busy && (kind !== "ai" || (prompt.trim() !== "" && model !== ""));

  const autoSelect = async () => {
    if (autoBusy) return;
    setAutoBusy(true);
    try {
      // invert：主体之外 = 要替换的背景
      const out = await api.segmentSubject(target.dataUrl, true);
      if (out.covered < 0.005) {
        toast(t("没有识别到可替换的背景，请手动涂抹"), "error");
        return;
      }
      await maskRef.current?.applyMask(out.dataUrl, "replace");
      if (out.covered > 0.98) {
        toast(t("主体不明显，已选中几乎整张图，请用橡皮擦修正"));
      }
    } catch (e) {
      toast(parseAdapterError(String(e)).message, "error");
    } finally {
      setAutoBusy(false);
    }
  };

  const submit = async () => {
    if (!image || !canSubmit) return;
    if (!maskRef.current?.hasStrokes()) {
      toast(t("请先涂抹要替换的背景区域"), "error");
      return;
    }
    const maskB64 =
      kind === "ai"
        ? maskRef.current.toAlphaPng()
        : maskRef.current.toLumaPng();
    if (!maskB64) return;
    setBusy(true);
    setError(null);
    try {
      const out = await api.replaceBackground({
        imageB64: target.dataUrl,
        maskB64,
        parentId: target.historyId,
        kind,
        color,
        colorFrom: from,
        colorTo: to,
        direction,
        prompt: kind === "ai" ? prompt.trim() : "",
        providerId: kind === "ai" ? defaultProviderId : null,
        model: kind === "ai" ? model : undefined,
      });
      setResultUrl(out.dataUrl);
      const label =
        kind === "ai"
          ? t("换背景：{{desc}}", { desc: prompt.trim() })
          : kind === "solid"
            ? t("换背景：纯色")
            : t("换背景：渐变");
      await deliverEditResult(target, out, label);
    } catch (e) {
      const parsed = parseAdapterError(String(e));
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
            <h1 className="truncate text-title3 text-primary">{t("换背景")}</h1>
            <p className="truncate text-footnote text-tertiary">
              {t("涂抹要替换的背景区域，也可先「自动选中背景」再修整")}
            </p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              disabled={!canSubmit}
              onClick={() => void submit()}
            >
              {t("换背景")}
            </Button>
            <IconButton
              label={t("关闭换背景")}
              icon={<IconClose size={16} />}
              onClick={close}
            />
          </div>
        </div>

        <div
          role="toolbar"
          aria-label={t("换背景工具")}
          className="flex flex-wrap items-center gap-2 px-6 pb-2.5"
        >
          <ToolbarGroup>
            <span className="pl-1 text-tertiary">
              <IconBrush size={16} />
            </span>
            <div className="w-24 shrink-0">
              <Slider
                value={brushSize}
                onValueChange={setBrushSize}
                min={8}
                max={200}
                label={t("画笔大小")}
              />
            </div>
            <IconButton
              label={eraser ? t("关闭橡皮擦") : t("橡皮擦")}
              icon={<IconEraser size={16} />}
              variant={eraser ? "secondary" : "ghost"}
              aria-pressed={eraser}
              onClick={() => setEraser((v) => !v)}
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => maskRef.current?.fillAll()}
            >
              {t("全选背景")}
            </Button>
            {smartReady && (
              <Button
                size="sm"
                variant="ghost"
                loading={autoBusy}
                title={t("本地 AI 识别主体，自动选中主体之外的背景")}
                onClick={() => void autoSelect()}
              >
                {t("自动选中背景")}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => maskRef.current?.clear()}
            >
              {t("清除")}
            </Button>
          </ToolbarGroup>

          <ToolbarSeparator />

          <SegmentedControl
            label={t("背景类型")}
            value={kind}
            onValueChange={setKind}
            size="sm"
            options={[
              { value: "solid", label: t("纯色") },
              { value: "gradient", label: t("渐变") },
              { value: "ai", label: t("AI 描述") },
            ]}
          />

          {kind === "solid" && (
            <ColorField
              label={t("背景颜色")}
              value={color}
              onValueChange={setColor}
            />
          )}

          {kind === "gradient" && (
            <ToolbarGroup>
              <ColorField
                label={t("起始颜色")}
                value={from}
                onValueChange={setFrom}
              />
              <ColorField
                label={t("结束颜色")}
                value={to}
                onValueChange={setTo}
              />
              <SegmentedControl
                label={t("渐变方向")}
                value={direction}
                onValueChange={setDirection}
                size="sm"
                options={[
                  { value: "horizontal", label: t("水平") },
                  { value: "vertical", label: t("垂直") },
                  { value: "diagonal", label: t("对角") },
                ]}
              />
            </ToolbarGroup>
          )}

          {kind === "ai" && (
            <div className="min-w-0 flex-1">
              <Input
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={t("描述想要的背景，例如：星空下的霓虹城市…")}
                aria-label={t("背景描述")}
                compact
              />
            </div>
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
              alt={t("换背景结果")}
              className="min-h-0 max-h-full max-w-full rounded-card border border-line object-contain shadow-pop"
            />
            <div className="flex shrink-0 gap-2">
              <Button size="sm" onClick={() => setResultUrl(null)}>
                {t("继续调整")}
              </Button>
              <Button size="sm" variant="primary" onClick={close}>
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
              src={target.dataUrl}
              alt={t("换背景对象")}
              className="absolute inset-0 h-full w-full"
            />
            <MaskCanvas
              ref={maskRef}
              image={image}
              brushSize={brushSize}
              eraser={eraser}
              className="absolute inset-0 h-full w-full opacity-60"
            />
          </div>
        ) : (
          <span className="text-body text-tertiary">{t("加载中…")}</span>
        )}
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
