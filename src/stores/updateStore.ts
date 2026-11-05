import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api, type AvailableUpdate, type UpdateProgress } from "../lib/api";

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

interface UpdateStore {
  phase: UpdatePhase;
  currentVersion: string;
  info: AvailableUpdate | null;
  progress: UpdateProgress | null;
  error: string;
  /** 手动检查的结果提示；静默检查（启动/离线）不写，避免启动就弹提示 */
  notice: string;
  dialogOpen: boolean;
  checked: boolean;
  unlisteners: UnlistenFn[];
  subscribe: () => Promise<void>;
  unsubscribe: () => void;
  check: (manual?: boolean) => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
  openDialog: () => void;
  closeDialog: () => void;
}

// StrictMode 会双调 effect：共享同一次订阅/检查，避免重复监听与重复请求
let subscribing: Promise<void> | null = null;
let checking: Promise<void> | null = null;

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  phase: "idle",
  currentVersion: "",
  info: null,
  progress: null,
  error: "",
  notice: "",
  dialogOpen: false,
  checked: false,
  unlisteners: [],

  subscribe: async () => {
    if (get().unlisteners.length > 0) return;
    if (subscribing) return subscribing;
    subscribing = (async () => {
      const unlisteners: UnlistenFn[] = [];
      unlisteners.push(
        await listen<UpdateProgress>("update:progress", (e) => {
          if (get().phase === "downloading") set({ progress: e.payload });
        }),
      );
      unlisteners.push(
        await listen("update:downloaded", () => {
          const progress = get().progress;
          set({
            phase: "downloaded",
            dialogOpen: true,
            progress: progress
              ? {
                  ...progress,
                  downloaded: progress.total ?? progress.downloaded,
                }
              : progress,
          });
        }),
      );
      set({ unlisteners });
    })();
    try {
      await subscribing;
    } finally {
      subscribing = null;
    }
  },

  unsubscribe: () => {
    for (const off of get().unlisteners) off();
    set({ unlisteners: [] });
    // 不在这里清 subscribing：StrictMode 在订阅尚未完成时就卸载，
    // 清掉会让第二次挂载重新订阅，第一轮监听则永远无人释放
  },

  check: (manual = false) => {
    if (checking) return checking;
    const phase = get().phase;
    if (phase === "downloading" || phase === "installing") {
      return Promise.resolve();
    }
    if (manual) set({ phase: "checking", notice: "", error: "" });

    checking = (async () => {
      try {
        const status = await api.getUpdateStatus();
        set({ checked: true, currentVersion: status.currentVersion });

        const silentDone = () => {
          if (manual) {
            set({ phase: "idle", notice: "当前已是最新版本" });
          } else if (get().phase === "checking") {
            set({ phase: "idle" });
          }
        };
        if (!status.configured) {
          if (manual) {
            set({
              phase: "idle",
              notice: "当前版本未接入更新源，无法检查更新",
            });
          } else if (get().phase === "checking") {
            set({ phase: "idle" });
          }
          return;
        }
        if (status.error) {
          if (manual) {
            set({ phase: "idle", notice: `检查更新失败：${status.error}` });
          } else if (get().phase === "checking") {
            set({ phase: "idle" });
          }
          return;
        }
        if (!status.available) {
          silentDone();
          return;
        }

        const alreadyDownloaded =
          get().phase === "downloaded" &&
          get().info?.version === status.available.version;
        set({
          phase: alreadyDownloaded ? "downloaded" : "available",
          info: status.available,
          notice: "",
          error: "",
          dialogOpen: true,
          progress: alreadyDownloaded ? get().progress : null,
        });
      } catch (e) {
        if (manual) {
          set({ phase: "idle", notice: `检查更新失败：${String(e)}` });
        } else if (get().phase === "checking") {
          set({ phase: "idle" });
        }
      } finally {
        checking = null;
      }
    })();
    return checking;
  },

  download: () => {
    const phase = get().phase;
    if (phase === "downloading" || phase === "installing") {
      return Promise.resolve();
    }
    set({
      phase: "downloading",
      error: "",
      notice: "",
      dialogOpen: true,
      progress: { downloaded: 0, total: null, speed: 0, route: "" },
    });
    return (async () => {
      try {
        await api.downloadUpdate();
        // 完成事件通常会先把状态切到 downloaded；这里兜底
        if (get().phase === "downloading") {
          set({ phase: "downloaded", dialogOpen: true });
        }
      } catch (e) {
        set({ phase: "error", error: String(e) });
      }
    })();
  },

  install: async () => {
    if (get().phase === "installing") return;
    set({ phase: "installing", error: "" });
    try {
      // 成功后进程会退出/重启，这里通常不会返回
      await api.installUpdate();
    } catch (e) {
      set({ phase: "error", error: String(e) });
    }
  },

  openDialog: () => set({ dialogOpen: true }),
  closeDialog: () => set({ dialogOpen: false }),
}));

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatSpeed(bps: number): string {
  return `${formatBytes(bps)}/s`;
}
