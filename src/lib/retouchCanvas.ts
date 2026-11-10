// 修图台的画布薄层：只做「把图按坐标画到目标画布」，不含任何业务判断。
// jsdom 没有 canvas，这里不写单测；逻辑尽量短，错都错在显眼处。

import i18n from "../i18n";
import type { PixelSize } from "./retouchActions";

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
