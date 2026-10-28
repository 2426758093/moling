/// 参考图上限：上传、拖拽、引用图三个入口统一使用。
/// 目前没有模型能力元数据，固定 4 张；后端会再次截断兜底。
export const MAX_REFERENCE_IMAGES = 4;

/// 允许下载/打包的图片扩展名白名单（与 image_store 落盘时的嗅探结果一致）
const SAFE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg"]);

/// 从磁盘文件路径推断安全扩展名；白名单外一律回退 png。
///
/// 下载与打包导出共用同一实现：此前 ImageCard 固定写成 .png、画廊下载直接取
/// `split('.').pop()`，导致 SVG/WEBP 图被存成 .png（双击打不开）。
export function extOf(filePath: string) {
  const ext = (filePath.split(".").pop() ?? "").toLowerCase();
  return SAFE_EXT.has(ext) ? ext : "png";
}
