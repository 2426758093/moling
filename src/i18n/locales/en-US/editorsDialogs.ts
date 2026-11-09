/// 编辑弹窗：高清放大 / 风格转换、画布从画廊添加、蒙版画布。
/// key 是中文原文，value 是英文译文；缺失的 key 在英文下会回退中文。
const editorsDialogs = {
  // 高清放大 / 风格转换（TransformDialog）
  高清放大: "Upscale",
  风格转换: "Style transfer",
  "按倍数重新绘制，放大结果会保留原图作为父记录":
    "Redraws at a larger scale; the original is kept as the parent record",
  "按风格描述重新绘制，构图与主体保持不变":
    "Redraws in the described style; composition and subject stay the same",
  开始处理: "Process",
  待处理图片: "Source image",
  模型: "Model",
  倍数: "Scale",
  放大倍数: "Upscale factor",
  模式: "Mode",
  放大模式: "Upscale mode",
  细节增强: "Enhance details",
  忠实还原: "Faithful",
  风格: "Style",
  "补充描述（可选）": "Extra description (optional)",
  "例如：暖色调、柔和光线…": "e.g. warm tones, soft light…",
  "高清放大 {{scale}}x": "Upscale {{scale}}x",
  "风格转换：{{style}}": "Style transfer: {{style}}",
  自定义: "Custom",

  // 画布：从画廊添加（CanvasAddDialog）
  从画廊添加: "Add from gallery",
  "最近 {{n}} 张作品；加入后可以在画布上拖动排布":
    "Your {{n}} most recent works; drag them around the canvas once added",
  完成: "Done",
  "画廊还没有作品，先去生成几张吧":
    "No works in the gallery yet; generate a few first",
  "作品 #{{id}}": "Work #{{id}}",
  "加入画布：{{prompt}}": "Add to canvas: {{prompt}}",
  已在画布: "On canvas",
  "已在画布：{{prompt}}": "Already on canvas: {{prompt}}",
  已加入画布: "Added to canvas",
  "加载画廊失败，请稍后重试": "Couldn't load the gallery. Try again later",

  // 蒙版画布（MaskCanvas）
  蒙版图片加载失败: "Couldn't load the mask image",
} as const;

export default editorsDialogs;
