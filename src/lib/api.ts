import { invoke } from "@tauri-apps/api/core";
import i18n from "../i18n";
import type { ImageQuality, ReferenceRole } from "./types";
import type { StylePreset } from "./presets";

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
  /** 编辑模板（局部重绘 / 消除 / 扩图），三项全空表示未配置 */
  editTemplateUrl: string;
  editTemplateBody: string;
  editTemplateResponsePath: string;
  /** 变换模板（放大 / 风格转换），三项全空表示未配置 */
  transformTemplateUrl: string;
  transformTemplateBody: string;
  transformTemplateResponsePath: string;
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

/** 模型能力元数据：只驱动界面开关，不改变请求形状 */
export interface ModelCaps {
  negative: boolean;
  edit: boolean;
  transform: boolean;
  maxSide: number;
  multiImage: boolean;
}

export type AdapterError =
  | { type: "auth_invalid"; message: string; status?: number }
  | { type: "quota_exceeded"; message: string; retry_after?: number }
  | { type: "timeout"; message: string }
  | { type: "content_blocked"; message: string }
  | { type: "network"; message: string }
  | { type: "unsupported"; message: string }
  | { type: "upstream"; message: string; status?: number }
  | { type: "body_interrupted"; message: string }
  | { type: "unconfirmed"; message: string; request_id?: string; artifact?: string }
  | { type: "other"; message: string };

/** 可能已计费：重试前必须让用户先对账，否则会重复扣费 */
export function isUnconfirmedError(e: AdapterError): boolean {
  return e.type === "unconfirmed" || e.type === "upstream" || e.type === "body_interrupted";
}

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
      return i18n.t("API Key 无效");
    case "quota_exceeded":
      return i18n.t("余额不足或触发限额");
    case "timeout":
      return i18n.t("请求超时");
    case "content_blocked":
      return i18n.t("内容审核拦截");
    case "unsupported":
      return i18n.t("该服务商不支持此操作");
    case "unconfirmed":
    case "upstream":
    case "body_interrupted":
      return i18n.t("结果未确认");
    default:
      return i18n.t("请求失败");
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
    /** 派生图血统：父记录 id 与来源操作（generate / edit / upscale / style…） */
    parentId: number | null;
    op: string;
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

export interface DirStat {
  files: number;
  bytes: number;
}

/** 存储占用：媒体根下的图片/缩略图/参考图/回收站 + 数据库文件 */
export interface StorageStats {
  mediaRoot: string;
  dataDir: string;
  images: DirStat;
  thumbs: DirStat;
  refs: DirStat;
  trash: DirStat;
  database: DirStat;
}

/** 一次 HTTP 尝试的计费流水（敏感字段 prompt/param_hash 不在 IPC 中输出） */
export interface ImageRequestItem {
  id: number;
  groupId: string;
  clientRequestId: string;
  entry: string;
  op: string;
  jobId: number | null;
  providerId: number;
  providerName: string;
  model: string;
  endpoint: string;
  attempt: number;
  state: string;
  httpStatus: number | null;
  providerRequestId: string;
  imageCount: number;
  artifactsJson: string;
  rawPath: string;
  errorJson: string | null;
  createdAt: string;
  sentAt: string | null;
  billedAt: string | null;
  finishedAt: string | null;
}

export interface RecoverOutcome {
  recovered: number;
  failed: number;
}

export interface MediaMigrationReport {  from: string;
  to: string;
  filesCopied: number;
  bytesCopied: number;
  pathsRewritten: number;
}

/** 清理缓存结果（与启动清理共用 Rust 侧 Stats） */
export interface CacheCleanReport {
  scanned: number;
  kept: number;
  skippedRecent: number;
  candidates: number;
  moved: number;
  pruned: number;
  thumbsCreated: number;
  errors: number;
  refsScanned: number;
  refsKept: number;
  refsMoved: number;
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
  /** 扩展参数 JSON：{referencePaths, references}，空串表示无参考图 */
  inputJson: string;
  /** 待确认计费状态：unknown / billed_unrecovered 时默认禁止重跑 */
  billingState?: string;
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
  /** 图片质量快照；auto/省略 = 不发送 quality 字段 */
  quality?: ImageQuality | null;
  /** 已落盘（refs/）的参考图路径，按位置与 references 对齐 */
  referencePaths?: string[];
  references?: { role: ReferenceRole; strength: number }[];
}

/** 队列任务扩展参数（与后端 JobExtras 对应） */
export interface QueueJobExtras {
  referencePaths?: string[];
  references?: { role: ReferenceRole; strength: number }[];
  quality?: ImageQuality | null;
}

export interface AvailableUpdate {
  version: string;
  notes: string | null;
  date: string | null;
}

/** 收藏的提示词：文本唯一，重复收藏只更新标签 */
export interface PromptFavorite {
  id: number;
  text: string;
  tags: string[];
  createdAt: string;
}

/** 预设参考图只记路径；角色 / 强度随路径一起保存 */
export interface PresetRef {
  path: string;
  role: ReferenceRole;
  strength: number;
}

/** 工作流预设：提示词 + 负向词 + 生成参数 + 参考图 */
export interface WorkflowPreset {
  id: number;
  name: string;
  prompt: string;
  negativePrompt: string;
  /** JSON 字符串（ratio / width / height / style / count） */
  paramsJson: string;
  refs: PresetRef[];
  createdAt: string;
  updatedAt: string;
}

export interface PresetInput {
  id?: number | null;
  name: string;
  prompt: string;
  negativePrompt: string;
  params: Record<string, unknown>;
  refs: PresetRef[];
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

/** 下载进度（Tauri 事件 update:progress）；total 未知时按已下载量展示 */
export interface UpdateProgress {
  downloaded: number;
  total: number | null;
  /** 平均速度（字节/秒） */
  speed: number;
  /** 当前线路：手动代理 / 系统网络 / 直连 */
  route: string;
}

/** 画布元信息：列表不返回布局数据 */
export interface CanvasBoardMeta {
  id: number;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/** 画布完整数据；dataJson 结构由 canvasStore 定义并校验 */
export interface CanvasBoard extends CanvasBoardMeta {
  dataJson: string;
}

/** 批量缩略图：后端会跳过文件缺失的记录 */
export interface CanvasThumb {
  historyId: number;
  thumbUrl: string;
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
  getModelCaps: (providerId: number) =>
    invoke<Record<string, ModelCaps>>("get_model_caps", { providerId }),
  setModelCaps: (providerId: number, model: string, caps: ModelCaps) =>
    invoke<void>("set_model_caps", { providerId, model, caps }),
  /** 批量保存模型能力（后端单事务，任一条失败整体不生效） */
  saveModelCapsBatch: (
    providerId: number,
    entries: Record<string, ModelCaps>,
  ) => invoke<void>("save_model_caps_batch", { providerId, entries }),
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
    /** 图片质量；auto/省略 = 不发送 quality 字段 */
    quality?: ImageQuality | null;
    images?: string[];
    /// 与 images 按位置对应；只在专家模式下发（省略即不追加角色说明）
    references?: { role: ReferenceRole; strength: number }[];
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
    negativePrompt?: string | null;
    model: string;
    imageB64: string;
    maskB64?: string | null;
    width: number;
    height: number;
    /** edit | erase | outpaint（血统用；缺省按后端推断） */
    op?: "edit" | "erase" | "outpaint";
    /** 原图记录 id */
    parentId?: number | null;
  }) =>
    invoke<{
      historyId: number;
      dataUrl: string;
      filePath: string;
      op: string;
    }>("edit_image", { input }),
  /** 高清放大 / 风格转换：scale=1 且带 prompt 为风格转换 */
  transformImage: (input: {
    providerId: number;
    model: string;
    imageB64: string;
    scale: number;
    mode: "detail" | "faithful";
    prompt?: string;
    parentId?: number | null;
  }) =>
    invoke<{
      historyId: number;
      dataUrl: string;
      filePath: string;
      width: number;
      height: number;
      op: string;
      parentId: number | null;
    }>("transform_image", { input }),
  /** 基础编辑：本地像素运算，ops 按顺序应用 */
  applyEdit: (input: {
    imageB64: string;
    ops: Array<
      | { type: "crop"; x: number; y: number; width: number; height: number }
      | { type: "rotate"; deg: 90 | 180 | 270 }
      | { type: "flip"; axis: "horizontal" | "vertical" }
      | {
          type: "adjust";
          brightness: number;
          contrast: number;
          saturation: number;
        }
    >;
    parentId?: number | null;
  }) =>
    invoke<{
      historyId: number;
      dataUrl: string;
      filePath: string;
      width: number;
      height: number;
      op: string;
      parentId: number | null;
    }>("apply_edit", { input }),
  /** 换背景：纯色 / 渐变本地合成，ai 走服务商编辑接口 */
  replaceBackground: (input: {
    imageB64: string;
    maskB64: string;
    parentId?: number | null;
    kind: "solid" | "gradient" | "ai";
    color?: string;
    colorFrom?: string;
    colorTo?: string;
    direction?: "horizontal" | "vertical" | "diagonal";
    prompt?: string;
    providerId?: number | null;
    model?: string;
    negativePrompt?: string | null;
  }) =>
    invoke<{
      historyId: number;
      dataUrl: string;
      filePath: string;
      width: number;
      height: number;
      op: string;
      parentId: number | null;
    }>("replace_background", { input }),
  /** 智能蒙版：整图主体（invert = 取背景），返回与原图同尺寸的灰度蒙版 */
  segmentSubject: (imageB64: string, invert = false) =>
    invoke<{
      dataUrl: string;
      width: number;
      height: number;
      covered: number;
    }>("segment_subject", { imageB64, invert }),
  /** 智能蒙版：点选物体所在连通域；x/y 为原图像素坐标 */
  segmentAtPoint: (imageB64: string, x: number, y: number) =>
    invoke<{
      dataUrl: string;
      width: number;
      height: number;
      covered: number;
    }>("segment_at_point", { imageB64, x, y }),
  segmentModelStatus: () =>
    invoke<{ available: boolean; loaded: boolean; reason: string | null }>(
      "segment_model_status",
    ),
  /** 同族图片（根 + 直接派生） */
  listDerived: (historyId: number) =>
    invoke<{ items: HistoryItem["history"][] }>("list_derived", {
      historyId,
    }),
  /** 画廊分页：beforeId 为上一页最后一条的 id（游标），首页传 null */
  listHistory: (
    limit?: number,
    beforeId?: number | null,
    model?: string,
    style?: string,
    favoriteOnly?: boolean,
  ) =>
    invoke<{ items: HistoryItem[] }>("list_history", {
      limit,
      beforeId,
      model,
      style,
      favoriteOnly,
    }),
  getHistoryImage: (id: number) =>
    invoke<{ historyId: number; dataUrl: string; filePath: string }>(
      "get_history_image",
      { id },
    ),
  /** 原图另存为；paramsText 非空时在同目录写同名 .txt 参数清单 */
  saveHistoryImage: (id: number, dest: string, paramsText?: string | null) =>
    invoke<void>("save_history_image", { id, dest, paramsText }),
  /** 打包导出：Rust 侧 zip，避免把整包 base64 走一遍 IPC */
  exportHistoryZip: (
    entries: { historyId: number; params: Record<string, unknown> }[],
    dest: string,
  ) =>
    invoke<{ saved: number; skipped: number }>("export_history_zip", {
      entries,
      dest,
    }),
  writeTextFile: (dest: string, content: string) =>
    invoke<void>("write_text_file", { dest, content }),
  writeFileBase64: (dest: string, data: string) =>
    invoke<void>("write_file_base64", { dest, data }),
  /** 画廊记录元信息（画布节点复用参数 / 编辑浮层提示词） */
  getHistoryItem: (id: number) =>
    invoke<HistoryItem["history"] | null>("get_history_item", { id }),
  /** 画布粘贴：把剪贴板图片入库并返回新的 historyId */
  importImage: (dataUrl: string) =>
    invoke<{ historyId: number; dataUrl: string }>("import_image", { dataUrl }),
  setFavorite: (id: number, favorite: boolean) =>
    invoke<void>("set_favorite", { id, favorite }),
  deleteHistory: (id: number) => invoke<void>("delete_history", { id }),
  setSetting: (key: string, value: string) =>
    invoke<void>("set_setting", { key, value }),
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  /** 媒体根（图片与参考图所在目录；数据库与日志始终在 appData） */
  getMediaRoot: () => invoke<string>("get_media_root"),
  /** 更改媒体根：复制 → 改库 → 切换，返回迁移统计；队列运行中会被拒绝 */
  setMediaRoot: (path: string) =>
    invoke<MediaMigrationReport>("set_media_root", { path }),
  storageStats: () => invoke<StorageStats>("storage_stats"),
  /** 立即清理缓存；days 缺省取设置里的保留天数 */
  cleanCache: (days?: number) =>
    invoke<CacheCleanReport>("clean_cache", { days }),
  getAppDataDir: () => invoke<string>("get_app_data_dir"),
  getLogsDir: () => invoke<string>("get_logs_dir"),
  /** 导出脱敏诊断包（近 7 天日志 + 元信息），返回 zip 绝对路径 */
  exportDiagnostics: () => invoke<string>("export_diagnostics"),
  /** 计费请求流水：只读，用于对账与「不重新生成」的恢复 */
  listImageRequests: (pendingOnly = false) =>
    invoke<ImageRequestItem[]>("list_image_requests", { pendingOnly }),
  recoverImageRequest: (id: number) =>
    invoke<RecoverOutcome>("recover_image_request", { id }),
  recoverImageRequestByClient: (clientRequestId: string) =>
    invoke<RecoverOutcome>("recover_image_request_by_client", { clientRequestId }),
  abandonImageRequest: (id: number) =>
    invoke<void>("abandon_image_request", { id }),
  getRequestsDir: () => invoke<string>("get_requests_dir"),
  getUpdateStatus: () => invoke<UpdateStatus>("get_update_status"),
  /** 下载更新包（自动选线路 + 多线程），完成后等待 installUpdate */
  downloadUpdate: () => invoke<void>("download_update"),
  /** 安装已下载的更新；Windows 会退出进程，其它平台会重启 */
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
    invoke<{
      refined: string;
      used: boolean;
      cancelled?: boolean;
      error?: AdapterError;
    }>("refine_prompt", { input: { raw, context, requestId, conversationId } }),
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
      concurrency: number;
      providerConcurrency: number;
    }>("list_jobs"),
  cancelQueueJob: (id: number) => invoke<void>("cancel_queue_job", { id }),
  retryQueueJob: (id: number, force = false) =>
    invoke<void>("retry_queue_job", { id, force }),
  /** 恢复全部中断任务并启动队列，返回恢复数量 */
  requeueInterruptedJobs: () => invoke<number>("requeue_interrupted_jobs"),
  resumeQueue: () => invoke<{ paused: boolean }>("resume_queue"),
  clearFinishedJobs: () => invoke<number>("clear_finished_jobs"),
  /** 参考图落盘到 appData/refs/，返回路径（入队时只传路径） */
  saveReferenceImage: (dataUrl: string) =>
    invoke<string>("save_reference_image", { dataUrl }),
  /** 读取 refs/ 下的参考图为 data URL（队列缩略图） */
  readReferenceImage: (path: string) =>
    invoke<string>("read_reference_image", { path }),
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
  getStylePresets: () =>
    invoke<{ builtin: StylePreset[]; custom: StylePreset[] }>(
      "get_style_presets",
    ),
  saveStylePresets: (custom: StylePreset[]) =>
    invoke<void>("save_style_presets", { custom }),
  reversePrompt: (imageB64: string) =>
    invoke<{ ok: boolean; prompt?: string; error?: AdapterError }>(
      "reverse_prompt",
      { imageB64 },
    ),
  /** 提示词翻译：含汉字按中→英，否则英→中；依赖思考模型 */
  translatePrompt: (text: string) =>
    invoke<{
      ok: boolean;
      translated?: string;
      direction?: "zh2en" | "en2zh";
      error?: AdapterError;
    }>("translate_prompt", { text }),
  /** 首条消息后生成会话标题；未启用时 ok=false + skipped=true */
  generateConversationTitle: (conversationId: number, prompt: string) =>
    invoke<{
      ok: boolean;
      title?: string;
      updated?: boolean;
      skipped?: boolean;
      error?: AdapterError;
    }>("generate_conversation_title", { conversationId, prompt }),
  /** 提示词优化：在保留原意的前提下补全视觉细节 */
  optimizePrompt: (text: string) =>
    invoke<{ ok: boolean; optimized?: string; error?: AdapterError }>(
      "optimize_prompt",
      { text },
    ),
  listFavorites: () => invoke<PromptFavorite[]>("list_favorites"),
  upsertFavorite: (text: string, tags: string[]) =>
    invoke<PromptFavorite>("upsert_favorite", { text, tags }),
  deleteFavorite: (id: number) => invoke<boolean>("delete_favorite", { id }),
  listPresets: () => invoke<WorkflowPreset[]>("list_presets"),
  savePreset: (input: PresetInput) =>
    invoke<WorkflowPreset>("save_preset", { input }),
  deletePreset: (id: number) => invoke<boolean>("delete_preset", { id }),
  listCanvasBoards: () => invoke<CanvasBoardMeta[]>("list_canvas_boards"),
  createCanvasBoard: (name: string) =>
    invoke<CanvasBoard>("create_canvas_board", { name }),
  getCanvasBoard: (id: number) =>
    invoke<CanvasBoard | null>("get_canvas_board", { id }),
  saveCanvasBoard: (id: number, name: string, dataJson: string) =>
    invoke<CanvasBoard>("save_canvas_board", { id, name, dataJson }),
  deleteCanvasBoard: (id: number) =>
    invoke<boolean>("delete_canvas_board", { id }),
  /** 画布节点缩略图：一次最多 200 个 id，缺失文件跳过 */
  batchHistoryThumbs: (ids: number[]) =>
    invoke<CanvasThumb[]>("batch_history_thumbs", { ids }),
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
  /** 首条消息后自动生成会话标题 */
  titleEnabled?: boolean;
  /** 输入框提示词优化助手 */
  optimizeEnabled?: boolean;
  /** 输入框失焦时自动把中文提示词翻译为英文 */
  autoTranslateOnBlur?: boolean;
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
  /** done | stopped | failed | unconfirmed；旧库缺省 done */
  status?: string;
  /** 失败轮的 AdapterError JSON；重启后据此恢复错误样式 */
  error?: string | null;
}

export interface NewMessage {
  conversationId: number;
  role: string;
  content: string;
  refinedContent: string;
  imagesJson: string;
  paramsJson: string;
  createdAt: string;
  status?: string;
  error?: string;
}

export const EMPTY_PROVIDER: ProviderInput = {
  id: null,
  name: "",
  baseUrl: "",
  apiKey: "",
  kind: "openai",
  modelsJson: "",
  defaultModel: "",
  timeoutSecs: 600,
  templateUrl: "",
  templateBody: "",
  templateResponsePath: "",
  editTemplateUrl: "",
  editTemplateBody: "",
  editTemplateResponsePath: "",
  transformTemplateUrl: "",
  transformTemplateBody: "",
  transformTemplateResponsePath: "",
  extraParams: "",
};
