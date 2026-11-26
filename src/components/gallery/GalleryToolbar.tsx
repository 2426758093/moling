import { useTranslation } from "react-i18next";
import type { GallerySort, GroupBy, ViewMode } from "../../lib/galleryView";
import {
  GROUP_OPTIONS,
  SORT_OPTIONS,
  VIEW_OPTIONS,
} from "../../lib/galleryView";
import type { SortOrder } from "../../lib/api";
import {
  IconCheck,
  IconChevron,
  IconGrid,
  IconImage,
  IconPanelLeft,
  IconQueue,
  IconRotate,
  IconSearch,
} from "../Icons";
import { DropdownMenu, MenuItem } from "../ui/Menu";
import { IconButton } from "../ui/IconButton";
import { Select } from "../ui/Select";
import { SegmentedControl } from "../ui/SegmentedControl";

const TRIGGER =
  "pressable inline-flex h-7 max-w-full items-center gap-1.5 rounded-btn px-2 text-callout text-secondary transition-colors hover:bg-hover hover:text-primary";

function viewIcon(mode: ViewMode) {
  switch (mode) {
    case "list":
      return <IconQueue size={14} />;
    case "details":
      return <IconPanelLeft size={14} />;
    case "tiles":
      return <IconImage size={14} />;
    case "content":
      return <IconGrid size={14} />;
    default:
      return <IconGrid size={14} />;
  }
}

function check(active: boolean) {
  return active ? (
    <IconCheck size={14} />
  ) : (
    <span aria-hidden className="block size-4" />
  );
}

export function GalleryToolbar({
  mode,
  sort,
  order,
  group,
  detailsPane,
  searchText,
  modelFilter,
  models,
  styleFilter,
  styles,
  favOnly,
  onSearchChange,
  onModeChange,
  onSortChange,
  onOrderChange,
  onGroupChange,
  onToggleDetails,
  onModelChange,
  onStyleChange,
  onFavOnlyChange,
  onRefresh,
}: {
  mode: ViewMode;
  sort: GallerySort;
  order: SortOrder;
  group: GroupBy;
  detailsPane: boolean;
  searchText: string;
  modelFilter: string;
  models: string[];
  styleFilter: string;
  styles: { id: string; label: string }[];
  favOnly: boolean;
  onSearchChange: (value: string) => void;
  onModeChange: (mode: ViewMode) => void;
  onSortChange: (sort: GallerySort) => void;
  onOrderChange: (order: SortOrder) => void;
  onGroupChange: (group: GroupBy) => void;
  onToggleDetails: () => void;
  onModelChange: (value: string) => void;
  onStyleChange: (value: string) => void;
  onFavOnlyChange: (value: boolean) => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const viewOption =
    VIEW_OPTIONS.find((option) => option.value === mode) ?? VIEW_OPTIONS[1];
  const sortOption =
    SORT_OPTIONS.find((option) => option.value === sort) ?? SORT_OPTIONS[1];
  const groupOption =
    GROUP_OPTIONS.find((option) => option.value === group) ?? GROUP_OPTIONS[0];

  const viewItems: MenuItem[] = VIEW_OPTIONS.map((option) => ({
    id: option.value,
    label: t(option.label),
    icon: check(option.value === mode),
    onSelect: () => onModeChange(option.value),
  }));

  const sortItems: MenuItem[] = [
    ...SORT_OPTIONS.map((option) => ({
      id: `sort-${option.value}`,
      label: t(option.label),
      icon: check(option.value === sort),
      onSelect: () => onSortChange(option.value),
    })),
    {
      id: "order-asc",
      label: t("升序"),
      icon: check(order === "asc"),
      separatorBefore: true,
      onSelect: () => onOrderChange("asc"),
    },
    {
      id: "order-desc",
      label: t("降序"),
      icon: check(order === "desc"),
      onSelect: () => onOrderChange("desc"),
    },
  ];

  const groupItems: MenuItem[] = GROUP_OPTIONS.map((option) => ({
    id: option.value,
    label: t(option.label),
    icon: check(option.value === group),
    onSelect: () => onGroupChange(option.value),
  }));

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <label className="relative flex h-7 items-center">
        <span className="pointer-events-none absolute left-2 flex text-tertiary">
          <IconSearch size={14} />
        </span>
        <input
          type="search"
          value={searchText}
          onChange={(e) => onSearchChange(e.target.value)}
          aria-label={t("搜索作品")}
          placeholder={t("搜索提示词或模型")}
          className="h-7 w-52 rounded-btn bg-elevated pl-7 pr-2 text-callout text-primary shadow-card outline-none placeholder:text-tertiary focus-visible:ring-1 focus-visible:ring-accent"
        />
      </label>

      <DropdownMenu items={viewItems}>
        <button
          type="button"
          aria-label={t("视图")}
          title={t("视图")}
          className={TRIGGER}
        >
          {viewIcon(mode)}
          <span className="truncate">{t(viewOption.label)}</span>
          <IconChevron size={12} direction="down" />
        </button>
      </DropdownMenu>

      <DropdownMenu items={sortItems}>
        <button
          type="button"
          aria-label={t("排序")}
          title={t("排序")}
          className={TRIGGER}
        >
          <span className="truncate">
            {t("排序：{{name}}", { name: t(sortOption.label) })}
          </span>
          <IconChevron size={12} direction="down" />
        </button>
      </DropdownMenu>

      <DropdownMenu items={groupItems}>
        <button
          type="button"
          aria-label={t("分组")}
          title={t("分组")}
          className={TRIGGER}
        >
          <span className="truncate">
            {t("分组：{{name}}", { name: t(groupOption.label) })}
          </span>
          <IconChevron size={12} direction="down" />
        </button>
      </DropdownMenu>

      <IconButton
        size="sm"
        variant={detailsPane ? "secondary" : "ghost"}
        label={detailsPane ? t("隐藏详情窗格") : t("显示详情窗格")}
        icon={<IconPanelLeft size={14} />}
        onClick={onToggleDetails}
      />

      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        <Select
          value={modelFilter || "all"}
          onValueChange={(value) => onModelChange(value === "all" ? "" : value)}
          options={[
            { value: "all", label: t("全部模型") },
            ...models.map((model) => ({ value: model, label: model })),
          ]}
          label={t("按模型筛选")}
          variant="chip"
          widthClass="w-32"
        />
        <Select
          value={styleFilter || "all"}
          onValueChange={(value) => onStyleChange(value === "all" ? "" : value)}
          options={[
            { value: "all", label: t("全部风格") },
            ...styles.map((style) => ({ value: style.id, label: style.label })),
          ]}
          label={t("按风格筛选")}
          variant="chip"
          widthClass="w-28"
        />
        <SegmentedControl
          value={favOnly ? "fav" : "all"}
          onValueChange={(value) => onFavOnlyChange(value === "fav")}
          label={t("收藏筛选")}
          size="sm"
          options={[
            { value: "all", label: t("全部") },
            { value: "fav", label: t("只看收藏") },
          ]}
        />
        <IconButton
          size="sm"
          label={t("刷新")}
          icon={<IconRotate size={14} />}
          onClick={onRefresh}
        />
      </div>
    </div>
  );
}
