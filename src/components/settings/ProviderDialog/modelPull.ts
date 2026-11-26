import type { ProviderInput } from "../../../lib/api";

/** 同一 {baseUrl, keyHash, kind} 的模型列表在 30 秒内复用 */
export const PULL_CACHE_TTL_MS = 30_000;

export type ModelFilter = "all" | "image" | "recommended";
export type ModelSort = "default" | "name" | "recommended";

interface PullCacheEntry {
  at: number;
  models: string[];
}

const cache = new Map<string, PullCacheEntry>();
const MAX_CACHE_ENTRIES = 20;

/** 稳定序列化 Base URL：忽略末尾斜杠与协议/主机大小写差异 */
function normalizeBaseUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  try {
    const url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`,
    );
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return value.replace(/\/+$/, "").toLowerCase();
  }
}

/** 仅用于缓存键，不可逆；避免明文 Key 进入内存键名 */
export function hashKey(key: string): string {
  let hash = 5381;
  for (let i = 0; i < key.length; i += 1) {
    hash = ((hash << 5) + hash + key.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * 拉取签名：地址 + 类型 + Key 来源。
 * 编辑已有服务商且未输入新 Key 时只记 providerId，不接触明文 Key。
 */
export function pullSignature(
  input: Pick<ProviderInput, "baseUrl" | "kind" | "apiKey">,
  providerId: number | null,
  hasSavedKey: boolean,
): string {
  const typed = (input.apiKey ?? "").trim();
  const keyToken = typed
    ? `key:${hashKey(typed)}`
    : hasSavedKey && providerId != null
      ? `saved:${providerId}`
      : "none";
  return `${input.kind}|${normalizeBaseUrl(input.baseUrl)}|${keyToken}`;
}

export function readPullCache(
  signature: string,
  now = Date.now(),
): string[] | null {
  const hit = cache.get(signature);
  if (!hit) return null;
  if (now - hit.at > PULL_CACHE_TTL_MS) {
    cache.delete(signature);
    return null;
  }
  return [...hit.models];
}

export function writePullCache(
  signature: string,
  models: string[],
  now = Date.now(),
): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(signature, { at: now, models: [...models] });
}

/** 仅供测试：清空跨弹窗复用的拉取缓存 */
export function resetPullCache(): void {
  cache.clear();
}

const IMAGE_MODEL_PATTERNS: readonly RegExp[] = [
  /gpt-image/,
  /dall-?e/,
  /flux/,
  /stable-?diffusion/,
  /\bsdxl\b/,
  /\bsd3\b/,
  /imagen/,
  /seedream/,
  /kolors/,
  /qwen-image/,
  /wanx/,
  /wan2/,
  /midjourney/,
  /\bmj\b/,
  /ideogram/,
  /recraft/,
  /lumina/,
  /hidream/,
  /grok.*image/,
  /minimax.*image/,
  /image/,
];

/** 启发式判断图像模型：用于默认模型推荐与「图像」筛选 */
export function isImageModel(model: string): boolean {
  const name = model.toLowerCase();
  return IMAGE_MODEL_PATTERNS.some((pattern) => pattern.test(name));
}

/** 默认模型推荐：优先第一个图像模型，否则退回列表首项 */
export function recommendDefaultModel(models: readonly string[]): string {
  return models.find(isImageModel) ?? models[0] ?? "";
}

export function filterAndSortModels(
  models: readonly string[],
  options: {
    query: string;
    filter: ModelFilter;
    sort: ModelSort;
    /** 预设声明的推荐模型；为空时「推荐」筛选退回图像模型 */
    recommended?: readonly string[];
  },
): string[] {
  const query = options.query.trim().toLowerCase();
  let result = models.filter(
    (model) => !query || model.toLowerCase().includes(query),
  );

  if (options.filter === "image") {
    result = result.filter(isImageModel);
  } else if (options.filter === "recommended") {
    const preferred = new Set(options.recommended ?? []);
    const declared = result.filter((model) => preferred.has(model));
    result = declared.length > 0 ? declared : result.filter(isImageModel);
  }

  if (options.sort === "name") {
    return [...result].sort((a, b) => a.localeCompare(b));
  }
  if (options.sort === "recommended") {
    return [...result].sort((a, b) => {
      const rank = Number(isImageModel(b)) - Number(isImageModel(a));
      return rank || a.localeCompare(b);
    });
  }
  return result;
}
