import { useEffect, useRef, useState } from "react";
import { api, HistoryItem } from "../lib/api";
import { Dialog } from "./ui/Dialog";
import { Button } from "./ui/Button";
import { SegmentedControl } from "./ui/SegmentedControl";
import SafeImg from "./SafeImg";
import { IconChevron } from "./Icons";

type Mode = "slide" | "side";

function metaOf(item: HistoryItem) {
  const h = item.history;
  return `${h.model || "未知模型"} · ${h.width}×${h.height} · #${h.id}`;
}

/** 对比主体：按两图 id 作 key 挂载，切换组合时位置与加载状态自然重置 */
function CompareBody({
  left,
  right,
}: {
  left: HistoryItem;
  right: HistoryItem;
}) {
  const [mode, setMode] = useState<Mode>("slide");
  const [pos, setPos] = useState(50);
  const [urls, setUrls] = useState<{ left: string; right: string } | null>(
    null,
  );
  const [failed, setFailed] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.getHistoryImage(left.history.id),
      api.getHistoryImage(right.history.id),
    ])
      .then(([l, r]) => {
        if (alive) setUrls({ left: l.dataUrl, right: r.dataUrl });
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [left.history.id, right.history.id]);

  const clamp = (v: number) => Math.min(100, Math.max(0, v));
  const updateFromX = (clientX: number) => {
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    setPos(clamp(Math.round(((clientX - rect.left) / rect.width) * 100)));
  };

  const ready = urls !== null;

  return (
    <div className="flex flex-col gap-3 pb-2">
      <SegmentedControl
        value={mode}
        onValueChange={(v) => setMode(v as Mode)}
        label="对比模式"
        size="sm"
        options={[
          { value: "slide", label: "滑动对比" },
          { value: "side", label: "并排对比" },
        ]}
      />

      {failed && (
        <div className="rounded-card bg-fill px-3 py-6 text-center text-footnote text-tertiary">
          原图不可用，无法对比
        </div>
      )}
      {!failed && !ready && (
        <div className="rounded-card bg-fill px-3 py-6 text-center text-footnote text-tertiary">
          加载原图中…
        </div>
      )}

      {ready && !failed && mode === "slide" && (
        <div
          ref={stageRef}
          role="slider"
          aria-label="对比分隔位置"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pos}
          tabIndex={0}
          className="relative aspect-video w-full touch-none select-none overflow-hidden rounded-card bg-sunken outline-none focus-visible:ring-2 focus-visible:ring-accent"
          onPointerDown={(e) => {
            dragging.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            updateFromX(e.clientX);
          }}
          onPointerMove={(e) => {
            if (dragging.current) updateFromX(e.clientX);
          }}
          onPointerUp={() => {
            dragging.current = false;
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              setPos((p) => clamp(p - 2));
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              setPos((p) => clamp(p + 2));
            }
          }}
        >
          <SafeImg
            src={urls.right}
            alt={right.history.prompt || "右图"}
            className="pointer-events-none absolute inset-0 h-full w-full object-contain"
          />
          <div
            className="pointer-events-none absolute inset-0"
            style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
          >
            <SafeImg
              src={urls.left}
              alt={left.history.prompt || "左图"}
              className="h-full w-full object-contain"
            />
          </div>
          <span className="glass-media pointer-events-none absolute bottom-2 left-2 rounded-pill px-2 py-0.5 text-caption text-on-accent">
            左 #{left.history.id}
          </span>
          <span className="glass-media pointer-events-none absolute bottom-2 right-2 rounded-pill px-2 py-0.5 text-caption text-on-accent">
            右 #{right.history.id}
          </span>
          <div
            className="pointer-events-none absolute inset-y-0 w-0.5 bg-accent-fill"
            style={{ left: `calc(${pos}% - 1px)` }}
          />
          <div
            className="pointer-events-none absolute top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-pill border border-line bg-elevated text-secondary shadow-card"
            style={{ left: `${pos}%` }}
          >
            <IconChevron size={10} direction="left" />
            <IconChevron size={10} direction="right" />
          </div>
        </div>
      )}

      {ready && !failed && mode === "side" && (
        <div className="grid grid-cols-2 gap-3">
          {[left, right].map((item, i) => (
            <div
              key={item.history.id}
              className="flex min-w-0 flex-col gap-1.5"
            >
              <div className="flex aspect-square items-center justify-center overflow-hidden rounded-card bg-sunken">
                <SafeImg
                  src={i === 0 ? urls.left : urls.right}
                  alt={item.history.prompt || "对比图"}
                  className="h-full w-full object-contain"
                />
              </div>
              <div className="line-clamp-2 text-footnote leading-snug text-secondary">
                {item.history.prompt || "（无提示词）"}
              </div>
              <div className="text-caption text-tertiary">{metaOf(item)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 两两对比：滑动叠图（可拖分隔线 / ←→ 微调）或并排查看原图 */
export default function CompareDialog({
  open,
  left,
  right,
  onClose,
}: {
  open: boolean;
  left: HistoryItem | null;
  right: HistoryItem | null;
  onClose: () => void;
}) {
  const title =
    left && right ? `对比 #${left.history.id} 与 #${right.history.id}` : "对比";
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title={title}
      description="滑动模式拖动分隔线（或按 ← →）查看两图差异"
      size="lg"
      footer={
        <Button variant="primary" onClick={onClose}>
          关闭
        </Button>
      }
    >
      {left && right && (
        <CompareBody
          key={`${left.history.id}-${right.history.id}`}
          left={left}
          right={right}
        />
      )}
    </Dialog>
  );
}
