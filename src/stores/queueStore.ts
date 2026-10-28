import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api, EnqueueJobInput, QueueJob } from "../lib/api";
import { toast } from "../lib/notify";

export interface QueueProgress {
  done: number;
  total: number;
}

interface QueueStore {
  jobs: QueueJob[];
  counts: Record<string, number>;
  paused: boolean;
  loaded: boolean;
  progress: Record<number, QueueProgress>;
  unlisteners: UnlistenFn[];
  load: () => Promise<void>;
  /** 订阅后端事件（App 启动时调用一次；重复调用会被忽略） */
  subscribe: () => Promise<void>;
  unsubscribe: () => void;
  enqueue: (input: EnqueueJobInput) => Promise<void>;
  start: () => Promise<void>;
  cancel: (id: number) => Promise<void>;
  retry: (id: number) => Promise<void>;
  clearFinished: () => Promise<void>;
}

/** 新任务插到最前（后端按 id DESC 返回，保持一致） */
function upsertJob(jobs: QueueJob[], job: QueueJob): QueueJob[] {
  if (jobs.some((j) => j.id === job.id)) {
    return jobs.map((j) => (j.id === job.id ? job : j));
  }
  return [job, ...jobs];
}

// 订阅中的 Promise：StrictMode 会双调 effect，共享同一次订阅避免重复监听
let inflight: Promise<void> | null = null;

export const useQueueStore = create<QueueStore>((set, get) => ({
  jobs: [],
  counts: {},
  paused: true,
  loaded: false,
  progress: {},
  unlisteners: [],

  load: async () => {
    const { jobs, counts, paused } = await api.listJobs();
    set({ jobs, counts, paused, loaded: true });
  },

  subscribe: async () => {
    if (get().unlisteners.length > 0) return;
    if (inflight) return inflight;
    inflight = (async () => {
      const unlisteners: UnlistenFn[] = [];
      unlisteners.push(
        await listen<QueueJob>("queue:job", (e) => {
          const job = e.payload;
          set((s) => {
            // 离开 running 后清掉本地进度，避免重试后残留旧进度
            const progress = { ...s.progress };
            if (job.status !== "running") delete progress[job.id];
            return { jobs: upsertJob(s.jobs, job), progress };
          });
        }),
      );
      unlisteners.push(
        await listen<Record<string, number>>("queue:counts", (e) =>
          set({ counts: e.payload }),
        ),
      );
      unlisteners.push(
        await listen<{ id: number; done: number; total: number }>(
          "queue:progress",
          (e) => {
            const { id, done, total } = e.payload;
            set((s) => ({
              progress: { ...s.progress, [id]: { done, total } },
            }));
          },
        ),
      );
      set({ unlisteners });
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  },

  unsubscribe: () => {
    for (const off of get().unlisteners) off();
    set({ unlisteners: [] });
  },

  enqueue: async (input) => {
    const job = await api.enqueueJob(input);
    set((s) => ({ jobs: upsertJob(s.jobs, job) }));
  },

  start: async () => {
    await api.resumeQueue();
    set({ paused: false });
    toast("队列已开始");
  },

  cancel: async (id) => {
    await api.cancelQueueJob(id);
  },

  retry: async (id) => {
    await api.retryQueueJob(id);
  },

  clearFinished: async () => {
    const removed = await api.clearFinishedJobs();
    await get().load();
    if (removed > 0) toast(`已清空 ${removed} 条已结束任务`);
  },
}));
