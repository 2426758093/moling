import { useEffect } from "react";
import { motion } from "framer-motion";
import {
  adapterErrorTitle,
  parseAdapterError,
  QueueJob,
  QueueStatus,
} from "../lib/api";
import { useQueueStore } from "../stores/queueStore";
import { useAppStore } from "../stores/appStore";
import { toast } from "../lib/notify";
import { IconQueue } from "./Icons";

const STATUS_META: Record<QueueStatus, { label: string; cls: string }> = {
  queued: { label: "排队中", cls: "bg-hover text-tertiary" },
  running: { label: "生成中", cls: "bg-accent-soft text-accent" },
  done: { label: "已完成", cls: "bg-success/10 text-success" },
  failed: { label: "失败", cls: "bg-danger/10 text-danger" },
  canceled: { label: "已取消", cls: "bg-hover text-tertiary" },
  interrupted: { label: "已中断", cls: "bg-hover text-tertiary" },
};

const RETRYABLE: QueueStatus[] = ["failed", "canceled", "interrupted"];

function JobRow({ job }: { job: QueueJob }) {
  const progress = useQueueStore((s) => s.progress[job.id]);
  const cancel = useQueueStore((s) => s.cancel);
  const retry = useQueueStore((s) => s.retry);
  const meta = STATUS_META[job.status] ?? STATUS_META.queued;
  const active = job.status === "running";
  const error = job.error ? parseAdapterError(job.error) : null;

  const run = (action: Promise<void>, fallback: string) =>
    action.catch((e) => toast(`${fallback}：${String(e)}`, "error"));

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="rounded-[var(--radius-card)] border border-theme bg-elevated p-4 shadow-card"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.cls}`}
            >
              {meta.label}
            </span>
            <span className="truncate text-[11px] text-tertiary">
              #{job.id} · {job.providerName}
            </span>
          </div>
          <p className="mt-2 line-clamp-2 text-[14px] leading-relaxed text-primary">
            {job.prompt}
          </p>
          <div className="mt-1.5 text-[11px] text-tertiary">
            {job.model} · {job.width} × {job.height} · {job.count} 张
            {job.style && " · 已选风格"}
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          {(job.status === "queued" || active) && (
            <button
              onClick={() => run(cancel(job.id), "取消失败")}
              className="rounded-[8px] border border-theme px-2.5 py-1 text-[11px] text-secondary transition-colors hover:text-danger"
            >
              取消
            </button>
          )}
          {RETRYABLE.includes(job.status) && (
            <button
              onClick={() => run(retry(job.id), "重试失败")}
              className="rounded-[8px] border border-theme px-2.5 py-1 text-[11px] text-secondary transition-colors hover:text-accent"
            >
              重试
            </button>
          )}
        </div>
      </div>

      {active && (
        <div className="mt-3">
          <div className="h-1 overflow-hidden rounded-full bg-sunken">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-300"
              style={{
                width: progress
                  ? `${Math.round((progress.done / Math.max(progress.total, 1)) * 100)}%`
                  : "8%",
              }}
            />
          </div>
          <div className="mt-1 text-[11px] text-tertiary">
            {progress
              ? `已落盘 ${progress.done} / ${progress.total} 张`
              : "正在请求图片…"}
          </div>
        </div>
      )}

      {error && job.status === "failed" && (
        <div className="mt-2.5 rounded-[10px] border border-danger/25 bg-danger/5 px-3 py-2">
          <div className="text-[12px] font-medium text-danger">
            {adapterErrorTitle(error)}
          </div>
          <div className="mt-0.5 max-h-20 overflow-y-auto break-all text-[11px] text-secondary">
            {error.message}
          </div>
        </div>
      )}
    </motion.li>
  );
}

export default function QueueView() {
  const jobs = useQueueStore((s) => s.jobs);
  const counts = useQueueStore((s) => s.counts);
  const paused = useQueueStore((s) => s.paused);
  const loaded = useQueueStore((s) => s.loaded);
  const load = useQueueStore((s) => s.load);
  const start = useQueueStore((s) => s.start);
  const clearFinished = useQueueStore((s) => s.clearFinished);
  const setView = useAppStore((s) => s.setView);

  useEffect(() => {
    load().catch((e) => toast(`加载队列失败：${String(e)}`, "error"));
  }, [load]);

  const finished =
    (counts.done ?? 0) +
    (counts.failed ?? 0) +
    (counts.canceled ?? 0) +
    (counts.interrupted ?? 0);
  const pending = (counts.queued ?? 0) + (counts.running ?? 0);

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-base">
      <header className="bg-glass z-10 flex h-[52px] shrink-0 items-end justify-between border-b border-theme px-6 pb-2">
        <h1 className="text-[17px] font-semibold tracking-tight text-primary">
          队列
          {pending > 0 && (
            <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">
              {pending}
            </span>
          )}
        </h1>
        <div className="flex items-center gap-2">
          {paused && (
            <button
              onClick={() =>
                start().catch((e) => toast(`启动失败：${String(e)}`, "error"))
              }
              className="rounded-[10px] bg-accent px-3 py-1 text-[12px] text-white"
            >
              开始队列
            </button>
          )}
          {finished > 0 && (
            <button
              onClick={() =>
                clearFinished().catch((e) =>
                  toast(`清空失败：${String(e)}`, "error"),
                )
              }
              className="rounded-[10px] border border-theme px-3 py-1 text-[12px] text-secondary"
            >
              清空已完成
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl">
          {paused && pending > 0 && (
            <div className="mb-4 rounded-[var(--radius-card)] border border-accent/25 bg-accent-soft px-4 py-3 text-[12px] leading-relaxed text-secondary">
              队列已暂停：启动应用后不会自动执行，避免重启即产生费用。点击右上角「开始队列」继续。
            </div>
          )}
          {!loaded ? (
            <div className="py-16 text-center text-sm text-tertiary">
              加载中…
            </div>
          ) : jobs.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-[var(--radius-card)] border border-dashed border-theme p-14 text-center">
              <span className="text-tertiary">
                <IconQueue size={26} />
              </span>
              <div className="text-sm text-tertiary">
                队列还是空的：在聊天页输入提示词后点「加入队列」。
              </div>
              <button
                onClick={() => setView("chat")}
                className="rounded-[10px] border border-theme px-3 py-1.5 text-xs text-secondary"
              >
                去聊天页
              </button>
            </div>
          ) : (
            <ul className="space-y-3">
              {jobs.map((job) => (
                <JobRow key={job.id} job={job} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
