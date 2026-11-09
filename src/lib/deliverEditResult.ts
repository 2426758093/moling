import i18n from "../i18n";
import type { EditHost } from "../stores/appStore";
import { useCanvasStore } from "../stores/canvasStore";
import { useChatStore } from "../stores/chatStore";
import { toast } from "./notify";

export interface EditOutput {
  historyId: number;
  dataUrl: string;
  filePath: string;
}

export interface EditSource {
  historyId: number;
  host?: EditHost;
}

export type EditDestination = "canvas" | "chat" | "gallery";

/// 编辑结果落点：画布入口回写画布（新节点 + 来源连线），其余写入当前会话；
/// 当前没有打开的会话时图片已在画廊，只提示。
export async function deliverEditResult(
  source: EditSource,
  out: EditOutput,
  label: string,
): Promise<EditDestination> {
  if (source.host === "canvas") {
    const canvas = useCanvasStore.getState();
    const from = canvas.nodes.find((n) => n.historyId === source.historyId);
    const nodeId = await canvas.addHistoryNode(out.historyId);
    if (from && nodeId) useCanvasStore.getState().addEdge(from.id, nodeId);
    toast(i18n.t("已加入画布"));
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
