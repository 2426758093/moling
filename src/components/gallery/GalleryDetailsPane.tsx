import { useTranslation } from "react-i18next";
import type { HistoryItem } from "../../lib/api";
import {
  formatBytes,
  formatDimensions,
  formatHistoryDate,
} from "../../lib/galleryView";
import SafeImg from "../SafeImg";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { IconClose, IconDownload, IconEdit, IconExpand } from "../Icons";
import type { GalleryActions } from "./types";

/// 详情窗格：右侧 288px，未选中时给引导；窄窗口由 GalleryView 隐藏
export function GalleryDetailsPane({
  item,
  actions,
  onClose,
}: {
  item: HistoryItem | null;
  actions: GalleryActions;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <aside
      aria-label={t("详细信息")}
      className="flex w-70 shrink-0 flex-col border-l border-line bg-base"
    >
      <div className="flex h-10 shrink-0 items-center justify-between px-3">
        <span className="text-subhead text-primary">{t("详细信息")}</span>
        <IconButton
          size="sm"
          label={t("隐藏详情窗格")}
          icon={<IconClose size={13} />}
          onClick={onClose}
        />
      </div>
      {!item ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-footnote text-tertiary">
          {t("选择一张作品查看详情")}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          <button
            type="button"
            onClick={() => actions.open(item)}
            aria-label={t("打开")}
            className="block w-full overflow-hidden rounded-card bg-sunken"
          >
            {item.thumbUrl ? (
              <SafeImg
                src={item.thumbUrl}
                alt={item.history.prompt}
                className="aspect-square w-full object-contain"
                loading="lazy"
                decoding="async"
              />
            ) : (
              <div className="flex aspect-square items-center justify-center text-caption text-tertiary">
                {t("缩略图生成中")}
              </div>
            )}
          </button>

          <p className="mt-3 line-clamp-4 text-callout text-primary">
            {item.history.prompt || t("（无提示词）")}
          </p>

          <dl className="mt-3 flex flex-col gap-1.5">
            <Field
              label={t("模型")}
              value={item.history.model || t("未知模型")}
            />
            <Field
              label={t("尺寸")}
              value={formatDimensions(item.history.width, item.history.height)}
            />
            <Field
              label={t("大小")}
              value={formatBytes(item.history.fileSize)}
            />
            <Field
              label={t("修改日期")}
              value={formatHistoryDate(item.history.createdAt)}
            />
            <Field
              label={t("风格")}
              value={item.history.style || t("未知风格")}
            />
            <div className="flex items-center justify-between gap-2 text-caption">
              <dt className="shrink-0 text-tertiary">{t("收藏")}</dt>
              <dd>
                <button
                  type="button"
                  onClick={() => actions.toggleFavorite(item)}
                  aria-label={
                    item.history.favorite ? t("取消收藏") : t("收藏该作品")
                  }
                  className="pressable rounded-pill px-1.5 text-callout text-tertiary hover:bg-hover hover:text-primary"
                >
                  {item.history.favorite ? "★" : "☆"}
                </button>
              </dd>
            </div>
          </dl>

          <div className="mt-4 flex items-center gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              icon={<IconExpand size={13} />}
              onClick={() => actions.open(item)}
            >
              {t("打开")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<IconEdit size={13} />}
              onClick={() => actions.retouch(item)}
            >
              {t("编辑")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<IconDownload size={13} />}
              onClick={() => actions.download(item)}
            >
              {t("下载")}
            </Button>
          </div>
        </div>
      )}
    </aside>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-2 text-caption">
      <dt className="shrink-0 text-tertiary">{label}</dt>
      <dd className="min-w-0 truncate text-right text-secondary">{value}</dd>
    </div>
  );
}
