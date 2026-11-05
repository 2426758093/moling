import { memo, useRef, useState } from "react";
import { api } from "../lib/api";
import { toast } from "../lib/notify";
import { CanvasNode, useCanvasStore } from "../stores/canvasStore";
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
} from "./Icons";
import { cn } from "./ui/cn";

interface NodeTarget {
  historyId: number;
  dataUrl: string;
  prompt: string;
}

function CanvasNodeCard({
  node,
  thumbUrl,
  selected,
  wireMode,
  wireArmed,
  onSelect,
  onWirePick,
}: {
  node: CanvasNode;
  thumbUrl?: string;
  selected: boolean;
  wireMode: boolean;
  wireArmed: boolean;
  onSelect: (id: string) => void;
  onWirePick: (id: string) => void;
}) {
  const updateNode = useCanvasStore((s) => s.updateNode);
  const removeNode = useCanvasStore((s) => s.removeNode);
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

  /// 编辑类动作都需要原图 + 提示词：按 id 取一次，失败统一提示
  const withTarget = async (action: (target: NodeTarget) => void) => {
    try {
      const [img, row] = await Promise.all([
        api.getHistoryImage(node.historyId),
        api.getHistoryItem(node.historyId),
      ]);
      action({
        historyId: node.historyId,
        dataUrl: img.dataUrl,
        prompt: row?.prompt ?? "",
      });
    } catch (e) {
      toast(`图片不可用：${String(e)}`, "error");
    }
  };

  const asReference = async () => {
    try {
      const img = await api.getHistoryImage(node.historyId);
      const ok = await useChatStore
        .getState()
        .addDataUrlAttachment(img.dataUrl, `画布图 #${node.historyId}`);
      if (ok) {
        useAppStore.getState().setView("chat");
        toast("已加入聊天参考图");
      }
    } catch (e) {
      toast(`添加参考图失败：${String(e)}`, "error");
    }
  };

  const reuseParams = async () => {
    try {
      const row = await api.getHistoryItem(node.historyId);
      if (!row) {
        toast("该作品已从画廊删除", "error");
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
      toast("已回填生成参数");
    } catch (e) {
      toast(`读取参数失败：${String(e)}`, "error");
    }
  };

  const editItems: MenuItem[] =
    editUnsupported || !caps.edit
      ? []
      : [
          {
            id: "inpaint",
            label: "局部重绘",
            icon: <IconBrush size={14} />,
            onSelect: () =>
              void withTarget((t) => {
                useAppStore.getState().openEditor({ ...t, mode: "inpaint" });
              }),
          },
          {
            id: "erase",
            label: "AI 消除",
            icon: <IconEraser size={14} />,
            onSelect: () =>
              void withTarget((t) => {
                useAppStore.getState().openEditor({ ...t, mode: "erase" });
              }),
          },
          {
            id: "outpaint",
            label: "扩图",
            icon: <IconExpand size={14} />,
            onSelect: () =>
              void withTarget((t) => {
                useAppStore.getState().openOutpaint(t);
              }),
          },
        ];

  const transformItems: MenuItem[] =
    transformUnsupported || !caps.transform
      ? []
      : [
          {
            id: "upscale",
            label: "高清放大",
            icon: <IconExpand size={14} />,
            onSelect: () =>
              void withTarget((t) => {
                useAppStore.getState().openTransform({ ...t, kind: "upscale" });
              }),
          },
          {
            id: "style",
            label: "风格转换",
            icon: <IconSparkle size={14} />,
            onSelect: () =>
              void withTarget((t) => {
                useAppStore.getState().openTransform({ ...t, kind: "style" });
              }),
          },
        ];

  const menuItems: MenuItem[] = [
    ...editItems,
    ...(expert
      ? [
          {
            id: "background",
            label: "换背景",
            icon: <IconPalette size={14} />,
            onSelect: () =>
              void withTarget((t) => {
                useAppStore.getState().openBackground(t);
              }),
          },
        ]
      : []),
    {
      id: "basic-edit",
      label: "基础编辑",
      icon: <IconCrop size={14} />,
      onSelect: () =>
        void withTarget((t) => {
          useAppStore.getState().openBasicEdit(t);
        }),
    },
    ...transformItems,
    {
      id: "reference",
      label: "用作参考图",
      icon: <IconQuote size={14} />,
      separatorBefore: true,
      onSelect: () => void asReference(),
    },
    {
      id: "reuse",
      label: "复用参数",
      icon: <IconCopy size={14} />,
      onSelect: () => void reuseParams(),
    },
    {
      id: "delete",
      label: "删除节点",
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
      aria-label={`画布节点：作品 #${node.historyId}`}
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
    >
      <SafeImg
        src={thumbUrl ?? ""}
        alt={`作品 #${node.historyId}`}
        className="pointer-events-none block aspect-square w-full rounded-card object-cover"
        draggable={false}
        loading="lazy"
        decoding="async"
      />
      <span className="glass-media pointer-events-none absolute left-2 top-2 rounded-pill px-2 py-0.5 text-caption text-on-accent">
        #{node.historyId}
      </span>
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
            aria-label="节点操作"
            className="glass-media pressable flex h-7 w-7 items-center justify-center rounded-pill text-on-accent hover:bg-on-accent/15"
          >
            <IconChevron direction="down" size={13} />
          </button>
        </DropdownMenu>
      </div>
      {wireArmed && (
        <span className="pointer-events-none absolute inset-x-2 bottom-2 rounded-pill bg-accent-fill px-2 py-0.5 text-center text-caption text-on-accent">
          点击另一个节点连线
        </span>
      )}
    </div>
  );
}

export default memo(CanvasNodeCard);
