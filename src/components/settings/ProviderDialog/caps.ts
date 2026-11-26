import { ModelCaps } from "../../../lib/api";
import { DEFAULT_MODEL_CAPS, heuristicCaps } from "../../../lib/useModelCaps";
import { recommendDefaultModel } from "./modelPull";

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

/** 重新拉取后丢弃已消失模型的能力修改，保留仍在列表里的条目 */
export function pruneCapsEdits(
  edits: Record<string, ModelCaps>,
  models: readonly string[],
): Record<string, ModelCaps> {
  const alive = new Set(models);
  return Object.fromEntries(
    Object.entries(edits).filter(([model]) => alive.has(model)),
  );
}

/**
 * 拉取完成后保留用户选择：仍存在的默认模型原样保留；
 * 默认模型消失时按推荐规则重选，首次拉取也补一个推荐默认值；
 * 用户主动清空的默认模型不在重新拉取时被重置。
 */
export function keepDefaultModel(
  models: readonly string[],
  prevDefault: string,
  recommend: boolean,
): string {
  if (prevDefault && models.includes(prevDefault)) return prevDefault;
  return recommend ? recommendDefaultModel(models) : "";
}
