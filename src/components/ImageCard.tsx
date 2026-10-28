import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { ChatImage, useChatStore } from "../stores/chatStore";
import { useAppStore } from "../stores/appStore";
import { useProviderStore } from "../stores/providerStore";
import { api } from "../lib/api";
import { extOf } from "../lib/image";
import ImageViewer, { ViewerImage } from "./ImageViewer";
import ContextMenu, { MenuItem } from "./ContextMenu";
import SafeImg from "./SafeImg";
import {
  IconDownload,
  IconCopy,
  IconQuote,
  IconBrush,
  IconEraser,
  IconExpand,
  IconTrash,
  IconChevron,
} from "./Icons";

let viewerSeq = 0;

export default function ImageCard({
  image,
  siblings,
  prompt,
}: {
  image: ChatImage;
  siblings: ChatImage[];
  prompt: string;
}) {
  const addAttachment = useChatStore((s) => s.addAttachment);
  const openEditor = useAppStore((s) => s.openEditor);
  const openOutpaint = useAppStore((s) => s.openOutpaint);
  // 模板适配器没有编辑端点：隐藏入口，避免用户点进去才收到「暂不支持」
  const isTemplateProvider = useProviderStore((s) => {
    const current = s.providers.find(
      (p) => p.provider.id === s.defaultProviderId,
    );
    return current?.provider.kind === "template";
  });
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current !== null)
        window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const download = () => {
    const a = document.createElement("a");
    a.href = image.dataUrl;
    // 用真实扩展名：mock/模板服务商可能出 SVG，固定 .png 会导致双击打不开
    a.download = `moling_${image.historyId}.${extOf(image.path ?? "")}`;
    a.click();
  };

  const copyPrompt = async () => {
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
  };

  const reference = () => {
    addAttachment({
      id: `ref-${image.historyId}-${++viewerSeq}`,
      dataUrl: image.dataUrl,
      name: `引用图 #${image.historyId}`,
    });
  };

  const removeImage = async () => {
    await api.deleteHistory(image.historyId).catch(() => undefined);
    useChatStore.setState((s) => ({
      messages: s.messages.map((m) => ({
        ...m,
        images: m.images.filter((i) => i.historyId !== image.historyId),
      })),
    }));
  };

  const baseTarget = {
    historyId: image.historyId,
    dataUrl: image.dataUrl,
    prompt,
  };

  const editItems: MenuItem[] = isTemplateProvider
    ? []
    : [
        {
          label: "局部重绘",
          icon: <IconBrush size={14} />,
          onClick: () => openEditor({ ...baseTarget, mode: "inpaint" }),
        },
        {
          label: "AI 消除",
          icon: <IconEraser size={14} />,
          onClick: () => openEditor({ ...baseTarget, mode: "erase" }),
        },
        {
          label: "扩图",
          icon: <IconExpand size={14} />,
          onClick: () => openOutpaint(baseTarget),
        },
      ];

  const menuItems: MenuItem[] = [
    {
      label: copied ? "已复制提示词" : "复制提示词",
      icon: <IconCopy size={14} />,
      onClick: copyPrompt,
    },
    {
      label: "引用为参考图",
      icon: <IconQuote size={14} />,
      onClick: reference,
    },
    ...editItems,
    { label: "下载", icon: <IconDownload size={14} />, onClick: download },
    {
      label: "删除",
      icon: <IconTrash size={14} />,
      danger: true,
      onClick: removeImage,
    },
  ];

  const viewerImages: ViewerImage[] = siblings.map((i) => ({
    dataUrl: i.dataUrl,
    title: prompt,
  }));

  const openViewer = () =>
    setViewerIndex(siblings.findIndex((i) => i.historyId === image.historyId));

  return (
    <>
      <motion.div
        layout
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.24, ease: [0.25, 0.1, 0.25, 1] }}
        role="button"
        tabIndex={0}
        aria-label={`查看大图：${prompt}`}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openViewer();
          }
        }}
        className="group relative cursor-zoom-in overflow-hidden rounded-[var(--radius-card)] shadow-card"
        onClick={openViewer}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenuPos({ x: e.clientX, y: e.clientY });
        }}
      >
        <SafeImg
          src={image.dataUrl}
          alt={prompt}
          className="block w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.02]"
        />
        <div className="absolute inset-0 flex items-end justify-between bg-gradient-to-t from-black/50 via-black/0 to-black/0 p-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <button
            onClick={(e) => {
              e.stopPropagation();
              download();
            }}
            className="pressable flex items-center gap-1 rounded-full bg-white/20 px-2.5 py-1 text-[11px] text-white backdrop-blur-md transition-colors duration-150 hover:bg-white/35"
          >
            <IconDownload size={12} />
            下载
          </button>
          <button
            title="更多操作"
            aria-label="更多操作"
            onClick={(e) => {
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              setMenuPos({ x: rect.right - 192, y: rect.bottom + 4 });
            }}
            className="pressable rounded-full bg-white/20 p-1.5 text-white backdrop-blur-md transition-colors duration-150 hover:bg-white/35"
          >
            <IconChevron direction="down" size={13} />
          </button>
        </div>
      </motion.div>
      {menuPos && (
        <ContextMenu
          x={menuPos.x}
          y={menuPos.y}
          items={menuItems}
          onClose={() => setMenuPos(null)}
        />
      )}
      {viewerIndex !== null &&
        createPortal(
          <ImageViewer
            images={viewerImages}
            index={viewerIndex}
            onIndexChange={setViewerIndex}
            onClose={() => setViewerIndex(null)}
          />,
          document.body,
        )}
    </>
  );
}
