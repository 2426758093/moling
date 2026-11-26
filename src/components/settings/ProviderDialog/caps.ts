import { ModelCaps } from "../../../lib/api";
import { DEFAULT_MODEL_CAPS, heuristicCaps } from "../../../lib/useModelCaps";

export { DEFAULT_MODEL_CAPS, heuristicCaps };

/** 模型能力表字段（仅驱动界面开关，不改变请求形状） */
export const CAP_FIELDS = [
  { key: "negative", label: "负向提示词" },
  { key: "edit", label: "编辑能力" },
  { key: "instructionEdit", label: "指令改图" },
  { key: "transform", label: "变换能力" },
  { key: "multiImage", label: "多参考图" },
  { key: "gif", label: "GIF 输出" },
] as const;

/**
 * 能力取值优先级：本次编辑覆盖项 → 已保存能力表 → 拉取模型后的启发式默认值
 */
export function resolveCaps(
  model: string,
  edits: Record<string, ModelCaps>,
  stored: Record<string, ModelCaps>,
): ModelCaps {
  return edits[model] ?? stored[model] ?? heuristicCaps(model);
}
