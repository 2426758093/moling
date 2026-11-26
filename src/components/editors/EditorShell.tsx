import { ReactNode, useEffect, useId, useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { DUR, EASE } from "../../lib/motion";
import { IconButton } from "../ui/IconButton";
import { IconClose } from "../Icons";
import { cn } from "../ui/cn";

interface EditorShellProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /// 全屏浮层 / 画布内嵌两种定位
  inline: boolean;
  onClose: () => void;
  /// 标题行右侧的主操作（提交、应用等），关闭按钮固定在其后
  headerExtra?: ReactNode;
  /// 工具条：与标题行同处一块纸面，避免两条分割线叠出接缝
  toolbar?: ReactNode;
  /// 内容区下方的一切（底部操作栏、错误条等），按顺序堆叠
  footer?: ReactNode;
  children: ReactNode;
  contentClassName?: string;
  ariaLabel?: string;
}

/// 编辑器统一外壳：定位、进出场动画、标题栏、关闭按钮与 Esc 监听只在这里写一遍。
/// 内容区保持 `flex-1 min-h-0`，各编辑器只接管自己的工具条、画布与底部操作条。
export default function EditorShell({
  title,
  subtitle,
  inline,
  onClose,
  headerExtra,
  toolbar,
  footer,
  children,
  contentClassName,
  ariaLabel,
}: EditorShellProps) {
  const { t } = useTranslation();
  const reduce = useReducedMotion();
  const titleId = useId();

  // 关闭后把焦点还给触发元素。触发元素已被移除时不做处理，交给浏览器默认行为。
  const restoreRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = document.activeElement;
    restoreRef.current = el instanceof HTMLElement ? el : null;
    const prev = restoreRef.current;
    return () => {
      if (prev && prev.isConnected && prev !== document.body) {
        prev.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduce ? 0 : DUR.base, ease: EASE.ios }}
      role="dialog"
      // 内嵌在画布里时并不隔断周围内容，语义上只当对话框容器用
      aria-modal={inline ? undefined : true}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel ? undefined : titleId}
      className={cn(
        "flex flex-col bg-base",
        inline ? "h-full min-h-0 w-full" : "absolute inset-0 z-30",
      )}
    >
      <header className="relative z-10 shrink-0 border-b border-separator bg-base">
        <div className="flex min-h-12 items-center gap-3 px-6 py-2">
          <div className="flex min-w-0 flex-col">
            <h1 id={titleId} className="truncate text-title3 text-primary">
              {title}
            </h1>
            {subtitle != null && (
              <p className="truncate text-footnote tabular-nums text-tertiary">
                {subtitle}
              </p>
            )}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {headerExtra}
            <IconButton
              label={t("关闭")}
              icon={<IconClose size={16} />}
              onClick={onClose}
            />
          </div>
        </div>
        {toolbar}
      </header>

      <div
        className={cn(
          "relative flex min-h-0 flex-1 items-center justify-center overflow-hidden",
          contentClassName,
        )}
      >
        {children}
      </div>

      {footer}
    </motion.div>
  );
}
