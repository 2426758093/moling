import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/appStore";
import { useCanvasStore } from "../stores/canvasStore";
import { Select } from "./ui/Select";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Dialog, ConfirmDialog } from "./ui/Dialog";
import { Input } from "./ui/Field";
import { DropdownMenu, MenuItem } from "./ui/Menu";
import PageHeader from "./PageHeader";
import CanvasBoard from "./CanvasBoard";
import CanvasAddDialog from "./CanvasAddDialog";
import EditorView from "./EditorView";
import OutpaintView from "./OutpaintView";
import BasicEditView from "./BasicEditView";
import BackgroundView from "./BackgroundView";
import AnimationView from "./AnimationView";
import RegionEditView from "./RegionEditView";
import { IconBrush, IconChevron, IconPlus, IconTrash } from "./Icons";

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
  const { t } = useTranslation();
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
            {t("取消")}
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
        label={t("画布名称")}
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
  const { t } = useTranslation();
  const ensureLoaded = useCanvasStore((s) => s.ensureLoaded);
  const boards = useCanvasStore((s) => s.boards);
  const activeId = useCanvasStore((s) => s.activeId);
  const activeName = useCanvasStore((s) => s.activeName);
  const nodeCount = useCanvasStore((s) => s.nodes.length);
  const dirty = useCanvasStore((s) => s.dirty);
  const saving = useCanvasStore((s) => s.saving);
  const createBoard = useCanvasStore((s) => s.createBoard);
  const selectBoard = useCanvasStore((s) => s.selectBoard);
  const renameBoard = useCanvasStore((s) => s.renameBoard);
  const deleteBoard = useCanvasStore((s) => s.deleteBoard);
  const canvasInline = useAppStore((s) => s.canvasInline);
  const editTarget = useAppStore((s) => s.editTarget);
  const outpaintTarget = useAppStore((s) => s.outpaintTarget);
  const basicEditTarget = useAppStore((s) => s.basicEditTarget);
  const backgroundTarget = useAppStore((s) => s.backgroundTarget);
  const animationTarget = useAppStore((s) => s.animationTarget);
  const regionTarget = useAppStore((s) => s.regionTarget);

  const [addOpen, setAddOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [wireMode, setWireMode] = useState(false);

  // 画布节点的编辑入口在这里就地展开，结果回写画布节点
  const inlinePanel = !canvasInline ? null : editTarget?.host === "canvas" ? (
    <EditorView />
  ) : outpaintTarget?.host === "canvas" ? (
    <OutpaintView />
  ) : basicEditTarget?.host === "canvas" ? (
    <BasicEditView />
  ) : backgroundTarget?.host === "canvas" ? (
    <BackgroundView />
  ) : animationTarget?.host === "canvas" ? (
    <AnimationView />
  ) : regionTarget?.host === "canvas" ? (
    <RegionEditView />
  ) : null;

  useEffect(() => {
    void ensureLoaded();
  }, [ensureLoaded]);

  // 节点少于两个时连线没有意义：切画布后自动退回浏览模式
  const wireActive = wireMode && nodeCount >= 2;
  const status = saving
    ? t("保存中…")
    : dirty
      ? t("未保存")
      : activeId != null
        ? t("已保存")
        : "";

  const moreItems: MenuItem[] = [
    {
      id: "rename",
      label: t("重命名画布"),
      icon: <IconBrush size={14} />,
      onSelect: () => setRenameOpen(true),
    },
    {
      id: "delete",
      label: t("删除画布"),
      icon: <IconTrash size={14} />,
      danger: true,
      separatorBefore: true,
      onSelect: () => setDeleteOpen(true),
    },
  ];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title={t("画布")}
        subtitle={
          activeId != null ? (
            <span className="flex items-center gap-2">
              <span className="truncate">
                {t("{{name}} · {{n}} 个节点", {
                  name: activeName,
                  n: nodeCount,
                })}
              </span>
              {status && (
                <Badge
                  tone={saving ? "neutral" : dirty ? "warning" : "success"}
                >
                  {status}
                </Badge>
              )}
            </span>
          ) : (
            t("把作品放到一张无限画布上，再从节点进入编辑")
          )
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
                label={t("切换画布")}
                variant="chip"
                widthClass="w-32"
              />
            )}
            <IconButton
              label={t("新建画布")}
              size="sm"
              icon={<IconPlus size={14} />}
              onClick={() => setCreateOpen(true)}
            />
            {activeId != null && (
              <DropdownMenu items={moreItems} align="end">
                <IconButton
                  label={t("画布操作")}
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
              {t("添加图片")}
            </Button>
          </>
        }
      />

      <div className="flex min-h-0 min-w-0 flex-1 gap-2">
        <CanvasBoard
          wireMode={wireActive}
          onWireModeChange={(on) => setWireMode(on)}
          onAddImage={() => setAddOpen(true)}
        />
        {inlinePanel && (
          <aside
            aria-label={t("画布编辑面板")}
            className={`flex ${
              regionTarget?.host === "canvas"
                ? "w-[min(560px,52%)]"
                : "w-[min(440px,46%)]"
            } min-w-0 shrink-0 flex-col overflow-hidden rounded-card border border-line bg-base shadow-card`}
          >
            {inlinePanel}
          </aside>
        )}
      </div>

      <CanvasAddDialog open={addOpen} onOpenChange={setAddOpen} />

      {createOpen && (
        <NameDialog
          title={t("新建画布")}
          description={t("给这张画布起个名字，之后可以随时切换")}
          initial=""
          confirmLabel={t("创建")}
          onClose={() => setCreateOpen(false)}
          onSubmit={async (name) => {
            const id = await createBoard(name);
            return id != null;
          }}
        />
      )}

      {renameOpen && (
        <NameDialog
          title={t("重命名画布")}
          description={t("名称会随画布一起保存")}
          initial={activeName}
          confirmLabel={t("保存")}
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
        title={t("删除这张画布？")}
        description={t("画布内的节点与连线会被删除，画廊里的作品不受影响。")}
        confirmLabel={t("删除")}
        danger
        onConfirm={() => void deleteBoard(activeId ?? -1)}
      />
    </div>
  );
}
