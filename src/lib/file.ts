// 文件读取助手：FileReader 的 Promise 封装，供各附件入口（Composer / PromptAssist 等）复用。
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** 读取 JSON / 文本文件（收藏与预设的导入入口） */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

// 附件本地 ID：时间戳 + 随机后缀，保证同一毫秒内不冲突。
export function genAttachmentId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** 校验待添加的图片附件，返回错误文案；合法时返回 null。 */
export async function validateImageFile(file: File): Promise<string | null> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `「${file.name}」超过 10MB，无法作为参考图`;
  }
  if (!file.type.startsWith("image/")) {
    return `「${file.name}」不是图片文件`;
  }
  try {
    await createImageBitmap(file);
  } catch {
    return `「${file.name}」图片损坏或格式不受支持`;
  }
  return null;
}

export interface PreparedImage {
  dataUrl: string;
  compressed: boolean;
}

/** 参考图长边上限：超过则等比例降采样（后续会进 DB、磁盘与上游 multipart） */
export const MAX_LONG_EDGE = 2048;
/** 体积阈值：未超长边但体积过大同样压缩 */
export const COMPRESS_THRESHOLD_BYTES = 4 * 1024 * 1024;
const JPEG_QUALITY = 0.9;

/** 压缩会丢动图帧与矢量特性，这两类直接放行 */
const SKIP_COMPRESS_TYPES = new Set(["image/svg+xml", "image/gif"]);

function dataUrlMime(dataUrl: string): string {
  if (!dataUrl.startsWith("data:")) return "";
  const end = dataUrl.indexOf(";");
  return end > 5 ? dataUrl.slice(5, end) : "";
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * 像素级命令（放大 / 风格 / 基础编辑）只接受栅格图：
 * SVG 等矢量来源先用 canvas 栅格化为 PNG，否则 Rust 侧 load_from_memory 会失败。
 * 走 <img> 而不是 createImageBitmap —— Chromium 不支持对 SVG blob 做 createImageBitmap。
 */
export async function ensureRasterDataUrl(dataUrl: string): Promise<string> {
  if (dataUrlMime(dataUrl) !== "image/svg+xml") return dataUrl;
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d 上下文不可用");
  ctx.drawImage(img, 0, 0);
  return canvas.toDataURL("image/png");
}

/** 文件入口：读成 dataUrl 后按同样规则压缩 */
export async function prepareImageAttachment(
  file: File,
): Promise<PreparedImage> {
  const dataUrl = await readFileAsDataUrl(file);
  const prepared = await compressDataUrl(dataUrl, file.name);
  return prepared;
}

/**
 * 超过长边 2048 或体积 4MB 的参考图降采样为 JPEG q0.9。
 * 压缩放前端：dataUrl 同时流向数据库/磁盘与上游 multipart，一处生效三处。
 * 任何异常都回退原图，只记日志，不阻断添加。
 */
export async function compressDataUrl(
  dataUrl: string,
  name = "参考图",
): Promise<PreparedImage> {
  const mime = dataUrlMime(dataUrl);
  if (!mime.startsWith("image/") || SKIP_COMPRESS_TYPES.has(mime)) {
    return { dataUrl, compressed: false };
  }
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const longEdge = Math.max(bitmap.width, bitmap.height);
    if (longEdge <= MAX_LONG_EDGE && blob.size <= COMPRESS_THRESHOLD_BYTES) {
      bitmap.close();
      return { dataUrl, compressed: false };
    }
    const scale = Math.min(1, MAX_LONG_EDGE / longEdge);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d 上下文不可用");
    // JPEG 无 alpha：先铺白底合成透明像素（与缩略图口径一致）
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const out = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
    );
    if (!out) throw new Error("canvas.toBlob 返回空");
    // 压完反而更大（如已优化的 JPEG）就保留原图
    if (out.size >= blob.size) return { dataUrl, compressed: false };
    return { dataUrl: await blobToDataUrl(out), compressed: true };
  } catch (e) {
    console.warn(`压缩参考图「${name}」失败，使用原图`, e);
    return { dataUrl, compressed: false };
  }
}

/** 对象 URL 的默认释放延迟：立即 revoke 可能中断 WebView 里刚开始的下载。 */
export const REVOKE_DELAY_MS = 1000;

/**
 * 触发下载（备份 JSON / 导出图片等共同入口）。
 * anchor 先挂到文档再 click（部分 WebView 只对已挂载节点响应），
 * 对象 URL 延迟释放，避免下载还没开始就被回收（F-018 统一口径）。
 */
export function downloadUrl(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

/** Blob 版本的 downloadUrl；对象 URL 由本函数创建并负责延迟释放。 */
export function downloadBlob(blob: Blob, filename: string): void {
  downloadUrl(URL.createObjectURL(blob), filename);
}
