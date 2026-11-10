/// 修图台（RetouchView）：动作 Chip、面板、步骤条与门禁文案。
/// 中文即 key；英文译文必须非空（i18n 测试会校验）。
const retouch = {
  修图: "Retouch",
  修图台: "Retouch studio",
  返回: "Back",
  关闭: "Close",
  打开修图: "Open retouch",
  拖入或选择一张图片开始修图: "Drop or pick a photo to start retouching",
  选择图片: "Choose image",
  请选择图片文件: "Please choose an image file",

  // 动作
  一键优化: "Auto enhance",
  美颜: "Beauty",
  "AI 消除": "AI erase",
  一句话改图: "One-line edit",
  改图: "Edit",
  开始改图: "Start editing",
  应用: "Apply",

  // 面板
  "自动校正曝光、白平衡与对比，只改色彩不动构图":
    "Fixes exposure, white balance and contrast — color only, composition untouched",
  强度: "Strength",
  分析建议: "Suggestions",
  "柔化肤色并轻微锐化，全程在本机完成":
    "Softens skin and adds a light sharpen, entirely on this device",
  磨皮力度: "Smoothing",
  "涂抹要消除的对象，其余区域保持不变":
    "Paint over what should disappear; everything else stays",
  确认消除: "Erase",
  "按你的原话改图，其余部分交给模型判断":
    "Sends your words as written and lets the model decide the rest",
  "描述你想怎么改，例如：把背景换成海边日落":
    "Describe the change, e.g. swap the background for a seaside sunset",
  修图面板: "Retouch panels",

  // 分析建议
  偏暗: "Too dark",
  偏亮: "Too bright",
  偏暖: "Too warm",
  偏冷: "Too cool",
  对比偏低: "Low contrast",
  色彩偏淡: "Under-saturated",
  检测到人像: "Face detected",
  有过曝或死黑: "Clipping detected",

  // 对比与步骤
  原图: "Original",
  // 血统里认不出的 op（编辑 / 画布导出等）
  编辑: "Edited",
  结果: "Result",
  预览: "Preview",
  "{{n}}% {{label}}": "{{n}}% {{label}}",
  应用一个动作后即可对比: "Apply an action to compare before and after",
  步骤: "Steps",
  未入库: "Not saved yet",
  从这一步继续: "Continue from here",
  "处理中…": "Working…",

  // 门禁与报错
  动图暂不支持修图: "Animated images can't be retouched yet",
  当前离线: "You're offline",
  请先在设置中配置服务商: "Add a provider in Settings first",
  请先在设置中选择默认模型: "Pick a default model in Settings first",
  当前模型不支持指令改图: "This model can't follow edit instructions",
  当前模型不支持局部编辑: "This model can't do local edits",
  请先涂抹要消除的区域: "Paint the area to erase first",
  请输入修改要求: "Describe what you want to change",
  "图片尺寸读取失败，请重试": "Couldn't read the image size, please retry",
  "图片读取失败，请重试": "Couldn't load the image, please retry",
  "回写画布失败：{{error}}": "Failed to write back to canvas: {{error}}",
} as const;

export default retouch;
