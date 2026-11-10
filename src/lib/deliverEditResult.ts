import i18n from "../i18n";
import type { EditHost } from "../stores/appStore";
import { useCanvasStore } from "../stores/canvasStore";
import { useChatStore } from "../stores/chatStore";
import { toast } from "./notify";

export interface EditOutput {
  historyId: number;
  dataUrl: string;
  filePath: string;
  /** 结果像素尺寸；缺省时按“未知”处理，回退为独立节点 */
  width?: number;
  height?: number;
}

export interface EditSource {
  historyId: number;
  /** 画布节点 id：带图层的节点 historyId 只指向底图，必须按节点定位 */
  nodeId?: string;
  host?: EditHost;
  /** 源图像素尺寸；缺省时按“未知”处理，回退为独立节点 */
  width?: number;
  height?: number;
}

export type EditDestination = "canvas" | "chat" | "gallery";

/// 内测开关：关闭后画布回写一律新建节点（v1 交互），数据不动
const LAYERED_WRITEBACK = true;

function sameSize(source: EditSource, out: EditOutput): boolean {
  return (
    source.width != null &&
    source.height != null &&
    out.width != null &&
    out.height != null &&
    source.width === out.width &&
    source.height === out.height
  );
}

/// 编辑结果落点：画布入口同尺寸追加为图层，尺寸变化（或未知）生成子节点 + 连线；
/// 其余写入当前会话；当前没有打开的会话时图片已在画廊，只提示。
export async function deliverEditResult(
  source: EditSource,
  out: EditOutput,
  label: string,
): Promise<EditDestination> {
  if (source.host === "canvas") {
    const canvas = useCanvasStore.getState();
    const from = source.nodeId
      ? canvas.nodes.find((n) => n.id === source.nodeId)
      : canvas.nodes.find((n) => n.historyId === source.historyId);
    // GIF 节点不进图层栈：转静图等结果一律作为独立节点
    // 按定位到的节点查：带图层的节点 historyId 只指向底图
    const gif = canvas.gifIds?.[from?.historyId ?? source.historyId] === true;
    if (LAYERED_WRITEBACK && from && !gif && sameSize(source, out)) {
      const name = label.trim().slice(0, 80);
      const layerId = canvas.appendLayer(from.id, {
        kind: "image",
        historyId: out.historyId,
        visible: true,
        opacity: 1,
        locked: false,
        ...(name ? { name } : {}),
      });
      if (layerId) {
        toast(i18n.t("已作为新图层加入"));
        return "canvas";
      }
    }
    const nodeId = await canvas.addHistoryNode(out.historyId);
    if (from && nodeId) {
      useCanvasStore.getState().addEdge(from.id, nodeId);
      const dimsKnown =
        source.width != null &&
        source.height != null &&
        out.width != null &&
        out.height != null;
      toast(
        dimsKnown
          ? i18n.t("尺寸已变化，已生成为独立节点")
          : i18n.t("已加入画布"),
      );
    } else {
      toast(i18n.t("已加入画布"));
    }
    return "canvas";
  }
  if (useChatStore.getState().activeId === null) {
    toast(i18n.t("已保存到画廊（当前没有打开的会话）"));
    return "gallery";
  }
  await useChatStore.getState().appendImageMessage(
    {
      historyId: out.historyId,
      dataUrl: out.dataUrl,
      path: out.filePath,
      derivedFrom: source.historyId,
    },
    label,
  );
  toast(i18n.t("已生成，结果已放入当前会话"));
  return "chat";
}
