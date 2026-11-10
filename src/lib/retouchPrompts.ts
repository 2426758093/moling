// 修图台的固定提示词。护栏后缀只给「固定动作」用；
// 一句话改图是用户原话，绝不追加（否则用户写「只改背景」会被动到别处）。

/** 固定动作的护栏后缀：只改需要改的，保住身份 / 构图 / 光线 */
export const GUARD_SUFFIX =
  " Keep everything else unchanged; preserve identity, composition and lighting.";

export const ERASE_PROMPT =
  "Remove the painted object and reconstruct the background naturally." +
  GUARD_SUFFIX;

/** 扩图：把透明 padding 补成自然延续的画面（与旧 OutpaintView 同一句） */
export const OUTPAINT_PROMPT =
  "Extend the scene naturally to fill the transparent areas, matching the original style, lighting and content.";

/** 固定动作的提示词 + 护栏；用户原话（一句话改图）绝不走这里 */
export function withGuard(prompt: string): string {
  const trimmed = prompt.trim();
  return trimmed ? trimmed + GUARD_SUFFIX : trimmed;
}
