import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "../ui/cn";
import { inTauri } from "../../hooks/useWindowState";

/// Tauri 没有导出这个类型（只在 d.ts 内部声明），这里按 API 契约复述一份。
type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

/// 无边框窗口的 8 向缩放命中区：边 4px、角 12×12。
///
/// 最大化时整个不渲染 —— 最大化状态下的缩放操作会被系统忽略，
/// 留着只会挡住边缘的点击。容器本身 pointer-events-none，只有命中区可点。
const EDGES: { dir: ResizeDirection; className: string }[] = [
  { dir: "North", className: "inset-x-3 top-0 h-1 cursor-ns-resize" },
  { dir: "South", className: "inset-x-3 bottom-0 h-1 cursor-ns-resize" },
  { dir: "West", className: "inset-y-3 left-0 w-1 cursor-ew-resize" },
  { dir: "East", className: "inset-y-3 right-0 w-1 cursor-ew-resize" },
  {
    dir: "NorthWest",
    className: "left-0 top-0 h-3 w-3 cursor-nwse-resize",
  },
  {
    dir: "NorthEast",
    className: "right-0 top-0 h-3 w-3 cursor-nesw-resize",
  },
  {
    dir: "SouthWest",
    className: "bottom-0 left-0 h-3 w-3 cursor-nesw-resize",
  },
  {
    dir: "SouthEast",
    className: "bottom-0 right-0 h-3 w-3 cursor-nwse-resize",
  },
];

export default function ResizeHandles({
  isMaximized,
}: {
  isMaximized: boolean;
}) {
  if (isMaximized || !inTauri()) return null;

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-50 print:hidden"
    >
      {EDGES.map(({ dir, className }) => (
        <div
          key={dir}
          className={cn("pointer-events-auto fixed", className)}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            void getCurrentWindow()
              .startResizeDragging(dir)
              .catch(() => undefined);
          }}
        />
      ))}
    </div>
  );
}
