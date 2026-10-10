// 文件读取助手：FileReader 的 Promise 封装，供各附件入口（Composer / PromptAssist 等）复用。
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
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
