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
  /** 并发上限（1–4），后端每次领取任务时读取设置 */
  concurrency: number;
  /** 每服务商并发上限（1–2）：图像端点并发能力普遍很低 */
  providerConcurrency: number;
  loaded: boolean;
  progress: Record<number, QueueProgress>;
  unlisteners: UnlistenFn[];
  load: () => Promise<void>;
  /** 订阅后端事件（引用计数：与 unsubscribe 成对调用） */
  subscribe: () => Promise<void>;
  unsubscribe: () => void;
  enqueue: (input: EnqueueJobInput) => Promise<void>;
  start: () => Promise<void>;
  setConcurrency: (n: number) => Promise<void>;
  setProviderConcurrency: (n: number) => Promise<void>;
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

// 订阅引用计数：StrictMode 会「挂载 → 卸载 → 再挂载」，
// 只按次数增减，归零才真正摘掉监听，避免第二次挂载前把监听关掉。
let subscribers = 0;
// 订阅中的 Promise：并发调用共享同一次订阅，避免重复监听
let inflight: Promise<void> | null = null;

export const useQueueStore = create<QueueStore>((set, get) => ({
  jobs: [],
  counts: {},
  paused: true,
  concurrency: 1,
  providerConcurrency: 1,
  loaded: false,
  progress: {},
  unlisteners: [],

  load: async () => {
    const { jobs, counts, paused, concurrency, providerConcurrency } =
      await api.listJobs();
    set({
      jobs,
      counts,
      paused,
      concurrency,
      providerConcurrency,
      loaded: true,
    });
  },

  subscribe: async () => {
    subscribers += 1;
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
      // 订阅尚未完成时消费者已全部卸载：立即摘掉，别把监听泄漏到下次挂载
      if (subscribers === 0) {
        for (const off of unlisteners) off();
        return;
      }
      set({ unlisteners });
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  },

  unsubscribe: () => {
    subscribers = Math.max(0, subscribers - 1);
    if (subscribers > 0) return;
    const offs = get().unlisteners;
    set({ unlisteners: [] });
    for (const off of offs) off();
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

  setConcurrency: async (n) => {
    const next = Math.min(4, Math.max(1, Math.round(n)));
    await api.setSetting("queueConcurrency", String(next));
    set({ concurrency: next });
    toast(`并发数已设为 ${next}`);
  },

  setProviderConcurrency: async (n) => {
    const next = Math.min(2, Math.max(1, Math.round(n)));
    await api.setSetting("queueProviderConcurrency", String(next));
    set({ providerConcurrency: next });
    toast(`每服务商并发已设为 ${next}`);
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
