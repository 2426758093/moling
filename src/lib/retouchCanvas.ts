// 修图台的画布薄层：只做「把图按坐标画到目标画布」，不含任何业务判断。
// jsdom 没有 canvas，这里不写单测；逻辑尽量短，错都错在显眼处。

import i18n from "../i18n";
import type { PixelSize } from "./retouchActions";
import { rotatedSize } from "./retouchGeometry";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(i18n.t("图片读取失败，请重试")));
    img.src = src;
  });
}

/** 把原图按 offset 画到透明目标画布上（扩图用），返回 PNG data URL */
export async function padImageToSize(
  src: string,
  target: PixelSize,
  offset: { x: number; y: number },
): Promise<string> {
  const img = await loadImage(src);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(target.width));
  canvas.height = Math.max(1, Math.round(target.height));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(i18n.t("图片读取失败，请重试"));
  ctx.drawImage(img, Math.round(offset.x), Math.round(offset.y));
  return canvas.toDataURL("image/png");
}

export interface CropPreviewInput {
  deg: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  rect: { x: number; y: number; width: number; height: number };
  brightness: number;
  contrast: number;
  saturation: number;
}

/** 本地实时预览：旋转/翻转 → 裁剪 → 滤镜，只返回缩放后的 data URL（不写盘不写库） */
export async function renderCropPreview(
  src: string,
  input: CropPreviewInput,
  maxSide = 1024,
): Promise<string> {
  const img = await loadImage(src);
  const natW = Math.max(1, img.naturalWidth);
  const natH = Math.max(1, img.naturalHeight);

  // 先在一张「变换后尺寸」的中间画布上摆正，后续裁剪坐标才和提交一致
  const mid = rotatedSize({ width: natW, height: natH }, input.deg);
  const midCanvas = document.createElement("canvas");
  midCanvas.width = Math.max(1, mid.width);
  midCanvas.height = Math.max(1, mid.height);
  const midCtx = midCanvas.getContext("2d");
  if (!midCtx) throw new Error(i18n.t("图片读取失败，请重试"));
  midCtx.translate(midCanvas.width / 2, midCanvas.height / 2);
  if (input.deg !== 0) midCtx.rotate((input.deg * Math.PI) / 180);
  midCtx.scale(input.flipH ? -1 : 1, input.flipV ? -1 : 1);
  midCtx.drawImage(img, -natW / 2, -natH / 2);

  const rect = input.rect;
  const longest = Math.max(1, rect.width, rect.height);
  const scale = Math.min(1, maxSide / longest);
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(rect.width * scale));
  out.height = Math.max(1, Math.round(rect.height * scale));
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error(i18n.t("图片读取失败，请重试"));
  // 滤镜与 BasicEditView 同公式；环境不支持 ctx.filter 时退回未调色预览
  try {
    ctx.filter = `brightness(${1 + input.brightness / 100}) contrast(${
      1 + input.contrast / 100
    }) saturate(${1 + input.saturation / 100})`;
  } catch {
    // 忽略：继续画未调色的预览
  }
  ctx.drawImage(
    midCanvas,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    out.width,
    out.height,
  );
  return out.toDataURL("image/png");
}
