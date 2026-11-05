import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useAppStore } from "../stores/appStore";
import { useChatStore } from "../stores/chatStore";
import { useProviderStore } from "../stores/providerStore";
import { api, parseAdapterError, adapterErrorTitle } from "../lib/api";
import { toast } from "../lib/notify";
import { DUR, EASE } from "../lib/motion";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Input } from "./ui/Field";
import { Slider } from "./ui/Slider";
import { ToolbarGroup, ToolbarSeparator } from "./ui/Toolbar";
import { IconBrush, IconClose, IconEraser } from "./Icons";
import SafeImg from "./SafeImg";
import MaskCanvas, { MaskCanvasHandle } from "./MaskCanvas";

export default function EditorView() {
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
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const reduce = useReducedMotion();

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

  const submit = async () => {
    if (!image || !source) return;
    const isErase = source.mode === "erase";
    if (!isErase && !prompt.trim()) {
      toast("请输入重绘描述", "error");
      return;
    }
    if (defaultProviderId == null) {
      toast("请先在「设置」中配置服务商", "error");
      return;
    }
    const item = providers.find((p) => p.provider.id === defaultProviderId);
    const model = item?.provider.defaultModel;
    if (!model) {
      toast("请先在「设置」中选择默认模型", "error");
      return;
    }
    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = image.naturalWidth;
    srcCanvas.height = image.naturalHeight;
    srcCanvas.getContext("2d")!.drawImage(image, 0, 0);
    if (!maskRef.current?.hasStrokes()) {
      toast("请先涂抹要修改的区域", "error");
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
      // 结果回流消息流：在当前对话追加一条助手消息
      const displayPrompt = isErase ? "（AI 消除）" : prompt;
      await useChatStore.getState().appendImageMessage(
        {
          historyId: out.historyId,
          dataUrl: out.dataUrl,
          path: out.filePath,
          derivedFrom: source.historyId,
        },
        displayPrompt,
      );
    } catch (e) {
      const parsed = parseAdapterError(String(e));
      setError(`${adapterErrorTitle(parsed)}：${parsed.message}`);
    } finally {
      setBusy(false);
    }
  };

  const isErase = source.mode === "erase";

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduce ? 0 : DUR.base, ease: EASE.ios }}
      className="fixed inset-x-0 bottom-0 top-12 z-30 flex flex-col bg-base"
    >
      {/* 栏头与工具条合并为同一块玻璃：中间不夹第二条分割玻璃 */}
      <header className="relative z-10 shrink-0 glass">
        <div className="flex min-h-12 items-center gap-3 px-6 py-2">
          <div className="flex min-w-0 flex-col">
            <h1 className="truncate text-title3 text-primary">
              {isErase ? "AI 消除" : "局部重绘"}
            </h1>
            <p className="truncate text-footnote text-tertiary">
              {isErase
                ? "涂抹要消除的对象，一键补全背景"
                : "涂抹要修改的区域，其余像素保持不变"}
            </p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              onClick={() => void submit()}
            >
              {isErase ? "一键消除" : "局部重绘"}
            </Button>
            <IconButton
              label="关闭编辑器"
              icon={<IconClose size={16} />}
              onClick={closeEditor}
            />
          </div>
        </div>

        <div
          role="toolbar"
          aria-label="蒙版工具"
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
                label="画笔大小"
              />
            </div>
            <span className="w-8 text-right text-footnote tabular-nums text-tertiary">
              {brushSize}
            </span>
          </ToolbarGroup>

          <ToolbarSeparator />

          <ToolbarGroup>
            <IconButton
              label={eraser ? "关闭橡皮擦" : "橡皮擦"}
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
              全选
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => maskRef.current?.clear()}
            >
              清除蒙版
            </Button>
          </ToolbarGroup>

          {!isErase && (
            <>
              <ToolbarSeparator />
              <div className="min-w-0 flex-1">
                <Input
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="描述要重绘的内容…"
                  aria-label="重绘描述"
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
              alt="重绘结果"
              className="min-h-0 max-h-full max-w-full rounded-card border border-line object-contain shadow-pop"
            />
            <div className="flex shrink-0 gap-2">
              <Button size="sm" onClick={() => setResultUrl(null)}>
                继续编辑
              </Button>
              <Button size="sm" variant="primary" onClick={closeEditor}>
                完成，返回对话
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
              alt="编辑对象"
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
          <span className="text-body text-tertiary">加载中…</span>
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
