import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, type RetouchTarget } from "../../stores/appStore";
import { useProviderStore } from "../../stores/providerStore";
import { useCompact } from "../../hooks/useMediaQuery";
import { useModelCaps } from "../../lib/useModelCaps";
import {
  api,
  adapterErrorTitle,
  parseAdapterError,
  type HistoryRowView,
  type RetouchAnalysis,
  type RetouchOp,
} from "../../lib/api";
import { isGifDataUrl } from "../../lib/image";
import { readFileAsDataUrl } from "../../lib/file";
import { deliverEditResult } from "../../lib/deliverEditResult";
import { emitHistoryChanged } from "../../lib/historyEvents";
import { toast } from "../../lib/notify";
import {
  autoOps,
  beautyOps,
  DEFAULT_AUTO_STRENGTH,
  DEFAULT_BEAUTY_AMOUNT,
  isCloudRetouchAction,
  outputStepDims,
  resolveEditInputSize,
  retouchActionReason,
  stepLabelForOp,
  type PixelSize,
  type RetouchActionId,
  type RetouchGateCtx,
  type RetouchGateReason,
  type RetouchStepLabel,
} from "../../lib/retouchActions";
import { ERASE_PROMPT } from "../../lib/retouchPrompts";
import type { MaskCanvasHandle } from "../MaskCanvas";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { IconImage } from "../Icons";
import RetouchHeader from "./RetouchHeader";
import RetouchStage from "./RetouchStage";
import ActionRail from "./ActionRail";
import StepStrip, { type RetouchStep } from "./StepStrip";
import AutoPanel from "./panels/AutoPanel";
import BeautyPanel from "./panels/BeautyPanel";
import ErasePanel from "./panels/ErasePanel";
import InstructionPanel from "./panels/InstructionPanel";

/** 专家模式滑杆预览的防抖：拖滑块时每 250ms 最多算一次 */
const PREVIEW_DEBOUNCE_MS = 250;
const PREVIEW_MAX_SIDE = 1024;
/** 解结果图尺寸的超时：卡住的解码不能把提交永久挂起 */
const MEASURE_TIMEOUT_MS = 5000;
/**
 * 重开后还原步骤链的上限：只保留离当前最近的 12 步。
 * 更早的历史仍留在库里，只是不进步骤条（缩略图与取出成本都不值当）。
 */
const LINEAGE_MAX_STEPS = 12;

/** 提交动作的统一返回形状：本地 RetouchResult 与云端 editImage 都能落成一步 */
interface StepResult {
  historyId: number;
  dataUrl: string;
  /** 落盘路径：画布回写不需要，会话回写要带 */
  filePath?: string;
  width?: number;
  height?: number;
}

/// 解码图片拿自然宽高：失败 / 超时都返回 null，绝不用别的尺寸顶替。
function measureImageSize(src: string): Promise<PixelSize | null> {
  return new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    const settle = (value: PixelSize | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve(value);
    };
    const timer = window.setTimeout(() => settle(null), MEASURE_TIMEOUT_MS);
    img.onload = () =>
      settle(
        img.naturalWidth > 0 && img.naturalHeight > 0
          ? { width: img.naturalWidth, height: img.naturalHeight }
          : null,
      );
    img.onerror = () => settle(null);
    img.src = src;
  });
}

/** 同一视图里再开一张底图时靠 key 重建整套状态，步骤链不会串台 */
function studioKey(target: RetouchTarget): string {
  return [
    target.historyId ?? "new",
    target.dataUrl.length,
    target.dataUrl.slice(20, 60),
    target.canvasNodeId ?? "",
    target.title ?? "",
  ].join(":");
}

/// AI 修图台入口：没有底图时只给拖拽 / 选择，有底图则交给修图主体。
export default function RetouchView({
  embedded = false,
}: {
  embedded?: boolean;
}) {
  const { t } = useTranslation();
  const target = useAppStore((s) => s.retouchTarget);
  const closeRetouch = useAppStore((s) => s.closeRetouch);
  const openRetouch = useAppStore((s) => s.openRetouch);
  const mode = useAppStore((s) => s.mode);
  const setMode = useAppStore((s) => s.setMode);
  const compact = useCompact();
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  if (target) {
    return (
      <RetouchStudio
        key={studioKey(target)}
        target={target}
        embedded={embedded}
        // 画布内嵌面板只有 440px 左右：无论窗口多宽都按底部抽屉排布
        stacked={embedded || compact}
      />
    );
  }

  const acceptFile = async (file: File | null | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast(t("请选择图片文件"), "error");
      return;
    }
    if (file.type === "image/gif" || /\.gif$/i.test(file.name)) {
      toast(t("动图暂不支持修图"), "error");
      return;
    }
    setImporting(true);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const imported = await api.importImage(dataUrl);
      openRetouch({
        dataUrl: imported.dataUrl,
        historyId: imported.historyId,
        title: file.name,
      });
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const parsed = parseAdapterError(raw);
      toast(
        parsed.type === "other"
          ? parsed.message || raw
          : t("{{title}}：{{message}}", {
              title: adapterErrorTitle(parsed),
              message: parsed.message,
            }),
        "error",
      );
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-base">
      <RetouchHeader
        embedded={embedded}
        mode={mode}
        showMode={false}
        onModeChange={setMode}
        onBack={closeRetouch}
      />
      <div
        className="flex min-h-0 flex-1 flex-col"
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.stopPropagation();
        }}
        onDragEnter={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.stopPropagation();
        }}
        onDrop={(e) => {
          // 根节点的拖拽处理器会把图片塞进对话，这里必须截住
          e.preventDefault();
          e.stopPropagation();
          void acceptFile(e.dataTransfer.files?.[0]);
        }}
      >
        <EmptyState
          icon={<IconImage size={22} strokeWidth={1.6} />}
          title={t("修图台")}
          description={t("拖入或选择一张图片开始修图")}
        >
          <div className="flex justify-center">
            <Button
              size="sm"
              variant="secondary"
              loading={importing}
              onClick={() => fileRef.current?.click()}
            >
              {t("选择图片")}
            </Button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              void acceptFile(file);
            }}
          />
        </EmptyState>
      </div>
    </div>
  );
}

interface StudioProps {
  target: RetouchTarget;
  embedded: boolean;
  stacked: boolean;
}

/// 修图主体：简单模式只给 4 个动作 + 一句话输入 + 前后对比 + 步骤条。
/// 本地动作（一键优化 / 美颜）永不被门禁拦住，云动作禁用时给一行原因。
function RetouchStudio({ target, embedded, stacked }: StudioProps) {
  const { t } = useTranslation();
  const closeRetouch = useAppStore((s) => s.closeRetouch);
  const mode = useAppStore((s) => s.mode);
  const setMode = useAppStore((s) => s.setMode);
  const providers = useProviderStore((s) => s.providers);
  const defaultProviderId = useProviderStore((s) => s.defaultProviderId);
  const caps = useModelCaps();

  // 步骤与当前索引同放一个状态：追加步骤时索引必须在 updater 里算，
  // 否则连续提交会读到闭包里的旧长度（key 重复、停在错的一步）。
  const [{ steps, current }, setStepState] = useState<{
    steps: RetouchStep[];
    current: number;
  }>(() => ({ steps: [firstStep(target)], current: 0 }));
  const [busy, setBusy] = useState<RetouchActionId | null>(null);
  const [panel, setPanel] = useState<RetouchActionId | null>(null);
  const [analysis, setAnalysis] = useState<{
    src: string;
    result: RetouchAnalysis;
  } | null>(null);
  const [instruction, setInstruction] = useState("");
  const [autoStrength, setAutoStrength] = useState(DEFAULT_AUTO_STRENGTH);
  const [beautyAmount, setBeautyAmount] = useState(DEFAULT_BEAUTY_AMOUNT);
  const [brushSize, setBrushSize] = useState(36);
  const [eraser, setEraser] = useState(false);
  const [preview, setPreview] = useState<{ key: string; url: string } | null>(
    null,
  );
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  const maskRef = useRef<MaskCanvasHandle | null>(null);
  const previewTimer = useRef<number | null>(null);
  const previewSeq = useRef(0);
  /** 已还原过步骤链的 historyId：换底图会重建实例，同一实例只还原一次 */
  const restoredFor = useRef<number | null>(null);
  /** 正在懒加载全图的步骤 key：同一 key 的并发请求只发一次 */
  const stepLoads = useRef(new Map<string, Promise<RetouchStep>>());

  // 挂载后后台分析：失败静默，本地动作照常可用
  useEffect(() => {
    let alive = true;
    api
      .retouchAnalyze(target.dataUrl)
      .then((result) => {
        if (alive) setAnalysis({ src: target.dataUrl, result });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [target.dataUrl]);

  // 重开应用后还原步骤链：底图已入库时按历史血统补齐整条链。
  // 只在「还没提交过新步骤」且没还原过这个 historyId 时跑一次；读图失败
  // 只丢那一步，全丢就保持单步原图 —— 都不打扰用户。
  //
  // 内存口径：旧实现一次性读 12 张全分辨率图（约 200MB）。现在只批量取缩略图，
  // 全图只给「最后一行（当前步）」读一张，其余步等用户真的用到时再懒加载。
  useEffect(() => {
    const historyId = target.historyId;
    if (historyId == null || busy) return;
    if (restoredFor.current === historyId) return;
    let alive = true;
    void (async () => {
      let rows: HistoryRowView[];
      try {
        rows = await api.historyLineage(historyId);
      } catch {
        return;
      }
      if (!alive) return;
      if (rows.length <= 1) {
        // 没有可还原的父步骤：也算「还原完成」，免得每次 busy 变化都重查血统
        restoredFor.current = historyId;
        return;
      }
      // root→current 顺序：截断时砍掉最早的那几步，留下离当前最近的 12 步
      const tail = rows.slice(-LINEAGE_MAX_STEPS);
      // 截断后第一格不是真正的原图，不能再标「原图」，按它自己的 op 命名
      const truncated = rows.length > tail.length;

      // 缩略图一次批量取：失败就当作「全都没有」，后面按行回退全图
      const thumbs = new Map<number, string>();
      try {
        const list = await api.batchHistoryThumbs(tail.map((row) => row.id));
        for (const thumb of list) thumbs.set(thumb.historyId, thumb.thumbUrl);
      } catch {
        // 忽略：下面缺失缩略图的行会各自回退读全图
      }
      if (!alive) return;

      const currentId = tail[tail.length - 1].id;
      const full = new Map<number, string>();
      // 只有当前步需要全尺寸（提交要用它当底图）
      try {
        const image = await api.getHistoryImage(currentId);
        full.set(currentId, image.dataUrl);
      } catch {
        // 当前步读不到：保留缩略图，用户点动作时会再试一次
      }
      if (!alive) return;
      // 缩略图缺失且不是当前步的行才回退（极少见，仍然只读该行）
      for (const row of tail) {
        if (!alive) return;
        if (row.id === currentId || thumbs.has(row.id) || full.has(row.id)) {
          continue;
        }
        try {
          const image = await api.getHistoryImage(row.id);
          full.set(row.id, image.dataUrl);
        } catch {
          // 单张读图失败只丢那一步
        }
      }
      if (!alive) return;

      const restored: RetouchStep[] = [];
      for (const row of tail) {
        const isCurrent = row.id === currentId;
        const dataUrl = full.get(row.id) ?? "";
        const thumbUrl = thumbs.get(row.id);
        // 旧步两张图都拿不到就丢掉；当前步必须留住 —— 它是后续提交的父节点
        if (!isCurrent && !dataUrl && !thumbUrl) continue;
        restored.push({
          key: `s${row.id}`,
          dataUrl,
          thumbUrl,
          historyId: row.id,
          width: row.width,
          height: row.height,
          label: stepLabelForOp(row.op, restored.length + (truncated ? 1 : 0)),
          op: row.op,
        });
      }
      if (restored.length === 0) return;
      // 期间用户已经提交了新步骤：以内存里的链为准，别把新步骤盖掉
      setStepState((prev) =>
        prev.steps.length === 1
          ? { steps: restored, current: restored.length - 1 }
          : prev,
      );
      // 真正写进状态后才算还原完成：中途失败保持 null，下次 busy 变化会重试
      restoredFor.current = historyId;
    })();
    return () => {
      alive = false;
    };
  }, [target.historyId, busy]);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  useEffect(
    () => () => {
      if (previewTimer.current != null) {
        window.clearTimeout(previewTimer.current);
      }
    },
    [],
  );

  const cur = steps[current] ?? steps[0];
  const root = steps[0];
  const title = target.title ?? t("修图");

  /// 懒加载某一步的全图：已有就原样返回；同一 key 的并发请求只发一次。
  /// 还原出来的旧步只带缩略图，真要拿它当底图（提交 / 预览 / 对比左图）时才读全图。
  const ensureFullStep = (step: RetouchStep): Promise<RetouchStep> => {
    if (step.dataUrl) return Promise.resolve(step);
    const pending = stepLoads.current.get(step.key);
    if (pending) return pending;
    const historyId = step.historyId;
    if (historyId == null) {
      return Promise.reject(new Error(t("图片读取失败，请重试")));
    }
    const task = api
      .getHistoryImage(historyId)
      .then((image) => {
        setStepState((prev) => {
          const index = prev.steps.findIndex((item) => item.key === step.key);
          if (index < 0) return prev;
          const updated = prev.steps.slice();
          updated[index] = { ...updated[index], dataUrl: image.dataUrl };
          return { ...prev, steps: updated };
        });
        return { ...step, dataUrl: image.dataUrl };
      })
      .catch((error: unknown) => {
        throw error instanceof Error ? error : new Error(String(error));
      })
      .finally(() => {
        stepLoads.current.delete(step.key);
      });
    stepLoads.current.set(step.key, task);
    return task;
  };

  // 当前步只有缩略图时后台补全图：舞台显示与提交都要用它
  useEffect(() => {
    if (cur.dataUrl) return;
    void ensureFullStep(cur).catch(() => undefined);
    // ensureFullStep 每次渲染都是新函数，触发条件只认「哪一步 + 有没有全图」
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur.key, cur.dataUrl]);

  // 对比模式要看清晰的左图：根步也按需 hydrate。
  // 内存上限因此是「当前步 + 根步」两张全图，而不是整条链。
  useEffect(() => {
    if (current === 0 || root.dataUrl) return;
    void ensureFullStep(root).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, root.key, root.dataUrl]);

  // 换步 = 换底图：蒙版必须跟着清空。MaskCanvas 已按 src 重建（stage 里的 key），
  // 这里再清一次句柄，保证切换后 hasStrokes() 立刻是 false，不会导出旧尺寸的蒙版。
  useEffect(() => {
    maskRef.current?.clear();
  }, [cur.key]);

  const provider = providers.find((p) => p.provider.id === defaultProviderId);
  const model = provider?.provider.defaultModel ?? "";
  const gate: RetouchGateCtx = {
    hasProvider: defaultProviderId != null,
    hasModel: model !== "",
    instructionEdit: caps.instructionEdit,
    edit: caps.edit,
    isGif: isGifDataUrl(target.dataUrl),
    online,
  };
  const reasons: Record<RetouchActionId, RetouchGateReason | null> = {
    auto: retouchActionReason("auto", gate),
    beauty: retouchActionReason("beauty", gate),
    erase: retouchActionReason("erase", gate),
    instruction: retouchActionReason("instruction", gate),
  };
  const analysisResult =
    analysis && analysis.src === target.dataUrl ? analysis.result : null;

  // 预览跟着「哪一步 + 哪个面板 + 哪个模式」走：上下文一变就自然失效，
  // 不需要在 effect 里清状态，也不会出现过期响应覆盖新结果。
  const previewKey = `${cur.key}|${panel ?? "none"}|${mode}`;
  const previewUrl = preview && preview.key === previewKey ? preview.url : null;

  const describeError = (error: unknown) => {
    const raw = error instanceof Error ? error.message : String(error);
    const parsed = parseAdapterError(raw);
    if (parsed.type === "other") return parsed.message || raw;
    return t("{{title}}：{{message}}", {
      title: adapterErrorTitle(parsed),
      message: parsed.message,
    });
  };

  const appendStep = (result: StepResult, label: RetouchStepLabel) => {
    setStepState((prev) => {
      const index = prev.steps.length;
      return {
        steps: [...prev.steps, toStep(result, label)],
        current: index,
      };
    });
  };

  /// 云端编辑要上报的输入尺寸：总是先实测（旧历史行记的是未摆正的尺寸，
  /// 横竖颠倒时蒙版会错位），量不到才回退步骤记录。
  /// 两处都拿不到就是 null，调用方必须拒绝提交（发 0×0 会让服务商重采样）。
  const editInputSize = async (step: RetouchStep): Promise<PixelSize | null> =>
    resolveEditInputSize(step, await measureImageSize(step.dataUrl), true);

  /// 提交动作：统一 busy / 报错 / 清预览；返回是否成功（失败时保留输入）。
  /// `run` 拿到的是「保证带全图」的那一步：还原出来的旧步会先懒加载。
  const commit = async (
    action: RetouchActionId,
    label: RetouchStepLabel,
    run: (src: RetouchStep) => Promise<StepResult>,
  ): Promise<boolean> => {
    setBusy(action);
    setPreview(null);
    // 防抖里的预览必须就地取消：只清预览图的话，250ms 后的全尺寸请求
    // 仍会在 busy 期间发出，回来还可能盖住新步骤的结果。
    if (previewTimer.current != null) {
      window.clearTimeout(previewTimer.current);
      previewTimer.current = null;
    }
    previewSeq.current += 1;
    try {
      const src = await ensureFullStep(cur);
      const result = await run(src);
      // 云动作的结果尺寸只能靠量：量不到就留空，绝不回填输入尺寸
      const dims = isCloudRetouchAction(action)
        ? outputStepDims(await measureImageSize(result.dataUrl))
        : {};
      const step = { ...result, ...dims };
      appendStep(step, label);
      // 每一步都落库成新记录：画廊 / 历史列表靠这条广播刷新
      emitHistoryChanged();
      // 画布来源：结果必须落回节点（同尺寸成层 / 异尺寸成节点）。
      // 回写失败只提示，不把已经成功的这一步判为失败。
      if (target.canvasNodeId) {
        // 源尺寸未知（0×0 自动尺寸）时不传：同尺寸判定必须按「未知」处理
        const sourceDims =
          target.width != null &&
          target.width > 0 &&
          target.height != null &&
          target.height > 0
            ? { width: target.width, height: target.height }
            : {};
        try {
          await deliverEditResult(
            {
              historyId: target.historyId ?? 0,
              nodeId: target.canvasNodeId,
              host: "canvas",
              ...sourceDims,
            },
            {
              historyId: step.historyId,
              dataUrl: step.dataUrl,
              filePath: step.filePath ?? "",
              width: step.width,
              height: step.height,
            },
            label,
          );
        } catch (e) {
          toast(t("回写画布失败：{{error}}", { error: String(e) }), "error");
        }
      }
      return true;
    } catch (error) {
      toast(describeError(error), "error");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const queuePreview = (ops: RetouchOp[]) => {
    if (busy) return;
    const source = cur;
    const key = previewKey;
    // 立即作废旧 token：后发的请求才是唯一有效结果
    previewSeq.current += 1;
    if (previewTimer.current != null) window.clearTimeout(previewTimer.current);
    previewTimer.current = window.setTimeout(() => {
      previewTimer.current = null;
      const seq = previewSeq.current;
      // 预览也绝不拿缩略图当底：读不到全图就静默放弃这次预览
      ensureFullStep(source)
        .then((step) =>
          api.previewRetouch({
            imageB64: step.dataUrl,
            ops,
            preview: { maxSide: PREVIEW_MAX_SIDE },
          }),
        )
        .then((result) => {
          if (seq === previewSeq.current)
            setPreview({ key, url: result.dataUrl });
        })
        .catch(() => undefined);
    }, PREVIEW_DEBOUNCE_MS);
  };

  const applyAuto = (strength: number) => {
    if (busy) return;
    void commit("auto", "一键优化", (src) =>
      api.applyRetouch({
        imageB64: src.dataUrl,
        parentId: src.historyId ?? undefined,
        ops: autoOps(strength),
      }),
    );
  };

  const applyBeauty = (amount: number) => {
    if (busy) return;
    void commit("beauty", "美颜", (src) =>
      api.applyRetouch({
        imageB64: src.dataUrl,
        parentId: src.historyId ?? undefined,
        ops: beautyOps(amount),
      }),
    );
  };

  const applyErase = () => {
    if (busy) return;
    const reason = reasons.erase;
    if (reason) {
      toast(t(reason), "error");
      return;
    }
    if (defaultProviderId == null || !model) return;
    const strokes = maskRef.current;
    if (!strokes?.hasStrokes()) {
      toast(t("请先涂抹要消除的区域"), "error");
      return;
    }
    const maskB64 = strokes.toAlphaPng();
    if (!maskB64) {
      toast(t("请先涂抹要消除的区域"), "error");
      return;
    }
    const providerId = defaultProviderId;
    const modelId = model;
    void commit("erase", "AI 消除", async (src) => {
      // 没尺寸宁可不发：0×0 会让服务商按默认尺寸重采样，蒙版直接错位
      const size = await editInputSize(src);
      if (!size) throw new Error(t("图片尺寸读取失败，请重试"));
      const out = await api.editImage({
        providerId,
        model: modelId,
        prompt: ERASE_PROMPT,
        imageB64: src.dataUrl,
        maskB64,
        width: size.width,
        height: size.height,
        op: "erase",
        parentId: src.historyId ?? undefined,
      });
      if (out.warning) toast(out.warning, "error");
      return {
        historyId: out.historyId,
        dataUrl: out.dataUrl,
        filePath: out.filePath,
      };
    });
  };

  const applyInstruction = () => {
    if (busy) return;
    const reason = reasons.instruction;
    if (reason) {
      toast(t(reason), "error");
      return;
    }
    if (defaultProviderId == null || !model) return;
    const prompt = instruction.trim();
    if (!prompt) {
      toast(t("请输入修改要求"), "error");
      return;
    }
    const providerId = defaultProviderId;
    const modelId = model;
    void commit("instruction", "一句话改图", async (src) => {
      const size = await editInputSize(src);
      if (!size) throw new Error(t("图片尺寸读取失败，请重试"));
      const out = await api.editImage({
        providerId,
        model: modelId,
        prompt,
        imageB64: src.dataUrl,
        width: size.width,
        height: size.height,
        op: "retouch",
        parentId: src.historyId ?? undefined,
      });
      if (out.warning) toast(out.warning, "error");
      return {
        historyId: out.historyId,
        dataUrl: out.dataUrl,
        filePath: out.filePath,
      };
    }).then((ok) => {
      // 失败时保留原话，方便改一改重试
      if (ok) setInstruction("");
    });
  };

  const onAction = (id: RetouchActionId) => {
    if (busy) return;
    const reason = reasons[id];
    if (reason) {
      toast(t(reason), "error");
      return;
    }
    if (mode === "simple" && id === "auto") {
      setPanel(null);
      applyAuto(DEFAULT_AUTO_STRENGTH);
      return;
    }
    if (mode === "simple" && id === "beauty") {
      setPanel(null);
      applyBeauty(DEFAULT_BEAUTY_AMOUNT);
      return;
    }
    setPanel((prev) => (prev === id ? null : id));
  };

  const onInstructionFocus = () => {
    if (busy || reasons.instruction) return;
    setPanel("instruction");
  };

  const selectStep = (index: number) => {
    setStepState((prev) =>
      prev.current === index ? prev : { ...prev, current: index },
    );
  };

  const continueFromHere = () => {
    setStepState((prev) =>
      prev.current >= prev.steps.length - 1
        ? prev
        : { ...prev, steps: prev.steps.slice(0, prev.current + 1) },
    );
  };

  const panelNode =
    panel === "auto" ? (
      <AutoPanel
        expert={mode === "expert"}
        strength={autoStrength}
        onStrengthChange={(value) => {
          setAutoStrength(value);
          queuePreview(autoOps(value));
        }}
        analysis={analysisResult}
        busy={busy}
        onApply={() =>
          applyAuto(mode === "expert" ? autoStrength : DEFAULT_AUTO_STRENGTH)
        }
      />
    ) : panel === "beauty" ? (
      <BeautyPanel
        expert={mode === "expert"}
        amount={beautyAmount}
        onAmountChange={(value) => {
          setBeautyAmount(value);
          queuePreview(beautyOps(value));
        }}
        busy={busy}
        onApply={() =>
          applyBeauty(mode === "expert" ? beautyAmount : DEFAULT_BEAUTY_AMOUNT)
        }
      />
    ) : panel === "erase" ? (
      <ErasePanel
        reason={reasons.erase}
        brushSize={brushSize}
        onBrushSizeChange={setBrushSize}
        eraser={eraser}
        onEraserChange={setEraser}
        onClearMask={() => maskRef.current?.clear()}
        busy={busy}
        onConfirm={applyErase}
      />
    ) : panel === "instruction" ? (
      <InstructionPanel
        value={instruction}
        onChange={setInstruction}
        reason={reasons.instruction}
        busy={busy}
        onSubmit={applyInstruction}
      />
    ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-base">
      <RetouchHeader
        embedded={embedded}
        title={target.title}
        mode={mode}
        showMode
        onModeChange={setMode}
        onBack={closeRetouch}
      />

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <RetouchStage
            src={cur.dataUrl || cur.thumbUrl || ""}
            before={root.dataUrl || root.thumbUrl || ""}
            alt={title}
            compare={current > 0}
            previewUrl={previewUrl}
            beforeLabel={t(root.label)}
            afterLabel={previewUrl ? t("预览") : t(cur.label)}
            maskActive={panel === "erase"}
            brushSize={brushSize}
            eraser={eraser}
            busy={busy !== null}
            maskRef={maskRef}
          />

          {stacked && panelNode && (
            <div className="max-h-[45vh] shrink-0 overflow-auto border-t border-line">
              {panelNode}
            </div>
          )}

          <ActionRail
            panel={panel}
            busy={busy}
            reasons={reasons}
            instruction={instruction}
            onInstructionChange={setInstruction}
            onInstructionFocus={onInstructionFocus}
            onInstructionSubmit={applyInstruction}
            onAction={onAction}
          />

          <StepStrip
            steps={steps}
            current={current}
            busy={busy}
            onSelect={selectStep}
            onContinue={continueFromHere}
          />
        </div>

        {!stacked && panelNode && (
          <aside
            aria-label={t("修图面板")}
            className="flex w-[340px] shrink-0 flex-col overflow-auto border-l border-line"
          >
            {panelNode}
          </aside>
        )}
      </div>
    </div>
  );
}

/// 新步骤的 key 也用 historyId：还原出来的步骤是 `s<id>`，用序号会和它们撞。
function toStep(result: StepResult, label: RetouchStepLabel): RetouchStep {
  return {
    key: `s${result.historyId}`,
    dataUrl: result.dataUrl,
    historyId: result.historyId,
    width: result.width,
    height: result.height,
    label,
  };
}

function firstStep(target: RetouchTarget): RetouchStep {
  return {
    key: "s0",
    dataUrl: target.dataUrl,
    historyId: target.historyId ?? null,
    width: target.width,
    height: target.height,
    label: "原图",
  };
}
