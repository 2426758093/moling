import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { useAppStore, type RetouchTarget } from "../../stores/appStore";
import { useProviderStore } from "../../stores/providerStore";
import { useCompact } from "../../hooks/useMediaQuery";
import { useModelCaps } from "../../lib/useModelCaps";
import {
  api,
  adapterErrorTitle,
  isUnconfirmedError,
  parseAdapterError,
  type AdapterError,
  type HistoryRowView,
  type RegionProgressEvent,
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
  mayBillRetouchAction,
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
import {
  ERASE_PROMPT,
  OUTPAINT_PROMPT,
  withGuard,
} from "../../lib/retouchPrompts";
import {
  buildCropEditOps,
  outpaintOffsets,
  outpaintTargetSize,
  type CropState,
  type OutpaintRatio,
} from "../../lib/retouchGeometry";
import { padImageToSize } from "../../lib/retouchCanvas";
import type { MaskCanvasHandle } from "../MaskCanvas";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/Dialog";
import { EmptyState } from "../ui/EmptyState";
import { IconImage } from "../Icons";
import RetouchHeader from "./RetouchHeader";
import RetouchStage from "./RetouchStage";
import RetouchErrorNotice from "./RetouchErrorNotice";
import ActionRail from "./ActionRail";
import StepStrip, { type RetouchStep } from "./StepStrip";
import AutoPanel from "./panels/AutoPanel";
import BeautyPanel from "./panels/BeautyPanel";
import BackgroundPanel, {
  type BackgroundOptions,
} from "./panels/BackgroundPanel";
import CropPanel from "./panels/CropPanel";
import ErasePanel from "./panels/ErasePanel";
import InpaintPanel from "./panels/InpaintPanel";
import InstructionPanel from "./panels/InstructionPanel";
import OutpaintPanel from "./panels/OutpaintPanel";
import RegionPanel, {
  MAX_REGION_BATCH,
  type RegionDraft,
} from "./panels/RegionPanel";
import StylePanel from "./panels/StylePanel";
import UpscalePanel from "./panels/UpscalePanel";

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
/** 多区域合成的羽化半径：与旧 RegionEditView 的 DEFAULT_FEATHER 一致 */
const REGION_FEATHER = 24;

/** 区域 id 与批次 job id 只在「添加 / 提交」时生成：模块层自增避免渲染期读时钟 */
let regionSeq = 0;
function newRegionId(): string {
  regionSeq += 1;
  return `region-${Date.now()}-${regionSeq}`;
}
let regionJobSeq = 0;
function newRegionJobId(): string {
  regionJobSeq += 1;
  return `region-job-${Date.now()}-${regionJobSeq}`;
}

/** 提交动作的统一返回形状：本地 RetouchResult 与云端 editImage 都能落成一步 */
interface StepResult {
  historyId: number;
  dataUrl: string;
  /** 落盘路径：画布回写不需要，会话回写要带 */
  filePath?: string;
  width?: number;
  height?: number;
}

interface CommitOptions {
  /** 只由「确认重新生成」弹窗传入：跳过未确认拦截 */
  force?: boolean;
  /** 这次提交是否可能扣费；缺省按 mayBillRetouchAction(action) */
  billable?: boolean;
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
  const [inpaintPrompt, setInpaintPrompt] = useState("");
  const [autoStrength, setAutoStrength] = useState(DEFAULT_AUTO_STRENGTH);
  const [beautyAmount, setBeautyAmount] = useState(DEFAULT_BEAUTY_AMOUNT);
  const [brushSize, setBrushSize] = useState(36);
  const [eraser, setEraser] = useState(false);
  const [preview, setPreview] = useState<{ key: string; url: string } | null>(
    null,
  );
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  /** 上一次提交的失败（保留到下一次成功）：未确认时要能对账与恢复 */
  const [lastError, setLastError] = useState<AdapterError | null>(null);
  /**
   * 未确认计费的挂起标记：只由提交结果改写，关闭提示条不会清它。
   * 拦截条件必须挂在这里而不是 lastError 上 —— 提示条只是 UI，用户点「关闭提示」
   * 只是不想再看这段文案，那次请求的对账结论并没有出来，计费风险仍然存在。
   * 若跟着提示条一起清掉，关一次提示就能绕过二次扣费确认。
   */
  const [unconfirmed, setUnconfirmed] = useState<{
    requestId: string | null;
  } | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [confirmRetry, setConfirmRetry] = useState(false);
  /** 当前步的实测尺寸：扩图面板要拿它算目标画布 */
  const [measured, setMeasured] = useState<{
    src: string;
    size: PixelSize;
  } | null>(null);
  /** 多区域：待提交的草稿（蒙版在添加时就固化）、逐区状态与进度 */
  const [regionDrafts, setRegionDrafts] = useState<RegionDraft[]>([]);
  const [regionStatus, setRegionStatus] = useState<
    Record<string, "running" | "ok" | "error">
  >({});
  const [regionProgress, setRegionProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const maskRef = useRef<MaskCanvasHandle | null>(null);
  /** 正在跑的那批多区域 job：取消按钮认的是它（后端 cancelGeneration 认 jobId） */
  const regionJobRef = useRef<string | null>(null);
  /** 用户确认「仍然重新生成」后要执行的那次提交 */
  const pendingRetry = useRef<(() => void) | null>(null);
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

  // 扩图面板要按当前步的真实像素算目标画布；量不到就显示「保持原尺寸」。
  // 结果连同 src 一起记：换步后旧测量自然失效，不需要在 effect 里同步清状态。
  useEffect(() => {
    let alive = true;
    const src = cur.dataUrl;
    void measureImageSize(src).then((size) => {
      if (alive && size) setMeasured({ src, size });
    });
    return () => {
      alive = false;
    };
  }, [cur.dataUrl]);
  const inputSize =
    measured && measured.src === cur.dataUrl ? measured.size : null;

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

  // 多区域的草稿把蒙版固化在「添加时的那张底图」上：换步后必然错位，必须清空。
  // 只认步骤 key —— 切面板不清（来回看动作名不该丢已经涂好的区域）。
  // 在渲染期间同步调整（而不是 effect 内 setState）：与本仓 Composer 的草稿同步同一手法。
  const [regionKey, setRegionKey] = useState(cur.key);
  if (regionKey !== cur.key) {
    setRegionKey(cur.key);
    if (regionDrafts.length > 0) setRegionDrafts([]);
    if (Object.keys(regionStatus).length > 0) setRegionStatus({});
    if (regionProgress) setRegionProgress(null);
  }

  // 换面板 = 换语义：消除 / 换背景 / 局部重绘共用同一块画布（同一 src 下不重建），
  // 不清的话刚涂的消除区域会被当成背景蒙版提交，扣的却是另一次费用。
  // 只处理「面板之间」的切换：从无面板打开时 MaskCanvas 是新建的空画布（面板关着
  // 它就被卸载了），此时清空没有意义，还会抹掉刚 hydrate 的画布状态。
  const prevPanel = useRef<RetouchActionId | null>(panel);
  useEffect(() => {
    const prev = prevPanel.current;
    prevPanel.current = panel;
    if (prev && panel && prev !== panel) maskRef.current?.clear();
  }, [panel]);

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
    background: retouchActionReason("background", gate),
    upscale: retouchActionReason("upscale", gate),
    outpaint: retouchActionReason("outpaint", gate),
    crop: retouchActionReason("crop", gate),
    style: retouchActionReason("style", gate),
    inpaint: retouchActionReason("inpaint", gate),
    region: retouchActionReason("region", gate),
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
  /// `options.force` 只由「确认重新生成」弹窗传来：跳过未确认计费的拦截。
  const commit = async (
    action: RetouchActionId,
    label: RetouchStepLabel,
    run: (src: RetouchStep) => Promise<StepResult>,
    options: CommitOptions = {},
  ): Promise<boolean> => {
    const billable = options.billable ?? mayBillRetouchAction(action);
    // 上一次未确认 + 这次可能扣费 + 不是用户确认后的重试 → 先弹确认，不发请求
    // 注意读的是 unconfirmed（跨提示条存活），不是 lastError（可被关闭清掉）。
    // 拦截条件用 billable 而不是动作分类：纯色 / 渐变换背景不扣费，
    // 不该被上一次云请求的未确认标记拦住。
    if (!options.force && unconfirmed && billable) {
      pendingRetry.current = () => {
        void commit(action, label, run, { ...options, force: true });
      };
      setConfirmRetry(true);
      return false;
    }
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
      // 报错条描述的是「上一次失败」，成功就清掉。
      // 但挂起标记只该被「可能扣费的动作」的成功解除：一键优化 / 美颜走本地，
      // 纯色 / 渐变换背景也不扣费 —— 它们的成功并不能说明之前那次云端请求有没有
      // 出图，清了等于用本地动作绕过拦截。
      setLastError(null);
      if (billable) setUnconfirmed(null);
      return true;
    } catch (error) {
      const parsed = parseAdapterError(
        error instanceof Error ? error.message : String(error),
      );
      // 可能已计费：挂起标记跟踪的是「最新一次」未确认请求 —— 提示条显示的
      // 是它，恢复按钮对账的也是它。新错误带 ID 就用新 ID 覆盖（旧 ID 对应的
      // 那次已被新的失败顶到后面）；新错误没带 ID 时保留已有的非空 ID，免得
      // 把还能对账的请求顶成 null。
      // 其他错误不改它 —— 一次网络抖动不该顶掉还没对账的计费风险。
      if (isUnconfirmedError(parsed)) {
        const nextId =
          parsed.type === "unconfirmed" ? (parsed.request_id ?? null) : null;
        setUnconfirmed((prev) => ({
          requestId: nextId ?? prev?.requestId ?? null,
        }));
      }
      setLastError(parsed);
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

  /// 对账要用「仍未解除」的那次请求 ID：提示条可能已被关闭，所以读挂起标记
  const requestId = unconfirmed?.requestId ?? undefined;

  /// 未确认的请求按 client request id 对账：命中的结果直接补进画廊
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
      // 对账完成：这家客户端请求的计费风险已经交代清楚（不论是否全部恢复），
      // 提示条与挂起标记一起解除，下一次提交重新回到正常流程
      setLastError(null);
      setUnconfirmed(null);
    } catch (e) {
      toast(t("恢复失败：{{error}}", { error: String(e) }), "error");
    } finally {
      setRecovering(false);
    }
  };

  /// 换背景：纯色 / 渐变在本地合成，AI 描述才走服务商（面板已提示计费口径）
  const applyBackground = (options: BackgroundOptions) => {
    if (busy) return;
    const providerId = defaultProviderId;
    const modelId = model;
    if (options.kind === "ai" && (providerId == null || !modelId)) {
      toast(t("请先在设置中配置服务商"), "error");
      return;
    }
    // 蒙版必须在进 commit 之前校验：commit 里会先弹「可能已计费」确认，
    // 空蒙版放进去等于让用户为一次必然空发的请求确认扣费。
    const mask = maskRef.current;
    if (!mask?.hasStrokes()) {
      toast(t("请先涂抹要替换的背景区域"), "error");
      return;
    }
    // 导出也提前做：失败同样是本地问题，走 toast 而不是常驻的报错条
    const maskB64 =
      options.kind === "ai" ? mask.toAlphaPng() : mask.toLumaPng();
    if (!maskB64) {
      toast(t("请先涂抹要替换的背景区域"), "error");
      return;
    }
    void commit(
      "background",
      "换背景",
      async (src) => {
        const out = await api.replaceBackground({
          imageB64: src.dataUrl,
          maskB64,
          parentId: src.historyId ?? undefined,
          kind: options.kind,
          color: options.color,
          colorFrom: options.colorFrom,
          colorTo: options.colorTo,
          direction: options.direction,
          prompt: options.kind === "ai" ? options.prompt.trim() : "",
          providerId: options.kind === "ai" ? providerId : null,
          model: options.kind === "ai" ? modelId : undefined,
        });
        return {
          historyId: out.historyId,
          dataUrl: out.dataUrl,
          filePath: out.filePath,
          width: out.width,
          height: out.height,
        };
      },
      // 纯色 / 渐变在本地合成：不扣费，也就不该被未确认标记拦住、更不该解除它
      { billable: options.kind === "ai" },
    );
  };

  /// 高清放大：模型沿用默认模型，不再复刻旧弹窗的模型下拉
  const applyUpscale = (scale: 2 | 4, upMode: "detail" | "faithful") => {
    if (busy) return;
    const reason = reasons.upscale;
    if (reason) {
      toast(t(reason), "error");
      return;
    }
    if (defaultProviderId == null || !model) return;
    const providerId = defaultProviderId;
    const modelId = model;
    void commit("upscale", "高清", async (src) => {
      const out = await api.transformImage({
        providerId,
        model: modelId,
        imageB64: src.dataUrl,
        scale,
        mode: upMode,
        prompt: "",
        parentId: src.historyId ?? undefined,
      });
      return {
        historyId: out.historyId,
        dataUrl: out.dataUrl,
        filePath: out.filePath,
        width: out.width,
        height: out.height,
      };
    });
  };

  /// 扩图：把原图居中画到透明大画布上，再交给 editImage 补全（gpt-image-1 口径）
  const applyOutpaint = (ratio: OutpaintRatio, prompt: string) => {
    if (busy) return;
    const reason = reasons.outpaint;
    if (reason) {
      toast(t(reason), "error");
      return;
    }
    if (defaultProviderId == null || !model) return;
    const providerId = defaultProviderId;
    const modelId = model;
    void commit("outpaint", "扩图", async (src) => {
      const size = await editInputSize(src);
      if (!size) throw new Error(t("图片尺寸读取失败，请重试"));
      const target = outpaintTargetSize(size, ratio);
      if (target.width === size.width && target.height === size.height) {
        throw new Error(t("请选择一个更大的目标比例"));
      }
      const padded = await padImageToSize(
        src.dataUrl,
        target,
        outpaintOffsets(size, target),
      );
      const out = await api.editImage({
        providerId,
        model: modelId,
        prompt: prompt || OUTPAINT_PROMPT,
        imageB64: padded,
        maskB64: null,
        width: target.width,
        height: target.height,
        op: "outpaint",
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

  /// 裁剪调色：本地像素运算，永不计费（billable: false 显式声明，
  /// 免得以后动作分类口径变化时被上一次云请求的未确认标记误伤）
  const applyCrop = (state: CropState) => {
    if (busy) return;
    const reason = reasons.crop;
    if (reason) {
      toast(t(reason), "error");
      return;
    }
    const ops = buildCropEditOps(state);
    if (ops.length === 0) return;
    void commit(
      "crop",
      "裁剪调色",
      async (src) => {
        const out = await api.applyEdit({
          imageB64: src.dataUrl,
          ops,
          parentId: src.historyId ?? undefined,
        });
        return {
          historyId: out.historyId,
          dataUrl: out.dataUrl,
          filePath: out.filePath,
          width: out.width,
          height: out.height,
        };
      },
      { billable: false },
    );
  };

  /// 风格：scale=1 + 提示词即风格转换，模型沿用默认模型
  const applyStyle = (prompt: string) => {
    if (busy) return;
    const reason = reasons.style;
    if (reason) {
      toast(t(reason), "error");
      return;
    }
    if (defaultProviderId == null || !model) return;
    const providerId = defaultProviderId;
    const modelId = model;
    void commit("style", "风格", async (src) => {
      const out = await api.transformImage({
        providerId,
        model: modelId,
        imageB64: src.dataUrl,
        scale: 1,
        mode: "detail",
        prompt,
        parentId: src.historyId ?? undefined,
      });
      return {
        historyId: out.historyId,
        dataUrl: out.dataUrl,
        filePath: out.filePath,
        width: out.width,
        height: out.height,
      };
    });
  };

  /// 局部重绘：蒙版 + 用户提示词（追加护栏）走 editImage retouch。
  const applyInpaint = (prompt: string) => {
    if (busy) return;
    const reason = reasons.inpaint;
    if (reason) {
      toast(t(reason), "error");
      return;
    }
    if (defaultProviderId == null || !model) return;
    // 蒙版校验放在 commit 之前：空蒙版不可能扣费，不能触发计费确认或常驻错误条
    const mask = maskRef.current;
    if (!mask?.hasStrokes()) {
      toast(t("请先涂抹要重绘的区域"), "error");
      return;
    }
    const maskB64 = mask.toAlphaPng();
    if (!maskB64) {
      toast(t("请先涂抹要重绘的区域"), "error");
      return;
    }
    const providerId = defaultProviderId;
    const modelId = model;
    const fullPrompt = withGuard(prompt);
    void commit("inpaint", "局部重绘", async (src) => {
      const size = await editInputSize(src);
      if (!size) throw new Error(t("图片尺寸读取失败，请重试"));
      const out = await api.editImage({
        providerId,
        model: modelId,
        prompt: fullPrompt,
        imageB64: src.dataUrl,
        maskB64,
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
      // 失败时保留输入，方便改一改重试
      if (ok) setInpaintPrompt("");
    });
  };

  /// 多区域：把当前涂抹 + 提示词收成一块草稿（蒙版导出后立刻清画布，接着涂下一块）
  const addRegion = (prompt: string): boolean => {
    const trimmed = prompt.trim();
    const mask = maskRef.current;
    if (!trimmed || !mask?.hasStrokes()) {
      toast(t("请先涂抹区域并填写提示词"), "error");
      return false;
    }
    if (regionDrafts.length >= MAX_REGION_BATCH) {
      toast(t("一批最多 {{max}} 个区域", { max: MAX_REGION_BATCH }), "error");
      return false;
    }
    const maskB64 = mask.toAlphaPng();
    if (!maskB64) {
      toast(t("请先涂抹区域并填写提示词"), "error");
      return false;
    }
    setRegionDrafts((prev) => [
      ...prev,
      { id: newRegionId(), prompt: trimmed, maskB64 },
    ]);
    mask.clear();
    return true;
  };

  const removeRegion = (id: string) => {
    setRegionDrafts((prev) => prev.filter((item) => item.id !== id));
    setRegionStatus((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  /// 多区域提交：一批 ≤4 个区域逐区调用服务商，整图由后端本地合成后作为一步追加。
  /// 逐区计费 —— 面板的确认弹窗先让用户点头，未确认标记的拦截仍由 commit 兜底。
  const applyRegions = () => {
    if (busy) return;
    const reason = reasons.region;
    if (reason) {
      toast(t(reason), "error");
      return;
    }
    if (defaultProviderId == null || !model) return;
    if (regionDrafts.length === 0) return;

    const providerId = defaultProviderId;
    const modelId = model;
    const regions = regionDrafts.map((item) => ({ ...item }));
    const job = newRegionJobId();
    regionJobRef.current = job;
    setRegionProgress({ done: 0, total: regions.length });
    setRegionStatus(
      Object.fromEntries(regions.map((item) => [item.id, "running" as const])),
    );

    void commit("region", "多区域", async (src) => {
      // 底图必须已入库：后端的 baseHistoryId 是这次合成的父节点
      const baseHistoryId = src.historyId;
      if (baseHistoryId == null) throw new Error(t("图片读取失败，请重试"));
      // 同一时刻只允许一批（busy 已保证）：事件按 jobId 认不出来，也不需要过滤
      const unlisten = await listen<RegionProgressEvent>(
        "image:region-progress",
        (event) => {
          const p = event.payload;
          setRegionProgress({ done: p.done, total: p.total });
          if (p.regionId) {
            const id = p.regionId;
            setRegionStatus((state) => ({
              ...state,
              [id]: p.ok ? "ok" : "error",
            }));
          }
        },
      );
      try {
        const out = await api.regionEditBatch({
          providerId,
          model: modelId,
          negativePrompt: null,
          baseHistoryId,
          baseB64: src.dataUrl,
          jobId: job,
          regions: regions.map((item) => ({
            id: item.id,
            prompt: item.prompt,
            maskB64: item.maskB64,
            feather: REGION_FEATHER,
          })),
        });
        // 事件可能丢：以返回结果为准收口每个区域的状态
        setRegionStatus(
          Object.fromEntries(
            out.results.map((item) => [item.id, item.ok ? "ok" : "error"]),
          ) as Record<string, "running" | "ok" | "error">,
        );
        const failures = out.results
          .filter((item) => !item.ok)
          .map((item) => item.error)
          .filter((error): error is string => !!error);
        if (out.cancelled) {
          toast(
            t("已取消，已保留 {{done}} 个区域的结果", {
              done: out.results.filter((item) => item.ok).length,
            }),
            "info",
          );
        } else if (failures.length > 0) {
          toast(t("部分区域失败：{{error}}", { error: failures[0] }), "error");
        }
        // 一个都没成或没有合成图：当作失败，交给 commit 的错误条
        if (!out.anySucceeded || out.historyId == null || out.dataUrl == null) {
          throw new Error(
            failures[0]
              ? t("部分区域失败：{{error}}", { error: failures[0] })
              : t("分区重绘失败"),
          );
        }
        return { historyId: out.historyId, dataUrl: out.dataUrl };
      } finally {
        // 进度与取消句柄在 run 返回前收掉：之后的量尺寸 / 追加步骤 / 回写仍归 commit
        unlisten();
        regionJobRef.current = null;
        setRegionProgress(null);
      }
    }).then((ok) => {
      // 成功才清草稿：失败 / 取消要留着让用户补齐重试
      if (ok) {
        setRegionDrafts([]);
        setRegionStatus({});
      }
    });
  };

  const cancelRegions = () => {
    const job = regionJobRef.current;
    if (job) void api.cancelGeneration(job).catch(() => undefined);
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
    ) : panel === "background" ? (
      <BackgroundPanel
        reason={reasons.background}
        busy={busy}
        src={cur.dataUrl}
        maskRef={maskRef}
        brushSize={brushSize}
        onBrushSizeChange={setBrushSize}
        eraser={eraser}
        onEraserChange={setEraser}
        onClearMask={() => maskRef.current?.clear()}
        // AI 模式要发服务商请求：离线时和云动作同口径，一并禁用
        aiAvailable={online && defaultProviderId != null && model !== ""}
        aiReason={
          !online
            ? "当前离线"
            : defaultProviderId == null
              ? "请先在设置中配置服务商"
              : model === ""
                ? "请先在设置中选择默认模型"
                : null
        }
        onConfirm={applyBackground}
      />
    ) : panel === "outpaint" ? (
      <OutpaintPanel
        reason={reasons.outpaint}
        busy={busy}
        inputSize={inputSize}
        onConfirm={applyOutpaint}
      />
    ) : panel === "upscale" ? (
      <UpscalePanel
        reason={reasons.upscale}
        busy={busy}
        onConfirm={applyUpscale}
      />
    ) : panel === "region" ? (
      <RegionPanel
        reason={reasons.region}
        busy={busy}
        drafts={regionDrafts}
        status={regionStatus}
        progress={regionProgress}
        brushSize={brushSize}
        onBrushSizeChange={setBrushSize}
        eraser={eraser}
        onEraserChange={setEraser}
        onClearMask={() => maskRef.current?.clear()}
        onAdd={addRegion}
        onRemove={removeRegion}
        onSubmit={applyRegions}
        onCancel={cancelRegions}
      />
    ) : panel === "crop" ? (
      <CropPanel
        reason={reasons.crop}
        busy={busy}
        src={cur.dataUrl}
        inputSize={inputSize}
        onPreview={(url) => setPreview(url ? { key: previewKey, url } : null)}
        onConfirm={applyCrop}
      />
    ) : panel === "style" ? (
      <StylePanel reason={reasons.style} busy={busy} onConfirm={applyStyle} />
    ) : panel === "inpaint" ? (
      <InpaintPanel
        reason={reasons.inpaint}
        busy={busy}
        prompt={inpaintPrompt}
        onPromptChange={setInpaintPrompt}
        brushSize={brushSize}
        onBrushSizeChange={setBrushSize}
        eraser={eraser}
        onEraserChange={setEraser}
        onClearMask={() => maskRef.current?.clear()}
        onConfirm={applyInpaint}
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
            maskActive={
              panel === "erase" ||
              panel === "background" ||
              panel === "inpaint" ||
              panel === "region"
            }
            brushSize={brushSize}
            eraser={eraser}
            busy={busy !== null}
            maskRef={maskRef}
          />

          {lastError && (
            <div className="shrink-0 px-3 pt-2">
              <RetouchErrorNotice
                error={lastError}
                recovering={recovering}
                onRecover={() => void recover()}
                // 只关掉提示条：未确认的挂起标记要留着，否则下一次提交就绕过了确认弹窗
                onDismiss={() => setLastError(null)}
              />
            </div>
          )}

          {stacked && panelNode && (
            <div className="max-h-[45vh] shrink-0 overflow-auto border-t border-line">
              {panelNode}
            </div>
          )}

          <ActionRail
            mode={mode}
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

      <ConfirmDialog
        open={confirmRetry}
        onOpenChange={setConfirmRetry}
        title={t("确认重新生成？")}
        description={t(
          "这次请求可能已在服务商侧计费。重新生成会再次扣费，请先到服务商后台确认没有出图。",
        )}
        confirmLabel={t("仍然重新生成")}
        danger
        onConfirm={() => {
          setConfirmRetry(false);
          const retry = pendingRetry.current;
          pendingRetry.current = null;
          retry?.();
        }}
      />
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
