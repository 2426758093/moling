import { useEffect, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { api, parseAdapterError } from "../../../lib/api";
import type {
  RetouchActionId,
  RetouchGateReason,
} from "../../../lib/retouchActions";
import { toast } from "../../../lib/notify";
import type { MaskCanvasHandle } from "../../MaskCanvas";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Field";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { ColorField } from "../../ui/ColorField";
import MaskTools from "./MaskTools";

export interface BackgroundOptions {
  kind: "solid" | "gradient" | "ai";
  color: string;
  colorFrom: string;
  colorTo: string;
  direction: "horizontal" | "vertical" | "diagonal";
  prompt: string;
}

interface Props {
  /** 云门禁原因（GIF/离线/无服务商等）；本地模式不受它影响 */
  reason: RetouchGateReason | null;
  busy: RetouchActionId | null;
  src: string;
  maskRef: RefObject<MaskCanvasHandle | null>;
  brushSize: number;
  onBrushSizeChange: (value: number) => void;
  eraser: boolean;
  onEraserChange: (value: boolean) => void;
  onClearMask: () => void;
  /** provider + defaultModel 都在位 */
  aiAvailable: boolean;
  /** AI 描述不可用时的原因：请先在设置中配置服务商 / 请先在设置中选择默认模型 */
  aiReason: RetouchGateReason | null;
  onConfirm: (options: BackgroundOptions) => void;
}

/// 换背景面板：蒙版复用公用画笔工具，纯色 / 渐变本地合成，AI 描述走服务商。
/// 只负责收集参数；提交（含落库与计费保护）交给 RetouchView。
export default function BackgroundPanel({
  reason,
  busy,
  src,
  maskRef,
  brushSize,
  onBrushSizeChange,
  eraser,
  onEraserChange,
  onClearMask,
  aiAvailable,
  aiReason,
  onConfirm,
}: Props) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<BackgroundOptions["kind"]>("solid");
  const [color, setColor] = useState("#f5f5f7");
  const [from, setFrom] = useState("#ff9a8b");
  const [to, setTo] = useState("#6a85ff");
  const [direction, setDirection] =
    useState<BackgroundOptions["direction"]>("horizontal");
  const [prompt, setPrompt] = useState("");
  // 智能蒙版：设置关闭或模型不可用时隐藏入口，行为回到手动画笔
  const [smartReady, setSmartReady] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void api
      .getSetting("smartMask")
      .then((value) => {
        if (!alive || value === "off") return undefined;
        return api
          .segmentModelStatus()
          .then((status) => {
            if (alive) setSmartReady(status.available);
          })
          .catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // 动图连本地合成都做不了：整个面板禁用，原因照常在下方写一行
  const gif = reason === "动图暂不支持修图";
  const busyAny = busy != null;
  // AI 模式必须同时具备服务商、默认模型与描述；纯色 / 渐变永远可提交
  const aiBlocked =
    kind === "ai" && (!!reason || !aiAvailable || prompt.trim() === "");

  const autoSelect = async () => {
    if (autoBusy || busyAny) return;
    setAutoBusy(true);
    try {
      // invert：主体之外 = 要替换的背景
      const out = await api.segmentSubject(src, true);
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

  return (
    <section className="flex flex-col gap-3 p-3" aria-label={t("换背景")}>
      <header className="flex flex-col gap-0.5">
        <h2 className="text-title3 text-primary">{t("换背景")}</h2>
        <p className="text-footnote text-tertiary">
          {t("涂抹要替换的背景区域，也可先「自动选中背景」再修整")}
        </p>
      </header>

      <MaskTools
        brushSize={brushSize}
        onBrushSizeChange={onBrushSizeChange}
        eraser={eraser}
        onEraserChange={onEraserChange}
        onClear={onClearMask}
        disabled={gif || busyAny}
        min={8}
        max={200}
        fillLabel="全选背景"
        onFillAll={() => maskRef.current?.fillAll()}
        autoLabel="自动选中背景"
        autoBusy={autoBusy}
        onAutoSelect={smartReady ? () => void autoSelect() : undefined}
      />

      <SegmentedControl
        label={t("背景类型")}
        value={kind}
        onValueChange={setKind}
        size="sm"
        options={[
          { value: "solid", label: t("纯色"), disabled: gif },
          { value: "gradient", label: t("渐变"), disabled: gif },
          { value: "ai", label: t("AI 描述"), disabled: gif },
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
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
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
          </div>
          <SegmentedControl
            label={t("渐变方向")}
            value={direction}
            onValueChange={setDirection}
            size="sm"
            options={[
              { value: "horizontal", label: t("水平"), disabled: gif },
              { value: "vertical", label: t("垂直"), disabled: gif },
              { value: "diagonal", label: t("对角"), disabled: gif },
            ]}
          />
        </div>
      )}

      {kind === "ai" && (
        <Input
          compact
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t("描述想要的背景，例如：星空下的霓虹城市…")}
          aria-label={t("背景描述")}
          disabled={gif || busyAny}
        />
      )}

      {kind === "ai" && aiReason && (
        <p className="text-footnote text-tertiary">{t(aiReason)}</p>
      )}
      {reason && <p className="text-footnote text-tertiary">{t(reason)}</p>}

      <Button
        variant="primary"
        size="sm"
        block
        loading={busy === "background"}
        disabled={gif || (busyAny && busy !== "background") || aiBlocked}
        onClick={() =>
          onConfirm({
            kind,
            color,
            colorFrom: from,
            colorTo: to,
            direction,
            prompt,
          })
        }
      >
        {t("应用换背景")}
      </Button>
    </section>
  );
}
