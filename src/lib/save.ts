// 用户可见的文件导出统一走系统保存对话框：WebView2 没有下载处理器，
// anchor.download 不会产生文件，必须在 Rust 侧写盘。
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import i18n from "../i18n";
import { api } from "./api";
import { toast } from "./notify";

interface SaveFilter {
  name: string;
  extensions: string[];
}

async function pickPath(
  defaultPath: string,
  filters: SaveFilter[],
): Promise<string | null> {
  try {
    // 用户取消返回 null；取消不是错误，调用方静默处理
    return await saveDialog({ defaultPath, filters });
  } catch (e) {
    toast(
      i18n.t("无法打开保存对话框：{{error}}", { error: String(e) }),
      "error",
    );
    return null;
  }
}

function extOfName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function filterFor(name: string, label: string): SaveFilter[] {
  const ext = extOfName(name);
  return ext ? [{ name: label, extensions: [ext] }] : [];
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // 分块拼接：String.fromCharCode 直接展开大数组会爆栈
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 原图另存为；返回是否真的写入（取消返回 false）。 */
export async function saveHistoryImage(
  id: number,
  filename: string,
  paramsText?: string,
): Promise<boolean> {
  const path = await pickPath(filename, filterFor(filename, i18n.t("图片")));
  if (!path) return false;
  await api.saveHistoryImage(id, path, paramsText ?? null);
  return true;
}

/** data URL 导出（查看器只持有 dataUrl，没有历史 id）；返回是否写入。 */
export async function saveDataUrl(
  dataUrl: string,
  filename: string,
): Promise<boolean> {
  const path = await pickPath(filename, filterFor(filename, i18n.t("图片")));
  if (!path) return false;
  await api.writeFileBase64(path, await dataUrlToBase64(dataUrl));
  return true;
}

async function dataUrlToBase64(dataUrl: string): Promise<string> {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("图片数据无效");
  if (dataUrl.slice(0, comma).includes(";base64")) {
    return dataUrl.slice(comma + 1);
  }
  return blobToBase64(await (await fetch(dataUrl)).blob());
}

/** 按 data URL 的 MIME 推断扩展名，避免把 SVG / JPEG 存成 .png */
export function extFromDataUrl(dataUrl: string): string {
  const mime = /^data:image\/([a-z0-9.+-]+)[;,]/i.exec(dataUrl)?.[1] ?? "";
  if (mime === "jpeg") return "jpg";
  if (mime === "svg+xml") return "svg";
  return mime && mime !== "png" ? mime : "png";
}

/** 打包导出；返回 null 表示用户取消。 */
export async function exportHistoryZip(
  entries: { historyId: number; params: Record<string, unknown> }[],
  filename: string,
): Promise<{ saved: number; skipped: number } | null> {
  const path = await pickPath(
    filename,
    filterFor(filename, i18n.t("ZIP 压缩包")),
  );
  if (!path) return null;
  return api.exportHistoryZip(entries, path);
}

/** 文本 / JSON 导出；返回是否写入。 */
export async function saveTextFile(
  content: string,
  filename: string,
): Promise<boolean> {
  const path = await pickPath(filename, filterFor(filename, i18n.t("文件")));
  if (!path) return false;
  await api.writeTextFile(path, content);
  return true;
}

/** Blob 导出（备份 / 收藏 / 预设 JSON）；返回是否写入。 */
export async function saveBlob(blob: Blob, filename: string): Promise<boolean> {
  const path = await pickPath(filename, filterFor(filename, i18n.t("文件")));
  if (!path) return false;
  await api.writeFileBase64(path, await blobToBase64(blob));
  return true;
}
