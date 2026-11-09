import { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "../ui/cn";
import {
  IconClose,
  IconWindowMaximize,
  IconWindowMinimize,
  IconWindowRestore,
} from "../Icons";
import { inTauri } from "../../hooks/useWindowState";

/// 窗口控制钮：46×48 命中区，图标 11px。
///
/// 关闭键悬停用系统红（--window-close），而不是应用强调色 —— 破坏性操作
/// 保持系统语义，和 macOS 红绿灯一致。
function Control({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex h-12 w-[46px] items-center justify-center text-secondary transition-colors duration-150",
        danger
          ? "hover:bg-window-close hover:text-on-window-close"
          : "hover:bg-hover hover:text-primary",
      )}
    >
      {children}
    </button>
  );
}

export default function WindowControls({
  isMaximized,
}: {
  isMaximized: boolean;
}) {
  const { t } = useTranslation();
  const win = () => getCurrentWindow();
  const guard = (fn: () => Promise<void>) => () => {
    if (inTauri()) void fn().catch(() => undefined);
  };

  return (
    <div className="flex h-full items-stretch">
      <Control label={t("最小化")} onClick={guard(() => win().minimize())}>
        <IconWindowMinimize size={12} strokeWidth={1.2} />
      </Control>
      <Control
        label={isMaximized ? t("还原") : t("最大化")}
        onClick={guard(() => win().toggleMaximize())}
      >
        {isMaximized ? (
          <IconWindowRestore size={12} strokeWidth={1.2} />
        ) : (
          <IconWindowMaximize size={12} strokeWidth={1.2} />
        )}
      </Control>
      <Control danger label={t("关闭")} onClick={guard(() => win().close())}>
        <IconClose size={12} strokeWidth={1.4} />
      </Control>
    </div>
  );
}
