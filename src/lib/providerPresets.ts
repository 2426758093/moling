/**
 * 服务商快速预设：只收录可验证的官方 / 本地端点。
 *
 * 第三方中转（CherryIN 等）地址与鉴权差异很大，不做猜测，统一引导到
 * 「自定义（OpenAI 兼容）」并让用户填写确认可用的 /v1 地址。
 * 预设只填 name / baseUrl / kind 与提示文案，绝不填 API Key。
 */

export type ProviderPresetId =
  | "openai"
  | "siliconflow"
  | "ollama"
  | "lmstudio"
  | "custom"
  | "template"
  | "mock";

export type ProviderPresetNameKey =
  "自定义（OpenAI 兼容）" | "自定义模板" | "Mock 调试";

export type ProviderPresetHintKey =
  | "官方接口，需要 API Key；推荐 gpt-image-1 / gpt-image-1-mini / dall-e-3。"
  | "OpenAI 兼容接口，需先在控制台创建 API Key。"
  | "本地推理，无需 Key；请先启动 Ollama 并拉取图像模型。"
  | "本地服务，无需 Key；请先在 LM Studio 中启动本地服务器。"
  | "第三方中转或私有网关请选此项，并填写确认可用的 /v1 地址。"
  | "占位符模板接口，模型列表需手动填写。"
  | "离线调试适配器，不发出真实网络请求。";

export interface ProviderPreset {
  id: ProviderPresetId;
  /** 专有名词名称；nameKey 存在时优先取译文 */
  name: string;
  /** 需要翻译的名称文案 */
  nameKey?: ProviderPresetNameKey;
  baseUrl: string;
  /** 对应 ProviderInput.kind */
  kind: string;
  /** 允许留空 API Key（本地服务 / Mock） */
  keyOptional: boolean;
  /** 预设说明（i18n key） */
  hint: ProviderPresetHintKey;
  /** 已知推荐的图像模型；仅作提示，不自动写入模型列表 */
  recommendedModels: readonly string[];
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    kind: "openai",
    keyOptional: false,
    hint: "官方接口，需要 API Key；推荐 gpt-image-1 / gpt-image-1-mini / dall-e-3。",
    recommendedModels: ["gpt-image-1", "gpt-image-1-mini", "dall-e-3"],
  },
  {
    id: "siliconflow",
    name: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    kind: "openai",
    keyOptional: false,
    hint: "OpenAI 兼容接口，需先在控制台创建 API Key。",
    recommendedModels: [],
  },
  {
    id: "ollama",
    name: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    kind: "openai",
    keyOptional: true,
    hint: "本地推理，无需 Key；请先启动 Ollama 并拉取图像模型。",
    recommendedModels: [],
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    kind: "openai",
    keyOptional: true,
    hint: "本地服务，无需 Key；请先在 LM Studio 中启动本地服务器。",
    recommendedModels: [],
  },
  {
    id: "custom",
    name: "自定义（OpenAI 兼容）",
    nameKey: "自定义（OpenAI 兼容）",
    baseUrl: "",
    kind: "openai",
    keyOptional: false,
    hint: "第三方中转或私有网关请选此项，并填写确认可用的 /v1 地址。",
    recommendedModels: [],
  },
  {
    id: "template",
    name: "自定义模板",
    nameKey: "自定义模板",
    baseUrl: "",
    kind: "template",
    keyOptional: false,
    hint: "占位符模板接口，模型列表需手动填写。",
    recommendedModels: [],
  },
  {
    id: "mock",
    name: "Mock 调试",
    nameKey: "Mock 调试",
    baseUrl: "",
    kind: "mock",
    keyOptional: true,
    hint: "离线调试适配器，不发出真实网络请求。",
    recommendedModels: [],
  },
];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

/** 本地端点判定：允许 OLLAMA / LM Studio 这类无鉴权服务留空 Key */
export function isLocalEndpoint(baseUrl: string): boolean {
  const raw = baseUrl.trim();
  if (!raw) return false;
  try {
    const url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`,
    );
    return LOCAL_HOSTS.has(url.hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return /(^|[/.])(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/i.test(raw);
  }
}

/** 该配置是否允许空 Key（Mock 与本地端点） */
export function keyOptionalFor(baseUrl: string, kind: string): boolean {
  return kind === "mock" || isLocalEndpoint(baseUrl);
}
