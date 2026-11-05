import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ReactNode } from "react";
import { IconClose } from "../Icons";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { cn } from "./cn";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /// 读屏用的补充说明；有可见说明时也放这里（屏幕阅读器会播报一次）
  description?: string;
  children?: ReactNode;
  /// 底部操作区，右对齐
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const SIZE = {
  sm: "max-w-[min(400px,100vw-48px)]",
  md: "max-w-[min(480px,100vw-48px)]",
  lg: "max-w-[min(640px,100vw-48px)]",
} as const;

/// 浮层一律 portal 到 body：在 `relative` 容器内渲染遮罩会被父级 overflow 裁掉
/// （服务商弹窗曾因此在设置页里被切掉一半）。焦点陷阱与关闭后归还焦点由 Radix 保证。
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
  className,
}: DialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="anim-overlay fixed inset-0 z-50 bg-scrim" />
        <DialogPrimitive.Content
          className={cn(
            "anim-sheet fixed left-1/2 top-1/2 z-[51] flex w-full -translate-x-1/2 -translate-y-1/2 flex-col",
            "max-h-[calc(100vh-64px)] rounded-sheet bg-elevated shadow-sheet",
            SIZE[size],
            className,
          )}
        >
          <header className="flex items-start justify-between gap-4 px-5 pt-4 pb-2">
            <div className="flex min-w-0 flex-col gap-1">
              <DialogPrimitive.Title className="text-title2 text-primary">
                {title}
              </DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="text-subhead text-tertiary">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <IconButton
              label="关闭"
              size="sm"
              tooltip={false}
              icon={<IconClose size={16} />}
              onClick={() => onOpenChange(false)}
            />
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-2">
            {children}
          </div>
          {footer && (
            <footer className="flex items-center justify-end gap-2 px-5 pt-2 pb-4">
              {footer}
            </footer>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/// 确认浮层：需要用户决策时用它替代 window.confirm
interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "确定",
  cancelLabel = "取消",
  danger = false,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {description && <p className="text-body text-secondary">{description}</p>}
    </Dialog>
  );
}
