import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  adapterErrorTitle,
  api,
  parseAdapterError,
  QueueJob,
  QueueStatus,
} from "../lib/api";
import { useQueueStore } from "../stores/queueStore";
import { useAppStore } from "../stores/appStore";
import { sizeLabel } from "../lib/types";
import { toast } from "../lib/notify";
import { useMotionTokens } from "../lib/useMotion";
import { useScrollEdge } from "../hooks/useScrollEdge";
import PageHeader from "./PageHeader";
import SafeImg from "./SafeImg";
import { Button } from "./ui/Button";
import { Select } from "./ui/Select";
import { IconButton } from "./ui/IconButton";
import { InsetList } from "./ui/List";
import { EmptyState } from "./ui/EmptyState";
import {
  IconAlert,
  IconChevron,
  IconClose,
  IconCopy,
  IconQueue,
  IconRotate,
} from "./Icons";
import { cn } from "./ui/cn";

const STATUS_META: Record<
  QueueStatus,
  { label: string; cls: string; dot: string }
> = {
  queued: {
    label: "排队中",
    cls: "bg-fill text-secondary",
    dot: "bg-tertiary",
  },
  running: {
    label: "生成中",
    cls: "bg-accent-soft text-accent-text",
    dot: "bg-accent",
  },
  done: {
    label: "已完成",
    cls: "bg-success/12 text-success",
    dot: "bg-success-fill",
  },
  failed: {
    label: "失败",
    cls: "bg-danger/12 text-danger",
    dot: "bg-danger",
  },
  canceled: {
    label: "已取消",
    cls: "bg-fill text-tertiary",
    dot: "bg-tertiary",
  },
  interrupted: {
    label: "已中断",
    cls: "bg-fill text-tertiary",
    dot: "bg-warning-fill",
  },
};

const RETRYABLE: QueueStatus[] = ["failed", "canceled", "interrupted"];

const CONCURRENCY_OPTIONS = [1, 2, 3, 4].map((n) => ({
  value: String(n),
  label: `${n} 个任务`,
}));

const PROVIDER_CONCURRENCY_OPTIONS = [1, 2].map((n) => ({
  value: String(n),
  label: `${n} 个任务`,
}));

type Filter = "all" | "pending" | "done" | "issue";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "pending", label: "待处理" },
  { id: "done", label: "已完成" },
  { id: "issue", label: "异常" },
];

function matchesFilter(job: QueueJob, filter: Filter) {
  switch (filter) {
    case "pending":
      return job.status === "queued" || job.status === "running";
    case "done":
      return job.status === "done";
    case "issue":
      return RETRYABLE.includes(job.status);
    default:
      return true;
  }
}

/// 参考图 data URL 缓存：队列条目重渲染时不重复读盘。
/// 上限 200 条（LRU）：长队列里 data URL 每条都是几百 KB，无界缓存会吃光内存。
const REF_URL_CACHE_LIMIT = 200;
const refUrlCache = new Map<string, string>();

function cacheRefUrl(path: string, url: string) {
  refUrlCache.delete(path);
  refUrlCache.set(path, url);
  while (refUrlCache.size > REF_URL_CACHE_LIMIT) {
    const oldest = refUrlCache.keys().next().value;
    if (oldest === undefined) break;
    refUrlCache.delete(oldest);
  }
}

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
          cacheRefUrl(p, url);
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
  const [open, setOpen] = useState(active);
  const [errorOpen, setErrorOpen] = useState(false);
  const motionTokens = useMotionTokens();

  const run = (action: Promise<void>, fallback: string) =>
    action.catch((e) => toast(`${fallback}：${String(e)}`, "error"));

  const copy = (text: string, label: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => toast(label))
      .catch(() => toast("复制失败", "error"));
  };

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={motionTokens.spring("snappy")}
      className="relative after:absolute after:inset-x-3 after:bottom-0 after:h-px after:bg-separator after:content-[''] last:after:hidden"
    >
      <div className="flex h-12 items-center gap-2 py-0 pl-1.5 pr-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`任务 #${job.id} 详情`}
          className="flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-btn px-1.5 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/25"
        >
          <span
            aria-hidden
            className={cn("size-2 shrink-0 rounded-pill", meta.dot)}
          />
          <span
            className={cn(
              "shrink-0 rounded-chip px-1.5 py-0.5 text-caption font-medium",
              meta.cls,
            )}
          >
            {meta.label}
          </span>
          <span className="min-w-0 flex-1 truncate text-callout text-primary">
            {job.prompt}
          </span>
          {active && progress && (
            <span className="tabular hidden shrink-0 text-footnote text-tertiary compact:block">
              {progress.done}/{progress.total}
            </span>
          )}
          <IconChevron
            direction={open ? "down" : "right"}
            size={12}
            className="shrink-0 text-tertiary"
          />
        </button>

        {(job.status === "queued" || active) && (
          <IconButton
            label="取消任务"
            size="sm"
            icon={<IconClose size={13} />}
            onClick={() => run(cancel(job.id), "取消失败")}
          />
        )}
        {RETRYABLE.includes(job.status) && (
          <IconButton
            label="重试任务"
            size="sm"
            icon={<IconRotate size={13} />}
            onClick={() => run(retry(job.id), "重试失败")}
          />
        )}
      </div>

      {open && (
        <div className="pb-3 pl-3 pr-3">
          <p className="break-words whitespace-pre-wrap text-body text-secondary">
            {job.prompt}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-footnote text-tertiary">
            <span className="tabular">#{job.id}</span>
            <span aria-hidden>·</span>
            <span>{job.providerName}</span>
            <span aria-hidden>·</span>
            <span>{job.model}</span>
            <span aria-hidden>·</span>
            <span className="tabular">{sizeLabel(job.width, job.height)}</span>
            <span aria-hidden>·</span>
            <span>{job.count} 张</span>
            {job.style && (
              <>
                <span aria-hidden>·</span>
                <span>{job.style}</span>
              </>
            )}
            <button
              type="button"
              onClick={() => copy(job.prompt, "提示词已复制")}
              className="pressable ml-auto flex h-6 items-center gap-1 rounded-chip px-2 text-caption text-secondary transition-colors hover:bg-hover hover:text-primary"
            >
              <IconCopy size={12} />
              复制提示词
            </button>
          </div>
          <ReferenceThumbs inputJson={job.inputJson} />

          {active && (
            <div className="mt-2.5">
              <div className="h-1 overflow-hidden rounded-pill bg-sunken">
                <div
                  className="h-full rounded-pill bg-accent-fill transition-[width] duration-300 ease-ios"
                  style={{
                    width: progress
                      ? `${Math.round(
                          (progress.done / Math.max(progress.total, 1)) * 100,
                        )}%`
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
            <div className="mt-2.5">
              <button
                type="button"
                onClick={() => setErrorOpen((v) => !v)}
                aria-expanded={errorOpen}
                className="pressable flex w-full items-center gap-1.5 rounded-btn px-1 py-0.5 text-left text-footnote text-danger transition-colors hover:bg-danger/8"
              >
                <IconAlert size={13} />
                <span className="truncate font-medium">
                  {adapterErrorTitle(error)}
                </span>
                <IconChevron
                  direction={errorOpen ? "down" : "right"}
                  size={11}
                  className="ml-auto shrink-0"
                />
              </button>
              {errorOpen && (
                <div className="mt-1 rounded-btn bg-danger/8 px-2.5 py-2">
                  <div className="max-h-24 overflow-y-auto break-all text-footnote text-secondary">
                    {error.message}
                  </div>
                  <button
                    type="button"
                    onClick={() => copy(error.message, "错误详情已复制")}
                    className="pressable mt-1 flex h-6 items-center gap-1 rounded-chip px-1.5 text-caption text-secondary transition-colors hover:bg-hover hover:text-primary"
                  >
                    <IconCopy size={12} />
                    复制错误
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </motion.li>
  );
}

export default function QueueView() {
  const jobs = useQueueStore((s) => s.jobs);
  const paused = useQueueStore((s) => s.paused);
  const concurrency = useQueueStore((s) => s.concurrency);
  const providerConcurrency = useQueueStore((s) => s.providerConcurrency);
  const setProviderConcurrency = useQueueStore((s) => s.setProviderConcurrency);
  const loaded = useQueueStore((s) => s.loaded);
  const load = useQueueStore((s) => s.load);
  const start = useQueueStore((s) => s.start);
  const setConcurrency = useQueueStore((s) => s.setConcurrency);
  const clearFinished = useQueueStore((s) => s.clearFinished);
  const setView = useAppStore((s) => s.setView);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<Filter>("all");
  useScrollEdge(scrollRef);

  useEffect(() => {
    load().catch((e) => toast(`加载队列失败：${String(e)}`, "error"));
  }, [load]);

  const counts = useMemo(() => {
    const result: Record<Filter, number> = {
      all: jobs.length,
      pending: 0,
      done: 0,
      issue: 0,
    };
    for (const job of jobs) {
      if (matchesFilter(job, "pending")) result.pending += 1;
      if (matchesFilter(job, "done")) result.done += 1;
      if (matchesFilter(job, "issue")) result.issue += 1;
    }
    return result;
  }, [jobs]);

  const finished = counts.done + counts.issue;
  const visible = useMemo(
    () => jobs.filter((job) => matchesFilter(job, filter)),
    [jobs, filter],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="队列"
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
            <div className="flex items-center gap-2">
              <span className="text-footnote text-tertiary">每服务商</span>
              <Select
                value={String(providerConcurrency)}
                onValueChange={(v) =>
                  setProviderConcurrency(Number(v)).catch((e) =>
                    toast(`并发设置失败：${String(e)}`, "error"),
                  )
                }
                options={PROVIDER_CONCURRENCY_OPTIONS}
                widthClass="w-28"
                label="每服务商并发数"
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
        footer={
          <div className="flex flex-wrap items-center gap-1.5">
            {FILTERS.map((item) => {
              const selected = filter === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setFilter(selected ? "all" : item.id)}
                  className={cn(
                    "pressable flex h-7 items-center gap-1.5 rounded-pill px-3 text-callout transition-colors",
                    selected
                      ? "bg-accent-soft text-accent-text"
                      : "bg-fill text-secondary hover:bg-hover hover:text-primary",
                  )}
                >
                  {item.label}
                  <span className="tabular text-footnote opacity-70">
                    {counts[item.id]}
                  </span>
                </button>
              );
            })}
          </div>
        }
      />

      <div
        ref={scrollRef}
        className="scroll-edge min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto max-w-3xl space-y-3 px-4 py-4">
          {paused && counts.pending > 0 && (
            <div className="flex items-start gap-2 rounded-card bg-accent-soft px-3 py-2.5 text-callout leading-relaxed text-secondary">
              <IconAlert size={14} className="mt-0.5 shrink-0 text-warning" />
              <span>
                队列已暂停：启动应用后不会自动执行，避免重启即产生费用。点击右上角「开始队列」继续。
              </span>
            </div>
          )}
          {!loaded ? (
            <div className="py-16 text-center text-body text-tertiary">
              加载中…
            </div>
          ) : jobs.length === 0 ? (
            <EmptyState
              icon={<IconQueue size={22} strokeWidth={1.6} />}
              title="队列还是空的"
              description="在聊天页输入提示词后点「加入队列」，可附带参考图并按需调整并发数。"
            >
              <Button size="sm" onClick={() => setView("chat")}>
                去聊天页
              </Button>
            </EmptyState>
          ) : visible.length === 0 ? (
            <div className="py-12 text-center text-footnote text-tertiary">
              没有符合条件的任务
            </div>
          ) : (
            <InsetList>
              <ul>
                {visible.map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
              </ul>
            </InsetList>
          )}
        </div>
      </div>
    </div>
  );
}
