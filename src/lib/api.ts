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

export interface ProviderKeyView {
  index: number;
  masked: string;
  invalid: boolean;
  invalidAt: string | null;
}

export interface ProviderItem {
  provider: ProviderInput;
  apiKeyMasked: string;
  hasKey: boolean;
  // API Key 解密失败标记（R2：密钥损坏时透出前端，禁止静默当作无 Key）
  keyError: boolean;
  keyCount: number;
  invalidKeyCount: number;
  keys: ProviderKeyView[];
}

export type AdapterError =
  | { type: "auth_invalid"; message: string; status?: number }
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
  /** 列表只带缩略图；下载/打包导出需按 id 取原图 */
  thumbUrl: string;
}

export interface GeneratedImage {
  historyId: number;
  dataUrl: string;
  filePath: string;
  prompt: string;
  model: string;
  seed: number | null;
}

export type ProxyMode = "system" | "direct" | "manual";

export interface ProxyConfigView {
  mode: ProxyMode;
  url: string;
  username: string;
  hasPassword: boolean;
  noProxy: string;
}

export interface ProxyInputPayload {
  mode: ProxyMode;
  url: string;
  username: string;
  /** null = 保持已保存密码；"" = 清除密码；其余为明文新密码 */
  password?: string | null;
  noProxy: string;
}

export type QueueStatus =
  "queued" | "running" | "done" | "failed" | "canceled" | "interrupted";

/** 批量队列任务（后端 jobs 表整行，camelCase） */
export interface QueueJob {
  id: number;
  status: QueueStatus;
  providerId: number;
  providerName: string;
  model: string;
  prompt: string;
  negativePrompt: string;
  style: string;
  width: number;
  height: number;
  guidance: number | null;
  steps: number | null;
  seed: number | null;
  count: number;
  jobKey: string;
  /** [{historyId, path}]，绝不包含 base64 */
  imagesJson: string;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface EnqueueJobInput {
  providerId: number;
  prompt: string;
  negativePrompt?: string | null;
  model: string;
  style: string;
  width: number;
  height: number;
  guidance?: number | null;
  steps?: number | null;
  seed?: number | null;
  count: number;
}

export interface AvailableUpdate {
  version: string;
  notes: string | null;
  date: string | null;
}

/** 思考模型流式增量（Tauri 事件 thinking:delta） */
export interface ThinkingDelta {
  requestId: string;
  conversationId: number | null;
  delta: string;
}

/**
 * 逐张生成进度（Tauri 事件 image:progress）
 * total 是服务商实际返回张数（与 done 同源），requested 是本次请求的 count。
 */
export interface ImageProgress {
  jobId: string;
  done: number;
  total: number;
  requested: number;
}

/** 更新状态：未配置更新源时 configured=false，且不发起网络请求 */
export interface UpdateStatus {
  currentVersion: string;
  configured: boolean;
  available: AvailableUpdate | null;
  error: string | null;
}

export const api = {
  saveProvider: (input: ProviderInput) =>
    invoke<ProviderItem>("save_provider", { input }),
  listProviders: () => invoke<{ providers: ProviderItem[] }>("list_providers"),
  listProviderKeys: (id: number) =>
    invoke<{ keys: ProviderKeyView[] }>("list_provider_keys", { id }),
  addProviderKey: (id: number, key: string) =>
    invoke<{ keys: ProviderKeyView[] }>("add_provider_key", { id, key }),
  deleteProviderKey: (id: number, index: number) =>
    invoke<{ keys: ProviderKeyView[] }>("delete_provider_key", { id, index }),
  resetProviderKey: (id: number, index: number) =>
    invoke<{ keys: ProviderKeyView[] }>("reset_provider_key", { id, index }),
  deleteProvider: (id: number) => invoke<void>("delete_provider", { id }),
  pullModels: (id: number) => invoke<string[]>("pull_models", { id }),
  testModels: (input: ProviderInput) =>
    invoke<string[]>("test_models", { input }),
  testConnection: (id: number) =>
    invoke<{
      ok: boolean;
      latencyMs?: number;
      modelCount?: number;
      // 后端返回 AdapterError 的 JSON 字符串（或裸字符串），由 parseAdapterError 兼容
      error?: string;
    }>("test_connection", { id }),
  getProxyConfig: () => invoke<ProxyConfigView>("get_proxy_config"),
  saveProxyConfig: (input: ProxyInputPayload) =>
    invoke<ProxyConfigView>("save_proxy_config", { input }),
  testProxy: (input: ProxyInputPayload, providerId: number) =>
    invoke<{
      ok: boolean;
      latencyMs?: number;
      status?: number;
      error?: string;
    }>("test_proxy", { input, providerId }),
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
    // 生成任务 id：stop() 用它调用 cancel_generation 中断在途生成
    jobId?: string;
  }) =>
    invoke<{ images: GeneratedImage[]; cancelled?: boolean }>(
      "generate_images",
      {
        input,
      },
    ),
  // 请求后端中断指定生成任务：仅尽力而为，cmd 未落地/失败时前端忽略
  cancelGeneration: (jobId: string) =>
    invoke<void>("cancel_generation", { jobId }),
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
  listHistory: (
    limit?: number,
    offset?: number,
    model?: string,
    style?: string,
  ) =>
    invoke<{ items: HistoryItem[] }>("list_history", {
      limit,
      offset,
      model,
      style,
    }),
  getHistoryImage: (id: number) =>
    invoke<{ historyId: number; dataUrl: string; filePath: string }>(
      "get_history_image",
      { id },
    ),
  setFavorite: (id: number, favorite: boolean) =>
    invoke<void>("set_favorite", { id, favorite }),
  deleteHistory: (id: number) => invoke<void>("delete_history", { id }),
  setSetting: (key: string, value: string) =>
    invoke<void>("set_setting", { key, value }),
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  getAppDataDir: () => invoke<string>("get_app_data_dir"),
  getLogsDir: () => invoke<string>("get_logs_dir"),
  /** 导出脱敏诊断包（近 7 天日志 + 元信息），返回 zip 绝对路径 */
  exportDiagnostics: () => invoke<string>("export_diagnostics"),
  getUpdateStatus: () => invoke<UpdateStatus>("get_update_status"),
  /** 下载并安装可用更新；成功后进程会重启 */
  installUpdate: () => invoke<void>("install_update"),
  exportConfig: (includeKeys: boolean) =>
    invoke<Record<string, unknown>>("export_config", { includeKeys }),
  importConfig: (data: Record<string, unknown>) =>
    invoke<void>("import_config", { data }),
  getThinkingConfig: () => invoke<ThinkingConfig>("get_thinking_config"),
  saveThinkingConfig: (config: ThinkingConfig, apiKey?: string | null) =>
    invoke<ThinkingConfig>("save_thinking_config", { config, apiKey }),
  testThinkingConnection: () =>
    invoke<{ ok: boolean; latencyMs?: number; error?: string }>(
      "test_thinking_connection",
    ),
  refinePrompt: (
    raw: string,
    context?: string | null,
    requestId?: string | null,
    conversationId?: number | null,
  ) =>
    invoke<{ refined: string; used: boolean; error?: AdapterError }>(
      "refine_prompt",
      { input: { raw, context, requestId, conversationId } },
    ),
  /// 取消在途思考优化（幂等：未注册/已结束返回 false）
  cancelRefine: (requestId: string) =>
    invoke<boolean>("cancel_refine", { requestId }),
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
  /// 删除单条消息（重试时清掉上一条回复）；返回是否命中
  deleteMessage: (id: number) => invoke<boolean>("delete_message", { id }),
  /// 从消息中移除一张图片并落库；文件仅在无人引用时回收
  removeMessageImage: (messageId: number, historyId: number) =>
    invoke<boolean>("remove_message_image", { messageId, historyId }),
  enqueueJob: (input: EnqueueJobInput) =>
    invoke<QueueJob>("enqueue_job", { input }),
  listJobs: () =>
    invoke<{
      jobs: QueueJob[];
      counts: Record<string, number>;
      paused: boolean;
    }>("list_jobs"),
  cancelQueueJob: (id: number) => invoke<void>("cancel_queue_job", { id }),
  retryQueueJob: (id: number) => invoke<void>("retry_queue_job", { id }),
  resumeQueue: () => invoke<{ paused: boolean }>("resume_queue"),
  clearFinishedJobs: () => invoke<number>("clear_finished_jobs"),
  /// keyset 分页：不传 beforeId 取最新一页，返回按 id 升序，hasMore 表示还有更旧的消息
  listMessages: (
    conversationId: number,
    opts: { limit?: number; beforeId?: number } = {},
  ) =>
    invoke<{ messages: ChatMessage[]; hasMore: boolean }>("list_messages", {
      conversationId,
      limit: opts.limit,
      beforeId: opts.beforeId,
    }),
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
