import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "./i18n";
import {
  AnimatePresence,
  MotionConfig,
  motion,
  useReducedMotion,
} from "framer-motion";
import Sidebar from "./components/Sidebar";
import NavRail from "./components/shell/NavRail";
import Inspector from "./components/Inspector";
import ChatView from "./components/ChatView";
import GalleryView from "./components/GalleryView";
import CanvasView from "./components/CanvasView";
import RetouchView from "./components/retouch/RetouchView";
import QueueView from "./components/QueueView";
import SettingsView from "./components/SettingsView";
import EditorView from "./components/EditorView";
import OutpaintView from "./components/OutpaintView";
import TransformDialog from "./components/TransformDialog";
import BasicEditView from "./components/BasicEditView";
import BackgroundView from "./components/BackgroundView";
import AnimationView from "./components/AnimationView";
import { TooltipProvider } from "./components/ui/Tooltip";
import { CommandPalette } from "./components/ui/CommandPalette";
import { ConfirmDialog } from "./components/ui/Dialog";
import TitleBar from "./components/shell/TitleBar";
import ResizeHandles from "./components/shell/ResizeHandles";
import ShortcutsSheet from "./components/shell/ShortcutsSheet";
import DropOverlay from "./components/shell/DropOverlay";
import UpdateDialog from "./components/shell/UpdateDialog";
import { useWindowState } from "./hooks/useWindowState";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { sanitizePrefs, useAppStore } from "./stores/appStore";
import { useChatStore } from "./stores/chatStore";
import { useProviderStore } from "./stores/providerStore";
import { useQueueStore } from "./stores/queueStore";
import { useCanvasStore } from "./stores/canvasStore";
import { useUpdateStore } from "./stores/updateStore";
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
  const { t } = useTranslation();
  useApplyAppearance();
  useGlobalShortcuts();
  const view = useAppStore((s) => s.view);
  const editTarget = useAppStore((s) => s.editTarget);
  const outpaintTarget = useAppStore((s) => s.outpaintTarget);
  const basicEditTarget = useAppStore((s) => s.basicEditTarget);
  const backgroundTarget = useAppStore((s) => s.backgroundTarget);
  const animationTarget = useAppStore((s) => s.animationTarget);
  const canvasInline = useAppStore((s) => s.canvasInline);
  const addFileAttachment = useChatStore((s) => s.addFileAttachment);
  const setView = useAppStore((s) => s.setView);
  const reduce = useReducedMotion();
  const { isMaximized, platform } = useWindowState();
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const closeConfirmResolve = useRef<((close: boolean) => void) | null>(null);

  // 关闭确认：只有停留在画布视图且画布有未保存改动时才询问，其它情况静默落盘。
  // 确认按钮沿用 ConfirmDialog 的既有顺序（先 onOpenChange(false) 再 onConfirm），
  // 因此取消侧延到微任务落定，让 onConfirm 先决定结果。
  const confirmClose = useCallback((): Promise<boolean> => {
    const inCanvas = useAppStore.getState().view === "canvas";
    const dirty = useCanvasStore.getState().dirty;
    if (!inCanvas || !dirty) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      closeConfirmResolve.current = resolve;
      setCloseConfirmOpen(true);
    });
  }, []);

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
      confirm: confirmClose,
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
  }, [confirmClose]);

  useEffect(() => {
    useProviderStore
      .getState()
      .refresh()
      .catch((e) =>
        toast(
          i18n.t("加载服务商失败：{{error}}", { error: String(e) }),
          "error",
        ),
      );
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
          const { setPrefs } = useAppStore.getState();
          setPrefs(sanitizePrefs(prefs));
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
        // 自动续跑只处理排队任务；中断任务仍需用户显式恢复（避免重复扣费）
        const autoResume = await api
          .getSetting("queueAutoResume")
          .catch(() => null);
        if (autoResume === "on") await useQueueStore.getState().start(true);
      } catch (e) {
        // 订阅只在挂载时执行一次，用全局实例翻译，避免把 t 加进依赖
        toast(i18n.t("加载队列失败：{{error}}", { error: String(e) }), "error");
      }
    })();
    // 启动静默检查更新：离线/未配置不打扰，有更新才弹窗
    void useUpdateStore
      .getState()
      .subscribe()
      .then(() => useUpdateStore.getState().check(false))
      .catch(() => undefined);
    return () => {
      useQueueStore.getState().unsubscribe();
      useUpdateStore.getState().unsubscribe();
    };
  }, []);

  // 画布入口的编辑以内嵌面板渲染在 CanvasView 里，不再盖住整屏；
  // 离开画布时关闭这些目标，避免返回其他视图时突然弹出全屏编辑器。
  const overlayVisible = (target: { host?: "canvas" } | null) =>
    !!target && !(canvasInline && target.host === "canvas");
  // 编辑器占用内容面时，收起会话面板与检查器，把整张纸让给舞台
  const editing =
    overlayVisible(editTarget) ||
    overlayVisible(outpaintTarget) ||
    overlayVisible(basicEditTarget) ||
    overlayVisible(backgroundTarget) ||
    overlayVisible(animationTarget);
  const showSidebar = view === "chat" && !editing;
  const showInspector = view === "chat" && !editing;
  useEffect(() => {
    if (view === "canvas") return;
    const app = useAppStore.getState();
    if (app.editTarget?.host === "canvas") app.closeEditor();
    if (app.outpaintTarget?.host === "canvas") app.closeOutpaint();
    if (app.transformTarget?.host === "canvas") app.closeTransform();
    if (app.basicEditTarget?.host === "canvas") app.closeBasicEdit();
    if (app.backgroundTarget?.host === "canvas") app.closeBackground();
    if (app.animationTarget?.host === "canvas") app.closeAnimation();
    // 修图台没有 host 字段：内嵌标记本身就说明它挂在画布上
    if (app.retouchTarget?.embedded) app.closeRetouch();
  }, [view]);

  return (
    <div
      className="window-plane flex h-full flex-col text-primary"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        dragDepth.current = 0;
        setDragging(false);
        const files = Array.from(e.dataTransfer.files ?? []).filter((f) =>
          f.type.startsWith("image/"),
        );
        if (files.length === 0) return;
        e.preventDefault();
        void (async () => {
          const limit = maxReferenceImages();
          const remaining = limit - useChatStore.getState().attachments.length;
          if (remaining <= 0) {
            toast(t("最多添加 {{limit}} 张参考图", { limit }), "error");
            return;
          }
          if (files.length > remaining) {
            toast(
              t("最多添加 {{limit}} 张参考图，已忽略多余文件", { limit }),
              "error",
            );
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
      <div className="ambient" aria-hidden />
      <TitleBar isMaximized={isMaximized} platform={platform} />

      <div className="relative z-10 flex min-h-0 flex-1 pt-12">
        <NavRail />
        {showSidebar && <Sidebar />}
        <main className="flex min-w-0 flex-1 flex-col p-2">
          <div className="content-sheet relative flex min-h-0 flex-1 flex-col">
            {/* 新旧视图叠放交叉淡入：wait 模式会先退场再入场，切页中间有 300ms 空屏 */}
            <AnimatePresence>
              <motion.div
                key={view}
                variants={viewVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={{ duration: reduce ? 0 : DUR.base, ease: EASE.ios }}
                className="absolute inset-0 flex min-h-0 flex-col"
              >
                {view === "chat" ? (
                  <ChatView />
                ) : view === "gallery" ? (
                  <GalleryView />
                ) : view === "canvas" ? (
                  <CanvasView />
                ) : view === "queue" ? (
                  <QueueView />
                ) : view === "retouch" ? (
                  <RetouchView />
                ) : view === "settings" ? (
                  <SettingsView />
                ) : null}
              </motion.div>
            </AnimatePresence>

            {/* 编辑器作为工作区模式：留在纸面里，导航轨仍然可见，不再整屏盖住应用 */}
            <AnimatePresence>
              {overlayVisible(editTarget) && <EditorView />}
            </AnimatePresence>
            <AnimatePresence>
              {overlayVisible(outpaintTarget) && <OutpaintView />}
            </AnimatePresence>
            <AnimatePresence>
              {overlayVisible(basicEditTarget) && <BasicEditView />}
            </AnimatePresence>
            <AnimatePresence>
              {overlayVisible(backgroundTarget) && <BackgroundView />}
            </AnimatePresence>
            <AnimatePresence>
              {overlayVisible(animationTarget) && <AnimationView />}
            </AnimatePresence>
          </div>
        </main>
        {showInspector && <Inspector />}
      </div>

      <ResizeHandles isMaximized={isMaximized} />
      {dragging && <DropOverlay />}
      <CommandPalette />
      <ShortcutsSheet />
      <UpdateDialog />
      <ConfirmDialog
        open={closeConfirmOpen}
        onOpenChange={(open) => {
          if (open) return;
          setCloseConfirmOpen(false);
          // 取消/点遮罩/Esc：让同一次点击里可能触发的 onConfirm 先落定
          queueMicrotask(() => {
            const resolve = closeConfirmResolve.current;
            closeConfirmResolve.current = null;
            resolve?.(false);
          });
        }}
        title={t("画布有未保存的改动")}
        cancelLabel={t("取消")}
        confirmLabel={t("关闭并保存")}
        onConfirm={() => {
          const resolve = closeConfirmResolve.current;
          closeConfirmResolve.current = null;
          setCloseConfirmOpen(false);
          resolve?.(true);
        }}
      />
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
