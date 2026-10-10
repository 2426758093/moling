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
import { toast } from "./lib/notify";

function useApplyTheme() {
  const theme = useAppStore((s) => s.theme);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
    };
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
        const file = e.dataTransfer.files?.[0];
        if (!file || !file.type.startsWith("image/")) return;
        e.preventDefault();
        void (async () => {
          const invalid = await validateImageFile(file);
          if (invalid) {
            toast(invalid, "error");
            return;
          }
          const dataUrl = await readFileAsDataUrl(file);
          addAttachment({
            id: genAttachmentId(),
            dataUrl,
            name: file.name,
          });
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
