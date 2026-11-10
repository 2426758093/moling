import { useEffect } from "react";
import { create } from "zustand";
import { api, ModelCaps } from "./api";
import { MAX_REFERENCE_IMAGES } from "./image";
import { useProviderStore } from "../stores/providerStore";

/** 无能力数据（或读取失败）时的降级值：与引入能力表之前完全一致 */
export const DEFAULT_MODEL_CAPS: ModelCaps = {
  negative: true,
  edit: true,
  transform: true,
  maxSide: 1024,
  multiImage: true,
  gif: false,
  gifMaxFrames: 16,
};

/// 与后端 model_caps::heuristic_caps 保持一致，仅用于新增服务商保存前的展示
export function heuristicCaps(model: string): ModelCaps {
  const m = model.toLowerCase();
  const caps =
    m.includes("dall-e") || m.includes("gpt-image")
      ? { ...DEFAULT_MODEL_CAPS, negative: false }
      : { ...DEFAULT_MODEL_CAPS };
  return m.includes("gpt-image-2.6") ? { ...caps, gif: true } : caps;
}

interface ModelCapsState {
  byProvider: Record<number, Record<string, ModelCaps>>;
  load: (providerId: number, force?: boolean) => Promise<void>;
  put: (providerId: number, model: string, caps: ModelCaps) => void;
}

const inflight = new Set<number>();

export const useModelCapsStore = create<ModelCapsState>((set, get) => ({
  byProvider: {},
  load: async (providerId, force = false) => {
    if (!force && (inflight.has(providerId) || get().byProvider[providerId]))
      return;
    inflight.add(providerId);
    try {
      const caps = await api.getModelCaps(providerId);
      set((s) => ({
        byProvider: { ...s.byProvider, [providerId]: caps },
      }));
    } catch {
      // 能力表读取失败按「全部可用」降级，不阻断生成
    } finally {
      inflight.delete(providerId);
    }
  },
  put: (providerId, model, caps) =>
    set((s) => ({
      byProvider: {
        ...s.byProvider,
        [providerId]: { ...(s.byProvider[providerId] ?? {}), [model]: caps },
      },
    })),
}));

function currentModel(): { providerId: number | null; model: string } {
  const { providers, defaultProviderId } = useProviderStore.getState();
  const provider = providers.find((p) => p.provider.id === defaultProviderId);
  return {
    providerId: defaultProviderId,
    model: provider?.provider.defaultModel ?? "",
  };
}

/** 当前默认服务商 + 默认模型的能力（供 store / 事件回调等非组件代码使用） */
export function currentModelCaps(): ModelCaps {
  const { providerId, model } = currentModel();
  if (providerId == null || !model) return DEFAULT_MODEL_CAPS;
  return (
    useModelCapsStore.getState().byProvider[providerId]?.[model] ??
    DEFAULT_MODEL_CAPS
  );
}

/** 参考图张数上限：模型不支持多图时只允许 1 张 */
export function maxReferenceImages(): number {
  return currentModelCaps().multiImage ? MAX_REFERENCE_IMAGES : 1;
}

export function useModelCaps(): ModelCaps {
  const providerId = useProviderStore((s) => s.defaultProviderId);
  const model = useProviderStore(
    (s) =>
      s.providers.find((p) => p.provider.id === s.defaultProviderId)?.provider
        .defaultModel ?? "",
  );
  useEffect(() => {
    if (providerId != null) void useModelCapsStore.getState().load(providerId);
  }, [providerId]);
  const caps = useModelCapsStore((s) =>
    providerId != null ? s.byProvider[providerId]?.[model] : undefined,
  );
  return caps ?? DEFAULT_MODEL_CAPS;
}
