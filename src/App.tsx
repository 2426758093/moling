import { useEffect } from "react";
import {
  AnimatePresence,
  MotionConfig,
  motion,
  useReducedMotion,
} from "framer-motion";
import Sidebar from "./components/Sidebar";
import ChatView from "./components/ChatView";
import GalleryView from "./components/GalleryView";
import CanvasView from "./components/CanvasView";
import QueueView from "./components/QueueView";
import SettingsView from "./components/SettingsView";
import SettingsRail from "./components/SettingsRail";
import EditorView from "./components/EditorView";
import OutpaintView from "./components/OutpaintView";
import TransformDialog from "./components/TransformDialog";
import BasicEditView from "./components/BasicEditView";
import BackgroundView from "./components/BackgroundView";
import { TooltipProvider } from "./components/ui/Tooltip";
import { useAppStore } from "./stores/appStore";
import { useChatStore } from "./stores/chatStore";
import { useProviderStore } from "./stores/providerStore";
import { useQueueStore } from "./stores/queueStore";
import { useCanvasStore } from "./stores/canvasStore";
import { api } from "./lib/api";
import { installCloseFlush } from "./lib/closeFlush";
import { validateImageFile } from "./lib/file";
import { applyGlassAppearance, applyThemeClass } from "./lib/theme";
import { maxReferenceImages } from "./lib/useModelCaps";
import { DUR, EASE } from "./lib/motion";
import { toast } from "./lib/notify";

function useApplyAppearance() {
  const theme = useAppStore((s) => s.theme);
  const glass = useAppStore((s) => s.glass);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      applyThemeClass(theme);
      applyGlassAppearance(glass);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme, glass]);
}

function AppShell() {
  useApplyAppearance();
  const view = useAppStore((s) => s.view);
  const editTarget = useAppStore((s) => s.editTarget);
  const outpaintTarget = useAppStore((s) => s.outpaintTarget);
  const basicEditTarget = useAppStore((s) => s.basicEditTarget);
  const backgroundTarget = useAppStore((s) => s.backgroundTarget);
  const addFileAttachment = useChatStore((s) => s.addFileAttachment);
  const setView = useAppStore((s) => s.setView);
  const reduce = useReducedMotion();

  // 减少动态：位移与淡入都必须停 —— framer-motion 的 reducedMotion="user" 只关
  // 位移不关透明度，所以这里显式分支，实际效果才和"减少动态"的承诺一致。
  const viewVariants = reduce
    ? { initial: { opacity: 1 }, animate: { opacity: 1 }, exit: { opacity: 1 } }
    : {
        initial: { opacity: 0, y: 8 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: -8 },
      };

  // 关闭前落盘（F-010）：画布保存有 600ms debounce，直接退出会丢掉最后一次编辑；
  // 离开画布视图时的 flush 只覆盖「切视图」，不覆盖「关窗口/关应用」。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    // StrictMode 会执行两次 effect：迟到的安装结果直接卸载，避免重复关闭处理器
    let cancelled = false;
    void installCloseFlush({
      flush: () => useCanvasStore.getState().flush(),
    })
      .then((off) => {
        if (cancelled) off();
        else unlisten = off;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    useProviderStore
      .getState()
      .refresh()
      .catch((e) => toast(`加载服务商失败：${String(e)}`, "error"));
    useChatStore
      .getState()
      .loadConversations()
      .catch(() => undefined);
    api
      .getSetting("defaultParams")
      .then((saved) => {
        if (!saved) return;
        try {
          const prefs = JSON.parse(saved);
          const { prefs: current, setPrefs } = useAppStore.getState();
          setPrefs({ ...current, ...prefs });
        } catch {
          // 忽略损坏的默认参数
        }
      })
      .catch(() => undefined);
    // 队列事件全局订阅：侧栏徽标与队列页共用同一份状态
    void (async () => {
      try {
        await useQueueStore.getState().subscribe();
        await useQueueStore.getState().load();
      } catch (e) {
        toast(`加载队列失败：${String(e)}`, "error");
      }
    })();
    return () => useQueueStore.getState().unsubscribe();
  }, []);

  return (
    <div
      className="flex h-full bg-base text-primary"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        const files = Array.from(e.dataTransfer.files ?? []).filter((f) =>
          f.type.startsWith("image/"),
        );
        if (files.length === 0) return;
        e.preventDefault();
        void (async () => {
          const limit = maxReferenceImages();
          const remaining = limit - useChatStore.getState().attachments.length;
          if (remaining <= 0) {
            toast(`最多添加 ${limit} 张参考图`, "error");
            return;
          }
          if (files.length > remaining) {
            toast(`最多添加 ${limit} 张参考图，已忽略多余文件`, "error");
          }
          for (const file of files.slice(0, remaining)) {
            const invalid = await validateImageFile(file);
            if (invalid) {
              toast(invalid, "error");
              continue;
            }
            if (!(await addFileAttachment(file))) break;
          }
          setView("chat");
        })();
      }}
    >
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 flex-col">
        <AnimatePresence mode="wait">
          <motion.div
            key={view}
            variants={viewVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={{ duration: reduce ? 0 : DUR.slow, ease: EASE.ios }}
            className="flex min-h-0 flex-1 flex-col"
          >
            {view === "chat" ? (
              <ChatView />
            ) : view === "gallery" ? (
              <GalleryView />
            ) : view === "canvas" ? (
              <CanvasView />
            ) : view === "queue" ? (
              <QueueView />
            ) : (
              <SettingsView />
            )}
          </motion.div>
        </AnimatePresence>
      </main>
      <SettingsRail />
      <AnimatePresence>{editTarget && <EditorView />}</AnimatePresence>
      <AnimatePresence>{outpaintTarget && <OutpaintView />}</AnimatePresence>
      <AnimatePresence>{basicEditTarget && <BasicEditView />}</AnimatePresence>
      <AnimatePresence>
        {backgroundTarget && <BackgroundView />}
      </AnimatePresence>
      <TransformDialog />
    </div>
  );
}

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <TooltipProvider delayDuration={500} skipDelayDuration={300}>
        <AppShell />
      </TooltipProvider>
    </MotionConfig>
  );
}
