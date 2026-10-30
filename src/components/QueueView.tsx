import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  adapterErrorTitle,
  api,
  parseAdapterError,
  QueueJob,
  QueueStatus,
} from "../lib/api";
import { useQueueStore } from "../stores/queueStore";
import { useAppStore } from "../stores/appStore";
import { toast } from "../lib/notify";
import { DUR, EASE } from "../lib/motion";
import { useScrollEdge } from "../hooks/useScrollEdge";
import PageHeader from "./PageHeader";
import SafeImg from "./SafeImg";
import { Button } from "./ui/Button";
import { Select } from "./ui/Select";
import { IconQueue } from "./Icons";

const STATUS_META: Record<QueueStatus, { label: string; cls: string }> = {
  queued: { label: "排队中", cls: "bg-fill text-secondary" },
  running: { label: "生成中", cls: "bg-accent-soft text-accent" },
  done: { label: "已完成", cls: "bg-success/12 text-success" },
  failed: { label: "失败", cls: "bg-danger/12 text-danger" },
  canceled: { label: "已取消", cls: "bg-fill text-tertiary" },
  interrupted: { label: "已中断", cls: "bg-fill text-tertiary" },
};

const RETRYABLE: QueueStatus[] = ["failed", "canceled", "interrupted"];

const CONCURRENCY_OPTIONS = [1, 2, 3, 4].map((n) => ({
  value: String(n),
  label: `${n} 个任务`,
}));

/// 参考图 data URL 缓存：队列条目重渲染时不重复读盘
const refUrlCache = new Map<string, string>();

/// 队列条目上的参考图缩略图（最多 4 张，路径来自 inputJson）
function ReferenceThumbs({ inputJson }: { inputJson: string }) {
  const [urls, setUrls] = useState<string[]>([]);
  const paths = useMemo(() => {
    try {
      const extras = JSON.parse(inputJson || "{}");
      return Array.isArray(extras.referencePaths)
        ? (extras.referencePaths as string[]).slice(0, 4)
        : [];
    } catch {
      return [];
    }
  }, [inputJson]);

  useEffect(() => {
    // 空路径不加载：缩略图为空由下面的 paths 判断兜底，避免 effect 内同步 setState
    if (paths.length === 0) return;
    let alive = true;
    Promise.all(
      paths.map(async (p) => {
        const hit = refUrlCache.get(p);
        if (hit) return hit;
        try {
          const url = await api.readReferenceImage(p);
          refUrlCache.set(p, url);
          return url;
        } catch {
          return "";
        }
      }),
    ).then((list) => {
      if (alive) setUrls(list.filter(Boolean));
    });
    return () => {
      alive = false;
    };
  }, [paths]);

  if (paths.length === 0 || urls.length === 0) return null;
  return (
    <div className="mt-2 flex gap-1.5">
      {urls.map((src, i) => (
        <SafeImg
          key={src}
          src={src}
          alt={`参考图 ${i + 1}`}
          className="size-12 rounded-btn border border-line object-cover"
        />
      ))}
    </div>
  );
}

function JobRow({ job }: { job: QueueJob }) {
  const progress = useQueueStore((s) => s.progress[job.id]);
  const cancel = useQueueStore((s) => s.cancel);
  const retry = useQueueStore((s) => s.retry);
  const meta = STATUS_META[job.status] ?? STATUS_META.queued;
  const active = job.status === "running";
  const error = job.error ? parseAdapterError(job.error) : null;
  const reduce = useReducedMotion();

  const run = (action: Promise<void>, fallback: string) =>
    action.catch((e) => toast(`${fallback}：${String(e)}`, "error"));

  return (
    <motion.li
      layout
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DUR.base, ease: EASE.ios }}
      className="rounded-card border border-line bg-elevated p-4 shadow-card"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={`rounded-chip px-2 py-0.5 text-caption font-medium ${meta.cls}`}
            >
              {meta.label}
            </span>
            <span className="truncate text-footnote text-tertiary">
              #{job.id} · {job.providerName}
            </span>
          </div>
          <p className="mt-2 line-clamp-2 text-body text-primary">
            {job.prompt}
          </p>
          <div className="mt-1.5 text-footnote text-tertiary">
            {job.model} · {job.width} × {job.height} · {job.count} 张
            {job.style && " · 已选风格"}
          </div>
          <ReferenceThumbs inputJson={job.inputJson} />
        </div>
        <div className="flex shrink-0 gap-1.5">
          {(job.status === "queued" || active) && (
            <Button
              size="sm"
              variant="danger"
              onClick={() => run(cancel(job.id), "取消失败")}
            >
              取消
            </Button>
          )}
          {RETRYABLE.includes(job.status) && (
            <Button size="sm" onClick={() => run(retry(job.id), "重试失败")}>
              重试
            </Button>
          )}
        </div>
      </div>

      {active && (
        <div className="mt-3">
          <div className="h-1 overflow-hidden rounded-pill bg-sunken">
            <div
              className="h-full rounded-pill bg-accent-fill transition-[width] duration-300 ease-ios"
              style={{
                width: progress
                  ? `${Math.round((progress.done / Math.max(progress.total, 1)) * 100)}%`
                  : "8%",
              }}
            />
          </div>
          <div className="mt-1 text-footnote text-tertiary">
            {progress
              ? `已落盘 ${progress.done} / ${progress.total} 张`
              : "正在请求图片…"}
          </div>
        </div>
      )}

      {error && job.status === "failed" && (
        <div className="mt-2.5 rounded-btn border border-danger/25 bg-danger/10 px-3 py-2">
          <div className="text-footnote font-medium text-danger">
            {adapterErrorTitle(error)}
          </div>
          <div className="mt-0.5 max-h-20 overflow-y-auto break-all text-footnote text-secondary">
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
  const concurrency = useQueueStore((s) => s.concurrency);
  const loaded = useQueueStore((s) => s.loaded);
  const load = useQueueStore((s) => s.load);
  const start = useQueueStore((s) => s.start);
  const setConcurrency = useQueueStore((s) => s.setConcurrency);
  const clearFinished = useQueueStore((s) => s.clearFinished);
  const setView = useAppStore((s) => s.setView);
  const scrollRef = useRef<HTMLDivElement>(null);
  useScrollEdge(scrollRef);

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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-base">
      <PageHeader
        title={
          <>
            队列
            {pending > 0 && (
              <span className="ml-2 rounded-chip bg-accent-soft px-2 py-0.5 align-middle text-caption font-medium text-accent">
                {pending}
              </span>
            )}
          </>
        }
        subtitle="生成任务按顺序执行，可随时暂停或重试"
        actions={
          <>
            <div className="flex items-center gap-2">
              <span className="text-footnote text-tertiary">并发</span>
              <Select
                value={String(concurrency)}
                onValueChange={(v) =>
                  setConcurrency(Number(v)).catch((e) =>
                    toast(`并发设置失败：${String(e)}`, "error"),
                  )
                }
                options={CONCURRENCY_OPTIONS}
                widthClass="w-28"
                label="队列并发数"
              />
            </div>
            {paused && (
              <Button
                size="sm"
                variant="primary"
                onClick={() =>
                  start().catch((e) => toast(`启动失败：${String(e)}`, "error"))
                }
              >
                开始队列
              </Button>
            )}
            {finished > 0 && (
              <Button
                size="sm"
                onClick={() =>
                  clearFinished().catch((e) =>
                    toast(`清空失败：${String(e)}`, "error"),
                  )
                }
              >
                清空已完成
              </Button>
            )}
          </>
        }
      />

      <div
        ref={scrollRef}
        className="scroll-edge min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto max-w-3xl space-y-3 p-6">
          {paused && pending > 0 && (
            <div className="rounded-card border border-accent/25 bg-accent-soft px-4 py-3 text-callout leading-relaxed text-secondary">
              队列已暂停：启动应用后不会自动执行，避免重启即产生费用。点击右上角「开始队列」继续。
            </div>
          )}
          {!loaded ? (
            <div className="py-16 text-center text-body text-tertiary">
              加载中…
            </div>
          ) : jobs.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-line-strong p-14 text-center">
              <span className="flex size-12 items-center justify-center rounded-pill bg-fill text-tertiary">
                <IconQueue size={22} />
              </span>
              <div className="text-body text-tertiary">
                队列还是空的：在聊天页输入提示词后点「加入队列」，可附带参考图并按需调整并发数。
              </div>
              <Button size="sm" onClick={() => setView("chat")}>
                去聊天页
              </Button>
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
