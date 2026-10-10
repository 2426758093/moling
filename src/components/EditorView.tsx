import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useAppStore } from "../stores/appStore";
import { useChatStore } from "../stores/chatStore";
import { useProviderStore } from "../stores/providerStore";
import { api, parseAdapterError, adapterErrorTitle } from "../lib/api";
import { toast } from "../lib/notify";

export default function EditorView() {
  const editTarget = useAppStore((s) => s.editTarget);
  const closeEditor = useAppStore((s) => s.closeEditor);
  const defaultProviderId = useProviderStore((s) => s.defaultProviderId);
  const providers = useProviderStore((s) => s.providers);

  const source = editTarget;

  const containerRef = useRef<HTMLDivElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [display, setDisplay] = useState({ w: 0, h: 0 });
  const [brushSize, setBrushSize] = useState(48);
  const [eraser, setEraser] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const drawing = useRef(false);

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
    const canvas = maskCanvasRef.current;
    if (canvas) {
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    }
    setResultUrl(null);
  }, [image]);

  if (!source) return null;

  const maskCtx = () => maskCanvasRef.current?.getContext("2d") ?? null;

  const stroke = (e: React.PointerEvent) => {
    const canvas = maskCanvasRef.current;
    const ctx = maskCtx();
    if (!canvas || !ctx) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
    ctx.globalCompositeOperation = eraser ? "destination-out" : "source-over";
    ctx.strokeStyle = "#ff2d2d";
    ctx.fillStyle = "#ff2d2d";
    ctx.lineWidth = brushSize;
    if (!drawing.current) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      drawing.current = true;
    } else {
      ctx.lineTo(x, y);
      ctx.stroke();
    }
  };

  const paintAt = (e: React.PointerEvent) => {
    const canvas = maskCanvasRef.current;
    const ctx = maskCtx();
    if (!canvas || !ctx) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
    ctx.globalCompositeOperation = eraser ? "destination-out" : "source-over";
    ctx.fillStyle = "#ff2d2d";
    ctx.beginPath();
    ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
  };

  const selectAll = () => {
    const canvas = maskCanvasRef.current;
    const ctx = maskCtx();
    if (!canvas || !ctx) return;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#ff2d2d";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  };

  const clearMask = () => {
    const canvas = maskCanvasRef.current;
    const ctx = maskCtx();
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  };

  const maskToB64 = (): string | null => {
    const canvas = maskCanvasRef.current;
    if (!canvas || !image) return null;
    const off = document.createElement("canvas");
    off.width = canvas.width;
    off.height = canvas.height;
    const ctx = off.getContext("2d")!;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, off.width, off.height);
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(canvas, 0, 0);
    return off.toDataURL("image/png");
  };

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
    const maskB64 = maskToB64();
    if (!maskB64) return;
    setBusy(true);
    setError(null);
    const sentPrompt = source.mode === "erase" ? "" : prompt;
    try {
      const out = await api.editImage({
        providerId: defaultProviderId,
        prompt: sentPrompt,
        model,
        imageB64: srcCanvas.toDataURL("image/png"),
        maskB64,
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
      setResultUrl(out.dataUrl);
      // 结果回流消息流：在当前对话追加一条助手消息
      const displayPrompt = isErase ? "（AI 消除）" : prompt;
      await useChatStore.getState().appendImageMessage(
        {
          historyId: out.historyId,
          dataUrl: out.dataUrl,
          path: out.filePath,
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

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-40 flex flex-col bg-base"
    >
      <div className="bg-glass flex h-[52px] shrink-0 items-center gap-3 border-b border-theme px-4">
        <span className="text-sm font-medium text-primary">
          {source.mode === "erase" ? "AI 消除" : "局部重绘"}
        </span>
        <span className="text-xs text-tertiary">
          {source.mode === "erase"
            ? "涂抹要消除的对象，一键补全背景"
            : "涂抹要修改的区域，其余像素保持不变"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={submit}
            disabled={busy}
            className="pressable rounded-[10px] bg-accent px-4 py-1.5 text-sm font-medium text-white transition-opacity disabled:opacity-50"
          >
            {busy
              ? "处理中…"
              : source.mode === "erase"
                ? "一键消除"
                : "局部重绘"}
          </button>
          <button
            onClick={closeEditor}
            className="pressable rounded-[10px] border border-theme px-3 py-1.5 text-sm text-secondary transition-colors hover:bg-hover"
          >
            关闭
          </button>
        </div>
      </div>

      <div className="bg-glass flex shrink-0 flex-wrap items-center gap-3 border-b border-theme px-4 py-2">
        <span className="text-xs text-tertiary">画笔</span>
        <input
          type="range"
          min={8}
          max={200}
          value={brushSize}
          onChange={(e) => setBrushSize(Number(e.target.value))}
        />
        <button
          onClick={() => setEraser(!eraser)}
          className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
            eraser
              ? "border-accent bg-accent-soft text-accent"
              : "border-theme text-tertiary hover:text-secondary"
          }`}
        >
          {eraser ? "橡皮擦中" : "橡皮擦"}
        </button>
        <button
          onClick={selectAll}
          className="rounded-lg border border-theme px-2.5 py-1 text-xs text-tertiary transition-colors hover:text-secondary"
        >
          全选
        </button>
        <button
          onClick={clearMask}
          className="rounded-lg border border-theme px-2.5 py-1 text-xs text-tertiary transition-colors hover:text-secondary"
        >
          清除蒙版
        </button>
        {source.mode !== "erase" && (
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="描述要重绘的内容…"
            className="min-w-0 flex-1 rounded-lg border border-theme bg-transparent px-3 py-1.5 text-sm outline-none transition-colors focus:border-accent"
          />
        )}
      </div>

      <div
        ref={containerRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-6"
      >
        {resultUrl ? (
          <div className="flex h-full flex-col items-center gap-3">
            <img
              src={resultUrl}
              alt="重绘结果"
              className="max-h-full max-w-full rounded-xl object-contain shadow-pop"
            />
            <div className="flex gap-2 text-xs">
              <button
                onClick={() => setResultUrl(null)}
                className="rounded-lg border border-theme px-3 py-1.5 text-secondary transition-colors hover:bg-hover"
              >
                继续编辑
              </button>
              <button
                onClick={closeEditor}
                className="pressable rounded-[10px] bg-accent px-3 py-1.5 text-white"
              >
                完成，返回对话
              </button>
            </div>
          </div>
        ) : image ? (
          <div
            className="relative overflow-hidden rounded-xl shadow-pop"
            style={{ width: display.w, height: display.h }}
          >
            <img
              src={source.dataUrl}
              alt="编辑对象"
              className="absolute inset-0 h-full w-full"
              draggable={false}
            />
            <canvas
              ref={maskCanvasRef}
              className="absolute inset-0 h-full w-full opacity-60"
              style={{ touchAction: "none" }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                paintAt(e);
              }}
              onPointerMove={(e) => {
                if (e.buttons === 1) stroke(e);
              }}
              onPointerUp={() => (drawing.current = false)}
            />
          </div>
        ) : (
          <span className="text-sm text-tertiary">加载中…</span>
        )}
      </div>

      {error && (
        <div className="shrink-0 border-t border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger">
          {error}
        </div>
      )}
    </motion.div>
  );
}
