import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { ChatImage, useChatStore } from "../stores/chatStore";
import { useAppStore } from "../stores/appStore";
import { useProviderStore } from "../stores/providerStore";
import { api } from "../lib/api";
import { extOf } from "../lib/image";
import { useModelCaps } from "../lib/useModelCaps";
import { DUR, EASE } from "../lib/motion";
import { toast } from "../lib/notify";
import ImageViewer, { ViewerImage } from "./ImageViewer";
import { ContextMenu, DropdownMenu, MenuItem } from "./ui/Menu";
import SafeImg from "./SafeImg";
import {
  IconDownload,
  IconCopy,
  IconQuote,
  IconBrush,
  IconEraser,
  IconExpand,
  IconSparkle,
  IconTrash,
  IconChevron,
  IconCrop,
  IconPalette,
} from "./Icons";

export default function ImageCard({
  image,
  siblings,
  prompt,
  messageId,
}: {
  image: ChatImage;
  siblings: ChatImage[];
  prompt: string;
  /** 所属消息 id：删除必须落库，否则刷新后图片又回来 */
  messageId: number;
}) {
  const addDataUrlAttachment = useChatStore((s) => s.addDataUrlAttachment);
  const openEditor = useAppStore((s) => s.openEditor);
  const openOutpaint = useAppStore((s) => s.openOutpaint);
  const openTransform = useAppStore((s) => s.openTransform);
  const openBasicEdit = useAppStore((s) => s.openBasicEdit);
  const openBackground = useAppStore((s) => s.openBackground);
  const expert = useAppStore((s) => s.mode) === "expert";
  // 模板服务商只有在配置了编辑模板后才有编辑端点；否则隐藏入口，
  // 避免用户点进去才收到「未配置编辑模板」
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
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
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
    // 生成图可能很大：走 dataUrl 入口统一按需压缩
    void addDataUrlAttachment(
      image.dataUrl,
      `引用图 #${image.historyId}`,
    ).catch(() => toast("添加参考图失败", "error"));
  };

  const removeLocal = () =>
    useChatStore.setState((s) => ({
      messages: s.messages.map((m) => ({
        ...m,
        images: m.images.filter((i) => i.historyId !== image.historyId),
      })),
    }));

  /// 删除：先落库再更新本地，失败时不乐观移除（否则刷新后又出现）
  const removeImage = async () => {
    if (messageId <= 0) {
      // 尚未落库的本地消息（负 id）：只有内存状态可改
      removeLocal();
      return;
    }
    try {
      await api.removeMessageImage(messageId, image.historyId);
      removeLocal();
    } catch (e) {
      toast(`删除失败：${String(e)}`, "error");
    }
  };

  const baseTarget = {
    historyId: image.historyId,
    dataUrl: image.dataUrl,
    prompt,
  };

  const editItems: MenuItem[] =
    editUnsupported || !caps.edit
      ? []
      : [
          {
            id: "inpaint",
            label: "局部重绘",
            icon: <IconBrush size={14} />,
            onSelect: () => openEditor({ ...baseTarget, mode: "inpaint" }),
          },
          {
            id: "erase",
            label: "AI 消除",
            icon: <IconEraser size={14} />,
            onSelect: () => openEditor({ ...baseTarget, mode: "erase" }),
          },
          {
            id: "outpaint",
            label: "扩图",
            icon: <IconExpand size={14} />,
            onSelect: () => openOutpaint(baseTarget),
          },
        ];

  // 放大 / 风格转换：服务商有变换端点（模板未配置时隐藏），且模型能力允许
  const transformItems: MenuItem[] =
    transformUnsupported || !caps.transform
      ? []
      : [
          {
            id: "upscale",
            label: "高清放大",
            icon: <IconExpand size={14} />,
            onSelect: () => openTransform({ ...baseTarget, kind: "upscale" }),
          },
          {
            id: "style",
            label: "风格转换",
            icon: <IconSparkle size={14} />,
            onSelect: () => openTransform({ ...baseTarget, kind: "style" }),
          },
        ];

  const menuItems: MenuItem[] = [
    {
      id: "copy",
      label: copied ? "已复制提示词" : "复制提示词",
      icon: <IconCopy size={14} />,
      onSelect: copyPrompt,
    },
    {
      id: "reference",
      label: "引用为参考图",
      icon: <IconQuote size={14} />,
      onSelect: reference,
    },
    ...editItems,
    // 换背景属于进阶功能：简单模式下不展示
    ...(expert
      ? [
          {
            id: "background",
            label: "换背景",
            icon: <IconPalette size={14} />,
            onSelect: () => openBackground(baseTarget),
          },
        ]
      : []),
    {
      id: "basic-edit",
      label: "基础编辑",
      icon: <IconCrop size={14} />,
      onSelect: () => openBasicEdit(baseTarget),
    },
    ...transformItems,
    {
      id: "download",
      label: "下载",
      icon: <IconDownload size={14} />,
      separatorBefore: true,
      onSelect: download,
    },
    {
      id: "delete",
      label: "删除",
      icon: <IconTrash size={14} />,
      danger: true,
      onSelect: removeImage,
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
      <ContextMenu items={menuItems}>
        <motion.div
          layout
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: DUR.base, ease: EASE.ios }}
          className="group relative overflow-hidden rounded-card shadow-card"
        >
          {/* 查看大图是可聚焦按钮，操作条是它的兄弟节点 —— 不再嵌套可交互元素 */}
          <button
            type="button"
            onClick={openViewer}
            aria-label={`查看大图：${prompt}`}
            className="block w-full cursor-zoom-in"
          >
            <SafeImg
              src={image.dataUrl}
              alt={prompt}
              className="block w-full object-cover transition-transform duration-300 ease-ios group-hover:scale-[1.015]"
            />
          </button>
          {image.derivedFrom !== undefined && (
            <span className="glass-media pointer-events-none absolute left-2 top-2 rounded-pill px-2 py-0.5 text-caption text-on-accent">
              派生自 #{image.derivedFrom}
            </span>
          )}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 p-2 opacity-0 transition-opacity duration-200 group-focus-within:opacity-100 group-hover:opacity-100">
            <div className="glass-media pointer-events-auto flex items-center gap-0.5 rounded-pill p-0.5">
              <button
                type="button"
                onClick={download}
                className="pressable flex items-center gap-1 rounded-pill px-2.5 py-1 text-footnote text-on-accent transition-colors hover:bg-on-accent/15"
              >
                <IconDownload size={12} />
                下载
              </button>
            </div>
            <DropdownMenu items={menuItems} align="end">
              <button
                type="button"
                aria-label="更多操作"
                className="glass-media pressable pointer-events-auto flex h-7 w-7 items-center justify-center rounded-pill text-on-accent hover:bg-on-accent/15"
              >
                <IconChevron direction="down" size={13} />
              </button>
            </DropdownMenu>
          </div>
        </motion.div>
      </ContextMenu>
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
