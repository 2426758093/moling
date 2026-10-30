import { useEffect, useState } from "react";
import { useCanvasStore } from "../stores/canvasStore";
import { SegmentedControl } from "./ui/SegmentedControl";
import { Select } from "./ui/Select";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Dialog, ConfirmDialog } from "./ui/Dialog";
import { Input } from "./ui/Field";
import { DropdownMenu, MenuItem } from "./ui/Menu";
import PageHeader from "./PageHeader";
import CanvasBoard from "./CanvasBoard";
import CanvasAddDialog from "./CanvasAddDialog";
import { IconBrush, IconChevron, IconLink, IconPlus, IconTrash } from "./Icons";

function NameDialog({
  title,
  description,
  initial,
  confirmLabel,
  onClose,
  onSubmit,
}: {
  title: string;
  description: string;
  initial: string;
  confirmLabel: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<boolean>;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();

  const submit = async () => {
    if (!trimmed || busy) return;
    setBusy(true);
    const ok = await onSubmit(trimmed);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!trimmed}
            onClick={() => void submit()}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <Input
        label="画布名称"
        value={name}
        maxLength={80}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
      />
    </Dialog>
  );
}

export default function CanvasView() {
  const ensureLoaded = useCanvasStore((s) => s.ensureLoaded);
  const boards = useCanvasStore((s) => s.boards);
  const activeId = useCanvasStore((s) => s.activeId);
  const activeName = useCanvasStore((s) => s.activeName);
  const nodeCount = useCanvasStore((s) => s.nodes.length);
  const zoom = useCanvasStore((s) => s.viewport.zoom);
  const dirty = useCanvasStore((s) => s.dirty);
  const saving = useCanvasStore((s) => s.saving);
  const createBoard = useCanvasStore((s) => s.createBoard);
  const selectBoard = useCanvasStore((s) => s.selectBoard);
  const renameBoard = useCanvasStore((s) => s.renameBoard);
  const deleteBoard = useCanvasStore((s) => s.deleteBoard);

  const [addOpen, setAddOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [wireMode, setWireMode] = useState(false);
  const [fitSignal, setFitSignal] = useState(0);

  useEffect(() => {
    void ensureLoaded();
  }, [ensureLoaded]);

  // 节点少于两个时连线没有意义：切画布后自动退回浏览模式
  const wireActive = wireMode && nodeCount >= 2;
  const status = saving
    ? "保存中…"
    : dirty
      ? "未保存"
      : activeId != null
        ? "已保存"
        : "";

  const moreItems: MenuItem[] = [
    {
      id: "rename",
      label: "重命名画布",
      icon: <IconBrush size={14} />,
      onSelect: () => setRenameOpen(true),
    },
    {
      id: "delete",
      label: "删除画布",
      icon: <IconTrash size={14} />,
      danger: true,
      separatorBefore: true,
      onSelect: () => setDeleteOpen(true),
    },
  ];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-base">
      <PageHeader
        title="画布"
        subtitle={
          activeId != null
            ? `${activeName} · ${nodeCount} 个节点${status ? ` · ${status}` : ""}`
            : "把作品放到一张无限画布上，再从节点进入编辑"
        }
        actions={
          <>
            {boards.length > 0 && (
              <Select
                value={activeId != null ? String(activeId) : ""}
                onValueChange={(v) => {
                  if (v) void selectBoard(Number(v));
                }}
                options={boards.map((b) => ({
                  value: String(b.id),
                  label: b.name,
                }))}
                label="切换画布"
                variant="bare"
                widthClass="w-40"
              />
            )}
            <Button
              size="sm"
              icon={<IconPlus size={14} />}
              onClick={() => setCreateOpen(true)}
            >
              新建
            </Button>
            {activeId != null && (
              <DropdownMenu items={moreItems} align="end">
                <IconButton
                  label="画布操作"
                  size="sm"
                  tooltip={false}
                  icon={<IconChevron direction="down" size={14} />}
                />
              </DropdownMenu>
            )}
            <Button
              size="sm"
              variant="primary"
              icon={<IconPlus size={14} />}
              onClick={() => setAddOpen(true)}
            >
              添加图片
            </Button>
          </>
        }
        footer={
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              value={wireActive ? "wire" : "move"}
              onValueChange={(v) => setWireMode(v === "wire")}
              label="画布模式"
              size="sm"
              options={[
                { value: "move", label: "浏览" },
                {
                  value: "wire",
                  label: "连线",
                  icon: <IconLink size={13} />,
                  disabled: nodeCount < 2,
                },
              ]}
            />
            <Button size="sm" onClick={() => setFitSignal((n) => n + 1)}>
              适应视图
            </Button>
            <span className="text-footnote text-tertiary">
              缩放 {Math.round(zoom * 100)}%
            </span>
            <span className="ml-auto hidden text-footnote text-quaternary compact:block">
              拖动空白处平移 · 滚轮缩放 · 选中连线后 Delete 删除
            </span>
          </div>
        }
      />

      <CanvasBoard
        wireMode={wireActive}
        onWireModeChange={(on) => setWireMode(on)}
        fitSignal={fitSignal}
        onAddImage={() => setAddOpen(true)}
      />

      <CanvasAddDialog open={addOpen} onOpenChange={setAddOpen} />

      {createOpen && (
        <NameDialog
          title="新建画布"
          description="给这张画布起个名字，之后可以随时切换"
          initial=""
          confirmLabel="创建"
          onClose={() => setCreateOpen(false)}
          onSubmit={async (name) => {
            const id = await createBoard(name);
            return id != null;
          }}
        />
      )}

      {renameOpen && (
        <NameDialog
          title="重命名画布"
          description="名称会随画布一起保存"
          initial={activeName}
          confirmLabel="保存"
          onClose={() => setRenameOpen(false)}
          onSubmit={async (name) => {
            renameBoard(name);
            return true;
          }}
        />
      )}

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="删除这张画布？"
        description="画布内的节点与连线会被删除，画廊里的作品不受影响。"
        confirmLabel="删除"
        danger
        onConfirm={() => void deleteBoard(activeId ?? -1)}
      />
    </div>
  );
}
