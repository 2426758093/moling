import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Fragment, ReactNode } from "react";
import { cn } from "./cn";

export interface MenuItem {
  id: string;
  label: string;
  /// 必填：菜单项没有图标会很难扫读（Apple HIG 对菜单的硬性要求）
  icon: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /// 置灰原因：作为原生 tooltip 展示（Radix 菜单项内再套 Tooltip 会抢焦点）
  hint?: string;
  /// 在这一项之前画一条分隔线
  separatorBefore?: boolean;
  onSelect: () => void;
  /// 右侧快捷键提示（例如 "Ctrl N"）。只做展示，绑定在 lib/shortcuts.ts
  shortcut?: string;
}

const CONTENT = "anim-pop z-[55] min-w-48 rounded-pop glass p-1.5 shadow-pop";

function itemClass(danger?: boolean) {
  return cn(
    "flex h-7 cursor-pointer select-none items-center gap-2 rounded-chip px-2 text-callout",
    "data-[highlighted]:bg-hover data-[disabled]:cursor-not-allowed data-[disabled]:text-quaternary",
    danger ? "text-danger" : "text-primary",
  );
}

/// 右键菜单。键盘：方向键移动、Home/End 跳首末、Esc 关闭并归还焦点 —— 由 Radix 保证。
export function ContextMenu({
  items,
  children,
  disabled = false,
}: {
  items: MenuItem[];
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger asChild disabled={disabled}>
        {children}
      </ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content className={CONTENT}>
          {items.map((item) => (
            <Fragment key={item.id}>
              {item.separatorBefore && (
                <ContextMenuPrimitive.Separator className="my-1 h-px bg-separator" />
              )}
              <ContextMenuPrimitive.Item
                disabled={item.disabled}
                onSelect={item.onSelect}
                title={item.hint}
                className={itemClass(item.danger)}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-4 [&>svg]:w-4">
                  {item.icon}
                </span>
                <span className="flex-1">{item.label}</span>
                {item.shortcut && (
                  <span className="text-caption text-quaternary">
                    {item.shortcut}
                  </span>
                )}
              </ContextMenuPrimitive.Item>
            </Fragment>
          ))}
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}

/// 点击式下拉菜单（"更多"按钮、栏头操作）
export function DropdownMenu({
  items,
  children,
  align = "end",
}: {
  items: MenuItem[];
  children: ReactNode;
  align?: "start" | "end";
}) {
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        {children}
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align={align}
          sideOffset={6}
          className={CONTENT}
        >
          {items.map((item) => (
            <Fragment key={item.id}>
              {item.separatorBefore && (
                <DropdownMenuPrimitive.Separator className="my-1 h-px bg-separator" />
              )}
              <DropdownMenuPrimitive.Item
                disabled={item.disabled}
                onSelect={item.onSelect}
                title={item.hint}
                className={itemClass(item.danger)}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-4 [&>svg]:w-4">
                  {item.icon}
                </span>
                <span className="flex-1">{item.label}</span>
                {item.shortcut && (
                  <span className="text-caption text-quaternary">
                    {item.shortcut}
                  </span>
                )}
              </DropdownMenuPrimitive.Item>
            </Fragment>
          ))}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
