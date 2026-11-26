import { useTranslation } from "react-i18next";
import {
  ICON_SIZE_MAX,
  ICON_SIZE_MIN,
  ICON_SIZE_STEP,
  VIEW_OPTIONS,
  type ViewMode,
} from "../../lib/galleryView";
import { Slider } from "../ui/Slider";

/// 底部状态栏：数量摘要 + 缩放滑杆 + 当前视图名
export function GalleryStatusBar({
  total,
  selectedCount,
  iconSize,
  mode,
  onIconSizeChange,
}: {
  total: number;
  selectedCount: number;
  iconSize: number;
  mode: ViewMode;
  onIconSizeChange: (value: number) => void;
}) {
  const { t } = useTranslation();
  const viewOption =
    VIEW_OPTIONS.find((option) => option.value === mode) ?? VIEW_OPTIONS[1];
  return (
    <div className="flex h-9 shrink-0 items-center gap-3 border-t border-line px-4">
      <span className="tabular text-caption text-tertiary">
        {t("共 {{n}} 张", { n: total })}
      </span>
      <span aria-hidden className="text-caption text-quaternary">
        ·
      </span>
      <span className="tabular text-caption text-tertiary">
        {t("已选 {{n}} 张", { n: selectedCount })}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <span className="hidden text-caption text-quaternary sm:block">
          {t(viewOption.label)}
        </span>
        <Slider
          value={iconSize}
          min={ICON_SIZE_MIN}
          max={ICON_SIZE_MAX}
          step={ICON_SIZE_STEP}
          onValueChange={onIconSizeChange}
          label={t("缩略图大小")}
          className="w-36"
        />
      </div>
    </div>
  );
}
