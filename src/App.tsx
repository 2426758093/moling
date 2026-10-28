import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Sidebar from "./components/Sidebar";
import ChatView from "./components/ChatView";
import GalleryView from "./components/GalleryView";
import SettingsView from "./components/SettingsView";
import SettingsRail from "./components/SettingsRail";
import EditorView from "./components/EditorView";
import OutpaintView from "./components/OutpaintView";
import { useAppStore } from "./stores/appStore";
import { useChatStore } from "./stores/chatStore";
import { useProviderStore } from "./stores/providerStore";
import { api } from "./lib/api";
import {
  readFileAsDataUrl,
  genAttachmentId,
  validateImageFile,
} from "./lib/file";
import { applyThemeClass } from "./lib/theme";
import { MAX_REFERENCE_IMAGES } from "./lib/image";
import { toast } from "./lib/notify";

function useApplyTheme() {
  const theme = useAppStore((s) => s.theme);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => applyThemeClass(theme);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
}

const VIEW_VARIANTS = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -10 },
};

export default function App() {
  useApplyTheme();
  const view = useAppStore((s) => s.view);
  const editTarget = useAppStore((s) => s.editTarget);
  const outpaintTarget = useAppStore((s) => s.outpaintTarget);
  const addAttachment = useChatStore((s) => s.addAttachment);
  const setView = useAppStore((s) => s.setView);

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
          const remaining =
            MAX_REFERENCE_IMAGES - useChatStore.getState().attachments.length;
          if (remaining <= 0) {
            toast(`最多添加 ${MAX_REFERENCE_IMAGES} 张参考图`, "error");
            return;
          }
          if (files.length > remaining) {
            toast(
              `最多添加 ${MAX_REFERENCE_IMAGES} 张参考图，已忽略多余文件`,
              "error",
            );
          }
          for (const file of files.slice(0, remaining)) {
            const invalid = await validateImageFile(file);
            if (invalid) {
              toast(invalid, "error");
              continue;
            }
            const dataUrl = await readFileAsDataUrl(file);
            if (
              !addAttachment({
                id: genAttachmentId(),
                dataUrl,
                name: file.name,
              })
            ) {
              break;
            }
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
            variants={VIEW_VARIANTS}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={{ duration: 0.18 }}
            className="flex min-h-0 flex-1 flex-col"
          >
            {view === "chat" ? (
              <ChatView />
            ) : view === "gallery" ? (
              <GalleryView />
            ) : (
              <SettingsView />
            )}
          </motion.div>
        </AnimatePresence>
      </main>
      <SettingsRail />
      <AnimatePresence>{editTarget && <EditorView />}</AnimatePresence>
      <AnimatePresence>{outpaintTarget && <OutpaintView />}</AnimatePresence>
    </div>
  );
}
