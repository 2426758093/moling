import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, HistoryItem } from "../lib/api";
import { toast } from "../lib/notify";
import { useCanvasStore } from "../stores/canvasStore";
import { Dialog } from "./ui/Dialog";
import { Button } from "./ui/Button";
import SafeImg from "./SafeImg";

const RECENT_LIMIT = 60;

export default function CanvasAddDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const nodes = useCanvasStore((s) => s.nodes);
  const addHistoryNode = useCanvasStore((s) => s.addHistoryNode);
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    api
      .listHistory(RECENT_LIMIT, null)
      .then(({ items: page }) => {
        if (!alive) return;
        setItems(page);
        setLoaded(true);
      })
      .catch(() => {
        if (alive) toast(t("加载画廊失败，请稍后重试"), "error");
      });
    return () => {
      alive = false;
    };
  }, [open, t]);

  const onCanvas = new Set(nodes.map((n) => n.historyId));

  const pick = async (item: HistoryItem) => {
    const id = await addHistoryNode(item.history.id);
    if (id) toast(t("已加入画布"));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("从画廊添加")}
      description={t("最近 {{n}} 张作品；加入后可以在画布上拖动排布", {
        n: RECENT_LIMIT,
      })}
      size="lg"
      footer={
        <Button variant="primary" onClick={() => onOpenChange(false)}>
          {t("完成")}
        </Button>
      }
    >
      {items.length === 0 ? (
        <div className="flex min-h-40 items-center justify-center text-body text-tertiary">
          {loaded ? t("画廊还没有作品，先去生成几张吧") : t("加载中…")}
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-2 pb-1">
          {items.map((item) => {
            const added = onCanvas.has(item.history.id);
            return (
              <button
                key={item.history.id}
                type="button"
                disabled={added}
                onClick={() => void pick(item)}
                aria-label={
                  added
                    ? t("已在画布：{{prompt}}", { prompt: item.history.prompt })
                    : t("加入画布：{{prompt}}", { prompt: item.history.prompt })
                }
                className="group relative overflow-hidden rounded-card border border-line bg-sunken text-left transition-colors hover:border-line-strong disabled:cursor-default"
              >
                <SafeImg
                  src={item.thumbUrl}
                  alt={item.history.prompt}
                  className="block aspect-square w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                  loading="lazy"
                  decoding="async"
                />
                <span className="block truncate px-2 py-1 text-caption text-secondary">
                  {item.history.prompt ||
                    t("作品 #{{id}}", { id: item.history.id })}
                </span>
                {added && (
                  <span className="glass-media absolute right-1.5 top-1.5 rounded-pill px-2 py-0.5 text-caption text-on-accent">
                    {t("已在画布")}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}
