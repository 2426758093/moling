import { invoke } from "@tauri-apps/api/core";

export interface ProviderInput {
  id?: number | null;
  name: string;
  baseUrl: string;
  apiKey?: string | null;
  kind: string;
  modelsJson: string;
  defaultModel: string;
  timeoutSecs: number;
  templateUrl: string;
  templateBody: string;
  templateResponsePath: string;
  extraParams?: string | null;
}

export interface ProviderItem {
  provider: ProviderInput;
  apiKeyMasked: string;
  hasKey: boolean;
}

export type AdapterError =
  | { type: "auth_invalid"; message: string }
  | { type: "quota_exceeded"; message: string }
  | { type: "timeout"; message: string }
  | { type: "content_blocked"; message: string }
  | { type: "network"; message: string }
  | { type: "other"; message: string };

export function parseAdapterError(raw: string): AdapterError {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.type) return parsed as AdapterError;
  } catch {
    // fallthrough
  }
  return { type: "other", message: raw };
}

export function adapterErrorTitle(e: AdapterError): string {
  switch (e.type) {
    case "auth_invalid":
      return "API Key 无效";
    case "quota_exceeded":
      return "余额不足或触发限额";
    case "timeout":
      return "请求超时";
    case "content_blocked":
      return "内容审核拦截";
    default:
      return "请求失败";
  }
}

export interface HistoryItem {
  history: {
    id: number;
    prompt: string;
    negativePrompt: string;
    model: string;
    providerName: string;
    seed: number | null;
    width: number;
    height: number;
    guidance: number;
    steps: number;
    style: string;
    filePath: string;
    favorite: boolean;
    createdAt: string;
  };
  dataUrl: string;
}

export interface GeneratedImage {
  historyId: number;
  dataUrl: string;
  filePath: string;
  prompt: string;
  model: string;
  seed: number | null;
}

export const api = {
  saveProvider: (input: ProviderInput) =>
    invoke<{ provider: ProviderInput; apiKeyMasked: string; hasKey: boolean }>(
      "save_provider",
      { input },
    ),
  listProviders: () => invoke<{ providers: ProviderItem[] }>("list_providers"),
  deleteProvider: (id: number) => invoke<void>("delete_provider", { id }),
  pullModels: (id: number) => invoke<string[]>("pull_models", { id }),
  testModels: (input: ProviderInput) =>
    invoke<string[]>("test_models", { input }),
  testConnection: (id: number) =>
    invoke<{
      ok: boolean;
      latencyMs?: number;
      modelCount?: number;
      error?: AdapterError;
    }>("test_connection", { id }),
  generateImages: (input: {
    providerId: number;
    prompt: string;
    negativePrompt?: string | null;
    model: string;
    width: number;
    height: number;
    guidance?: number | null;
    steps?: number | null;
    seed?: number | null;
    style: string;
    count: number;
    images?: string[];
  }) => invoke<{ images: GeneratedImage[] }>("generate_images", { input }),
  editImage: (input: {
    providerId: number;
    prompt: string;
    model: string;
    imageB64: string;
    maskB64?: string | null;
    width: number;
    height: number;
  }) =>
    invoke<{ historyId: number; dataUrl: string; filePath: string }>(
      "edit_image",
      { input },
    ),
  listHistory: (limit?: number, offset?: number, model?: string) =>
    invoke<{ items: HistoryItem[] }>("list_history", { limit, offset, model }),
  setFavorite: (id: number, favorite: boolean) =>
    invoke<void>("set_favorite", { id, favorite }),
  deleteHistory: (id: number) => invoke<void>("delete_history", { id }),
  setSetting: (key: string, value: string) =>
    invoke<void>("set_setting", { key, value }),
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  getAppDataDir: () => invoke<string>("get_app_data_dir"),
  exportConfig: () => invoke<Record<string, unknown>>("export_config"),
  importConfig: (data: Record<string, unknown>) =>
    invoke<void>("import_config", { data }),
  getThinkingConfig: () => invoke<ThinkingConfig>("get_thinking_config"),
  saveThinkingConfig: (config: ThinkingConfig, apiKey?: string | null) =>
    invoke<ThinkingConfig>("save_thinking_config", { config, apiKey }),
  testThinkingConnection: () =>
    invoke<{ ok: boolean; latencyMs?: number; error?: AdapterError }>(
      "test_thinking_connection",
    ),
  refinePrompt: (raw: string, context?: string | null) =>
    invoke<{ refined: string; used: boolean; error?: AdapterError }>(
      "refine_prompt",
      { input: { raw, context } },
    ),
  createConversation: (title: string) =>
    invoke<number>("create_conversation", { title }),
  listConversations: () =>
    invoke<{ conversations: Conversation[] }>("list_conversations"),
  deleteConversation: (id: number) =>
    invoke<void>("delete_conversation", { id }),
  addMessage: (message: NewMessage) =>
    invoke<{ id: number; imagesJson: string }>("add_message", {
      input: message,
    }),
  listMessages: (conversationId: number) =>
    invoke<{ messages: ChatMessage[] }>("list_messages", { conversationId }),
  saveChatImage: (dataUrl: string, name?: string) =>
    invoke<{ path: string }>("save_chat_image", { dataUrl, name }),
  getPromptTemplates: () =>
    invoke<{ builtin: PromptTemplate[]; custom: PromptTemplate[] }>(
      "get_prompt_templates",
    ),
  savePromptTemplates: (custom: PromptTemplate[]) =>
    invoke<void>("save_prompt_templates", { custom }),
  reversePrompt: (imageB64: string) =>
    invoke<{ ok: boolean; prompt?: string; error?: AdapterError }>(
      "reverse_prompt",
      { imageB64 },
    ),
};

export interface PromptTemplate {
  id: string;
  title: string;
  text: string;
}

export interface ThinkingConfig {
  enabled: boolean;
  mode: "standalone" | "reuse";
  providerId: number | null;
  baseUrl: string;
  model: string;
  apiKeyMasked?: string | null;
}

export interface Conversation {
  id: number;
  title: string;
  createdAt: string;
}

export interface ChatMessage {
  id: number;
  conversationId: number;
  role: "user" | "assistant";
  content: string;
  refinedContent: string;
  imagesJson: string;
  paramsJson: string;
  createdAt: string;
}

export interface NewMessage {
  conversationId: number;
  role: string;
  content: string;
  refinedContent: string;
  imagesJson: string;
  paramsJson: string;
  createdAt: string;
}

export const EMPTY_PROVIDER: ProviderInput = {
  id: null,
  name: "",
  baseUrl: "",
  apiKey: "",
  kind: "openai",
  modelsJson: "",
  defaultModel: "",
  timeoutSecs: 60,
  templateUrl: "",
  templateBody: "",
  templateResponsePath: "",
  extraParams: "",
};
