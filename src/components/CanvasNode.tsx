import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useReducedMotion } from "framer-motion";
import { api } from "../lib/api";
import { deliverEditResult } from "../lib/deliverEditResult";
import { emitHistoryChanged } from "../lib/historyEvents";
import { toast } from "../lib/notify";
import { CanvasNode, useCanvasStore } from "../stores/canvasStore";
import {
  composeLayerInputs,
  effectiveLayers,
  hasOverlayLayers,
} from "../lib/canvasLayers";
import { useAppStore } from "../stores/appStore";
import { useChatStore } from "../stores/chatStore";
import { useProviderStore } from "../stores/providerStore";
import { useModelCaps } from "../lib/useModelCaps";
import SafeImg from "./SafeImg";
import { DropdownMenu, MenuItem } from "./ui/Menu";
import {
  IconBrush,
  IconChevron,
  IconCopy,
  IconCrop,
  IconEraser,
  IconExpand,
  IconPalette,
  IconQuote,
  IconSparkle,
  IconTrash,
  IconImage,
  IconLayers,
} from "./Icons";
import { cn } from "./ui/cn";

interface NodeTarget {
  historyId: number;
  dataUrl: string;
  prompt: string;
  width?: number;
  height?: number;
}

function CanvasNodeCard({
  node,
  thumbUrl,
  gif,
  selected,
  wireMode,
  wireArmed,
  onSelect,
  onWirePick,
}: {
  node: CanvasNode;
  thumbUrl?: string;
  /** 源文件是 GIF：缩略图为首帧，静图编辑入口需置灰 */
  gif?: boolean;
  selected: boolean;
  wireMode: boolean;
  wireArmed: boolean;
  onSelect: (id: string) => void;
  onWirePick: (id: string) => void;
}) {
  const { t } = useTranslation();
  const updateNode = useCanvasStore((s) => s.updateNode);
  const removeNode = useCanvasStore((s) => s.removeNode);
  const selectNode = useCanvasStore((s) => s.selectNode);
  const setLayerPanelOpen = useCanvasStore((s) => s.setLayerPanelOpen);
  const expert = useAppStore((s) => s.mode) === "expert";
  const caps = useModelCaps();
  const editUnsupported = useProviderStore((s) => {
    const current = s.providers.find(
      (p) => p.provider.id === s.defaultProviderId,
    );
    return (
      current?.provider.kind === "template" &&
      current.provider.editTemplateUrl.trim() === ""
    );
  });
  const transformUnsupported = useProviderStore((s) => {
    const current = s.providers.find(
      (p) => p.provider.id === s.defaultProviderId,
    );
    return (
      current?.provider.kind === "template" &&
      current.provider.transformTemplateUrl.trim() === ""
    );
  });

  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const reduceMotion = useReducedMotion() ?? false;
  const [hovered, setHovered] = useState(false);
  const [manualPlay, setManualPlay] = useState(false);
  const [fullGifUrl, setFullGifUrl] = useState<string | null>(null);
  // 动图只在悬停 / 选中时加载全尺寸文件；减少动态时需用户显式点击角标
  const shouldPlay =
    Boolean(gif) && (reduceMotion ? manualPlay : hovered || selected);

  useEffect(() => {
    if (!shouldPlay || fullGifUrl) return;
    let alive = true;
    api
      .getHistoryImage(node.historyId)
      .then((img) => {
        if (alive) setFullGifUrl(img.dataUrl);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [shouldPlay, fullGifUrl, node.historyId]);

  const pointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelect(node.id);
    if (wireMode) {
      onWirePick(node.id);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      x: node.x,
      y: node.y,
    };
    setDragging(true);
  };

  const pointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const zoom = useCanvasStore.getState().viewport.zoom;
    updateNode(node.id, {
      x: d.x + (e.clientX - d.startX) / zoom,
      y: d.y + (e.clientY - d.startY) / zoom,
    });
  };

  const pointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  /// 编辑类动作都需要原图 + 提示词：多层节点先合成当前画面，再交给编辑器
  const withTarget = async (action: (target: NodeTarget) => void) => {
    try {
      const [dataUrl, row] = await Promise.all([
        hasOverlayLayers(node)
          ? api
              .composeCanvasNode({
                baseHistoryId: node.historyId,
                layers: composeLayerInputs(node),
              })
              .then((out) => out.dataUrl)
          : api.getHistoryImage(node.historyId).then((img) => img.dataUrl),
        api.getHistoryItem(node.historyId),
      ]);
      action({
        historyId: node.historyId,
        dataUrl,
        prompt: row?.prompt ?? "",
        ...(row ? { width: row.width, height: row.height } : {}),
      });
    } catch (e) {
      toast(t("图片不可用：{{error}}", { error: String(e) }), "error");
    }
  };

  const asReference = async () => {
    try {
      const img = await api.getHistoryImage(node.historyId);
      const ok = await useChatStore
        .getState()
        .addDataUrlAttachment(
          img.dataUrl,
          t("画布图 #{{id}}", { id: node.historyId }),
        );
      if (ok) {
        useAppStore.getState().setView("chat");
        toast(t("已加入聊天参考图"));
      }
    } catch (e) {
      toast(t("添加参考图失败：{{error}}", { error: String(e) }), "error");
    }
  };

  const reuseParams = async () => {
    try {
      const row = await api.getHistoryItem(node.historyId);
      if (!row) {
        toast(t("该作品已从画廊删除"), "error");
        return;
      }
      useAppStore.getState().setPrefs({
        ratio: "custom",
        width: row.width,
        height: row.height,
        style: row.style,
        count: 1,
        negativePrompt: row.negativePrompt,
      });
      useChatStore.getState().setDraftPrompt(row.prompt);
      useAppStore.getState().setView("chat");
      toast(t("已回填生成参数"));
    } catch (e) {
      toast(t("读取参数失败：{{error}}", { error: String(e) }), "error");
    }
  };

  // 动图的静图编辑会把动画压成单帧，统一置灰并说明出口
  const gifHint = t("动图请用动图编辑器或单帧修复");
  const gifBlocked = (item: MenuItem): MenuItem =>
    gif ? { ...item, disabled: true, hint: gifHint } : item;

  const editItems: MenuItem[] =
    editUnsupported || !caps.edit
      ? []
      : [
          gifBlocked({
            id: "inpaint",
            label: t("局部重绘"),
            icon: <IconBrush size={14} />,
            onSelect: () =>
              void withTarget((target) => {
                useAppStore
                  .getState()
                  .openEditor({ ...target, mode: "inpaint", host: "canvas" });
              }),
          }),
          gifBlocked({
            id: "erase",
            label: t("AI 消除"),
            icon: <IconEraser size={14} />,
            onSelect: () =>
              void withTarget((target) => {
                useAppStore
                  .getState()
                  .openEditor({ ...target, mode: "erase", host: "canvas" });
              }),
          }),
          gifBlocked({
            id: "outpaint",
            label: t("扩图"),
            icon: <IconExpand size={14} />,
            onSelect: () =>
              void withTarget((target) => {
                useAppStore
                  .getState()
                  .openOutpaint({ ...target, host: "canvas" });
              }),
          }),
        ];

  const transformItems: MenuItem[] =
    transformUnsupported || !caps.transform
      ? []
      : [
          gifBlocked({
            id: "upscale",
            label: t("高清放大"),
            icon: <IconExpand size={14} />,
            onSelect: () =>
              void withTarget((target) => {
                useAppStore.getState().openTransform({
                  ...target,
                  kind: "upscale",
                  host: "canvas",
                });
              }),
          }),
          gifBlocked({
            id: "style",
            label: t("风格转换"),
            icon: <IconSparkle size={14} />,
            onSelect: () =>
              void withTarget((target) => {
                useAppStore
                  .getState()
                  .openTransform({ ...target, kind: "style", host: "canvas" });
              }),
          }),
        ];

  /// 转静图：首帧另存 PNG，作为子节点落回画布（连线沿用编辑结果的规则）
  const convertToStatic = async () => {
    try {
      const out = await api.convertAnimationToStatic(node.historyId);
      await deliverEditResult(
        { historyId: node.historyId, host: "canvas" },
        out,
        t("已转静图"),
      );
      emitHistoryChanged();
    } catch (e) {
      toast(t("转静图失败：{{error}}", { error: String(e) }), "error");
    }
  };

  const menuItems: MenuItem[] = [
    ...editItems,
    ...(expert
      ? [
          gifBlocked({
            id: "background",
            label: t("换背景"),
            icon: <IconPalette size={14} />,
            onSelect: () =>
              void withTarget((target) => {
                useAppStore
                  .getState()
                  .openBackground({ ...target, host: "canvas" });
              }),
          }),
        ]
      : []),
    gifBlocked({
      id: "basic-edit",
      label: t("基础编辑"),
      icon: <IconCrop size={14} />,
      onSelect: () =>
        void withTarget((target) => {
          useAppStore.getState().openBasicEdit({ ...target, host: "canvas" });
        }),
    }),
    ...transformItems,
    ...(!editUnsupported && caps.edit
      ? [
          gifBlocked({
            id: "region",
            label: t("分区重绘"),
            icon: <IconLayers size={14} />,
            separatorBefore: true,
            onSelect: () =>
              void withTarget((target) => {
                useAppStore.getState().openRegionEdit({
                  nodeId: node.id,
                  baseHistoryId: node.historyId,
                  dataUrl: target.dataUrl,
                  host: "canvas",
                });
              }),
          }),
        ]
      : []),
    ...(gif
      ? [
          {
            id: "animation",
            label: t("打开动图编辑器"),
            icon: <IconImage size={14} />,
            onSelect: () =>
              useAppStore
                .getState()
                .openAnimation({ historyId: node.historyId, host: "canvas" }),
          },
          {
            id: "to-static",
            label: t("转静图（取首帧）"),
            icon: <IconCrop size={14} />,
            onSelect: () => void convertToStatic(),
          },
        ]
      : []),
    {
      id: "layers",
      label: t("图层"),
      icon: <IconLayers size={14} />,
      separatorBefore: true,
      ...(gif
        ? {
            disabled: true,
            hint: t("动图不支持图层"),
            onSelect: () => {},
          }
        : {
            onSelect: () => {
              selectNode(node.id);
              setLayerPanelOpen(true);
            },
          }),
    },
    {
      id: "reference",
      label: t("用作参考图"),
      icon: <IconQuote size={14} />,
      separatorBefore: true,
      onSelect: () => void asReference(),
    },
    {
      id: "reuse",
      label: t("复用参数"),
      icon: <IconCopy size={14} />,
      onSelect: () => void reuseParams(),
    },
    {
      id: "delete",
      label: t("删除节点"),
      icon: <IconTrash size={14} />,
      danger: true,
      separatorBefore: true,
      onSelect: () => removeNode(node.id),
    },
  ];

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={t("画布节点：作品 #{{id}}", { id: node.historyId })}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerUp}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(node.id);
        }
      }}
      className={cn(
        "group absolute select-none rounded-card border bg-elevated shadow-card outline-none transition-shadow",
        selected || wireArmed
          ? "border-transparent ring-2 ring-accent"
          : "border-line",
        wireMode
          ? "cursor-crosshair"
          : dragging
            ? "cursor-grabbing"
            : "cursor-grab",
      )}
      style={{ left: node.x, top: node.y, width: node.width }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <SafeImg
        src={shouldPlay && fullGifUrl ? fullGifUrl : (thumbUrl ?? "")}
        alt={t("作品 #{{id}}", { id: node.historyId })}
        className="pointer-events-none block aspect-square w-full rounded-card object-cover"
        draggable={false}
        loading="lazy"
        decoding="async"
      />
      <span className="glass-media pointer-events-none absolute left-2 top-2 rounded-pill px-2 py-0.5 text-caption text-on-accent">
        #{node.historyId}
      </span>
      {gif &&
        (reduceMotion ? (
          <button
            type="button"
            aria-pressed={manualPlay}
            aria-label={t("播放动图")}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setManualPlay((v) => !v);
            }}
            className="glass-media pressable absolute bottom-2 left-2 rounded-pill px-2 py-0.5 text-caption text-on-accent"
          >
            {manualPlay ? t("暂停动图") : t("播放动图")}
          </button>
        ) : (
          <span className="glass-media pointer-events-none absolute bottom-2 left-2 rounded-pill px-2 py-0.5 text-caption text-on-accent">
            {t("动图")}
          </span>
        ))}
      {(node.layers?.length ?? 0) > 1 && (
        <span className="glass-media pointer-events-none absolute bottom-2 right-2 rounded-pill px-2 py-0.5 text-caption text-on-accent">
          {t("{{count}} 层", { count: effectiveLayers(node).length })}
        </span>
      )}
      <div
        className={cn(
          "absolute right-2 top-2 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100",
          selected && "opacity-100",
        )}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <DropdownMenu items={menuItems} align="end">
          <button
            type="button"
            aria-label={t("节点操作")}
            className="glass-media pressable flex h-7 w-7 items-center justify-center rounded-pill text-on-accent hover:bg-on-accent/15"
          >
            <IconChevron direction="down" size={13} />
          </button>
        </DropdownMenu>
      </div>
      {wireArmed && (
        <span className="pointer-events-none absolute inset-x-2 bottom-2 rounded-pill bg-accent-fill px-2 py-0.5 text-center text-caption text-on-accent">
          {t("点击另一个节点连线")}
        </span>
      )}
    </div>
  );
}

export default memo(CanvasNodeCard);
