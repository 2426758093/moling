import { IconImage } from "../Icons";

/// 拖拽遮罩：只负责提示，事件仍由 App 根节点处理（计数在 App 内维护）。
export default function DropOverlay() {
  return (
    <div className="pointer-events-none fixed inset-0 z-[45] flex items-center justify-center bg-scrim/40 p-8">
      <div className="glass flex flex-col items-center gap-2 rounded-panel border-2 border-dashed border-accent/60 px-12 py-9 text-center shadow-sheet">
        <span className="flex size-11 items-center justify-center rounded-card bg-accent-soft text-accent">
          <IconImage size={22} strokeWidth={1.6} />
        </span>
        <div className="text-title3 text-primary">松开以添加参考图</div>
        <p className="text-footnote text-tertiary">
          支持 PNG / JPG / WebP，会加入当前对话的参考图
        </p>
      </div>
    </div>
  );
}
