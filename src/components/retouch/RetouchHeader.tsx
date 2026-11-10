import { useTranslation } from "react-i18next";
import type { UiMode } from "../../lib/types";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { SegmentedControl } from "../ui/SegmentedControl";
import { IconChevron, IconClose } from "../Icons";

interface Props {
  /** 内嵌在画布侧栏：省掉「返回」，只留标题 / 模式 / 关闭，高度更紧凑 */
  embedded: boolean;
  /** 底图名称（缺省只显示「修图台」） */
  title?: string;
  mode: UiMode;
  /** 没有底图时不需要切换模式 */
  showMode: boolean;
  onModeChange: (mode: UiMode) => void;
  onBack: () => void;
}

/// 修图台栏头：返回 · 标题 · 简单/专家 · 关闭。
/// 内嵌模式省掉「返回」（用户没有离开视图，只是关掉面板），
/// 但保留一个「关闭」：画布侧栏自己不开关闭路径。
export default function RetouchHeader({
  embedded,
  title,
  mode,
  showMode,
  onModeChange,
  onBack,
}: Props) {
  const { t } = useTranslation();

  const modeControl = showMode ? (
    <SegmentedControl
      value={mode}
      onValueChange={onModeChange}
      label={t("界面模式")}
      size="sm"
      options={[
        { value: "simple", label: t("简单") },
        { value: "expert", label: t("专家") },
      ]}
    />
  ) : null;

  if (embedded) {
    return (
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-separator px-2">
        <span className="shrink-0 text-subhead text-primary">
          {t("修图台")}
        </span>
        <span className="min-w-0 flex-1 truncate text-caption text-tertiary">
          {title}
        </span>
        {modeControl}
        {/* 内嵌面板由画布侧栏承载，画布本身不提供关闭路径，这里给一个 */}
        <IconButton
          label={t("关闭")}
          icon={<IconClose size={14} />}
          size="sm"
          onClick={onBack}
        />
      </div>
    );
  }

  return (
    <header className="relative z-10 flex h-11 shrink-0 items-center gap-3 border-b border-separator px-4">
      <Button
        size="sm"
        variant="ghost"
        icon={<IconChevron direction="left" size={14} />}
        onClick={onBack}
      >
        {t("返回")}
      </Button>
      <h1 className="shrink-0 truncate text-title2 text-primary">
        {t("修图台")}
      </h1>
      {title && (
        <p className="min-w-0 truncate text-footnote text-tertiary">{title}</p>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {modeControl}
        <IconButton
          label={t("关闭")}
          icon={<IconClose size={16} />}
          size="sm"
          onClick={onBack}
        />
      </div>
    </header>
  );
}
