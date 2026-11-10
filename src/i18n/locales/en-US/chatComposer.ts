/// 输入坞（Composer）与提示词助手（PromptAssist）：参数胶囊、采样面板、
/// 自动翻译条、队列/生成按钮，以及助手的模板、灵感、反推、收藏、预设与翻译分区。
const chatComposer = {
  // 尺寸与比例
  自定义尺寸: "Custom size",
  宽度: "Width",
  高度: "Height",
  应用: "Apply",
  "512–4096，自动对齐到 8 的倍数": "512–4096, snapped to a multiple of 8",
  画面比例与尺寸: "Aspect ratio and size",
  画面比例: "Aspect ratio",
  自动: "Auto",
  自定义: "Custom",
  由服务商决定: "Decided by the provider",

  // 张数与质量
  每次生成张数: "Images per generation",
  每次生成: "Images per run",
  "{{n}} 张": "{{n}} images",
  图片质量: "Image quality",
  质量: "Quality",
  低: "Low",
  中: "Medium",
  高: "High",
  极高: "Very high",
  最高: "Highest",
  "自动不发送质量参数；低 / 中 / 高 / 极高 / 最高需要服务商支持":
    "Auto sends no quality parameter; low / medium / high / very high / highest require provider support",

  // 动图输出
  输出格式: "Output format",
  静态图: "Still image",
  动图: "Animated",
  帧数: "Frames",
  动图帧数: "Animated frame count",
  每帧时长: "Frame duration",
  "每帧时长（毫秒）": "Frame duration (ms)",
  复杂度: "Complexity",
  动图复杂度: "Animated complexity",
  "20–2000ms，按 10ms 取整；GIF 按 token 计费，需模型开通预览权限，且不支持蒙版编辑。":
    "20–2000ms, rounded to 10ms. GIF is billed by token, requires preview access on the model, and doesn't support mask editing.",
  "动图模式下每个数量都会单独调用一次，费用 ×{{n}}":
    "Animated mode calls once per image, so the cost is ×{{n}}",
  "当前模型未开通 GIF 输出，请切换模型或改回静态图":
    "This model doesn't have GIF output enabled; switch models or go back to still images",

  // 采样参数
  高级采样参数: "Advanced sampling",
  采样: "Sampling",
  "Guidance 应为 0–30 的数字": "Guidance must be a number between 0 and 30",
  "Steps 应为 1–150 的整数": "Steps must be an integer between 1 and 150",
  "Seed 应为非负整数": "Seed must be a non-negative integer",
  "如 7.5（留空不发送）": "e.g. 7.5 (leave empty to skip)",
  "如 30（留空不发送）": "e.g. 30 (leave empty to skip)",
  固定随机种子可复现: "A fixed seed keeps results reproducible",
  "写入所选服务商的透传参数，影响该服务商全部请求；部分模型不支持这些字段。":
    "Writes pass-through parameters for the selected provider, affecting all of its requests; some models don't support these fields.",
  清除: "Clear",
  请先选择绘图服务商: "Select an image provider first",
  已更新采样参数: "Sampling parameters updated",

  // 风格与负向词
  风格: "Style",
  无风格: "No style",
  负向提示词: "Negative prompt",
  负向: "Negative",
  负向提示词内容: "Negative prompt text",
  "不希望出现的元素，如：模糊、水印": "Elements to avoid, e.g. blur, watermark",

  // 参考图
  参考图: "Reference image",
  "{{n}} 张参考图": "{{n}} reference images",
  "{{n}} 参考图": "{{n}} reference images",
  松开以添加参考图: "Drop to add reference images",
  已压缩: "Compressed",
  "移除附件 {{name}}": "Remove attachment {{name}}",
  "{{name}} 的参考角色": "Reference role for {{name}}",
  参考强度: "Reference strength",
  构图参考: "Composition reference",
  风格参考: "Style reference",
  人脸参考: "Face reference",
  元素参考: "Element reference",

  // 区域提示
  区域提示: "Region hints",
  区域: "Regions",
  "区域提示（最多 {{n}} 个）": "Region hints (up to {{n}})",
  "区域 {{n}} 位置": "Region {{n}} position",
  "区域 {{n}} 描述": "Region {{n}} description",
  "删除区域 {{n}}": "Delete region {{n}}",
  该区域画什么: "What goes in this region",
  左侧: "Left",
  中央: "Center",
  右侧: "Right",
  上方: "Top",
  下方: "Bottom",
  背景: "Background",
  全画面: "Full frame",
  添加区域: "Add region",
  写入提示词: "Insert into prompt",
  "按区域逐个描述，模型可能不完全遵循；需要精确改图请用局部重绘。":
    "Each region is described separately and the model may not follow it exactly; use inpainting for precise edits.",

  // 输入与发送
  提示词: "Prompt",
  "描述你想要的画面…": "Describe the image you want…",
  提示词助手: "Prompt assistant",
  加入队列: "Add to queue",
  停止: "Stop",
  生成: "Generate",
  撤销: "Undo",
  已自动翻译为英文: "Auto-translated to English",
  "Enter 发送 · Shift Enter 换行 · / 提示词助手":
    "Enter to send · Shift Enter for a new line · / for prompt assistant",
  请先填写区域描述: "Add a region description first",
  "请先在「设置」中配置绘图服务商与模型":
    "Configure an image provider and model in Settings first",
  已加入队列: "Added to queue",
  "加入队列失败：{{error}}": "Failed to add to queue: {{error}}",
  "最多添加 {{n}} 张参考图": "You can add up to {{n}} reference images",
  "最多添加 {{n}} 张参考图，已忽略多余文件":
    "You can add up to {{n}} reference images; extra files were ignored",

  // 提示词助手：通用
  提示词助手分区: "Prompt assistant sections",
  关闭提示词助手: "Close prompt assistant",
  填入输入框: "Insert into composer",
  导出失败: "Export failed",
  文件格式不正确: "Invalid file format",
  "导出 JSON": "Export JSON",
  "导入 JSON": "Import JSON",
  优化: "Optimize",
  模板: "Templates",
  灵感: "Inspiration",
  反推: "Reverse",
  收藏: "Favorites",
  预设: "Presets",
  翻译: "Translate",

  // 提示词助手：优化
  "先在输入框写好提示词，再回来优化":
    "Write a prompt in the composer first, then come back to optimize",
  "补全场景、构图、光线与质感，保留原意":
    "Fills in scene, composition, lighting and texture while keeping the intent",
  "补全场景、构图、光线与质感，保留原意（需要先输入内容）":
    "Fills in scene, composition, lighting and texture while keeping the intent (input required first)",
  "优化中…": "Optimizing…",
  优化结果: "Optimized result",

  // 提示词助手：模板
  模板名称: "Template name",
  模板内容: "Template content",
  "模板内容（提示词，{subject} 可作占位）":
    "Template content (a prompt; {subject} works as a placeholder)",
  保存为自定义模板: "Save as custom template",
  "删除模板 {{name}}": "Delete template {{name}}",

  // 提示词助手：灵感
  再掷一次: "Roll again",
  使用这条: "Use this one",

  // 提示词助手：反推
  "上传图片，反推绘制提示词": "Upload an image to reverse-engineer its prompt",
  反推对象: "Image to reverse-engineer",
  "正在反推…": "Analyzing…",
  反推结果: "Reverse result",
  换一张: "Use another image",

  // 提示词助手：收藏
  "标签，逗号分隔（可选）": "Tags, comma separated (optional)",
  收藏标签: "Favorite tags",
  收藏当前: "Save current",
  全部: "All",
  已收藏当前提示词: "Saved the current prompt to favorites",
  "该提示词已存在，已更新收藏": "Prompt already saved; favorite updated",
  "删除收藏：{{preview}}": "Delete favorite: {{preview}}",
  "还没有收藏，先在输入框写好提示词":
    "No favorites yet — write a prompt in the composer first",
  该标签下没有收藏: "No favorites with this tag",
  还没有可导出的收藏: "No favorites to export",
  "已导入 {{n}} 条收藏": "Imported {{n}} favorites",
  文件中没有可导入的收藏: "No favorites found in the file",
  "导入收藏失败：{{error}}": "Failed to import favorites: {{error}}",

  // 提示词助手：预设
  预设名称: "Preset name",
  "保存中…": "Saving…",
  保存当前: "Save current",
  "保存草稿、负向词、尺寸 / 比例 / 风格 / 张数，以及当前参考图（最多 4 张）":
    "Saves the draft, negative prompt, size / ratio / style / count and the current reference images (up to 4)",
  "已保存预设「{{name}}」": "Saved preset “{{name}}”",
  "预设最多保存 4 张参考图，已取前 4 张":
    "A preset holds at most 4 reference images; kept the first 4",
  "保存预设失败：{{error}}": "Failed to save preset: {{error}}",
  "删除预设 {{name}}": "Delete preset {{name}}",
  "（无提示词）": "(no prompt)",
  "还没有预设，命名后点击「保存当前」":
    "No presets yet — name one and click “Save current”",
  还没有可导出的预设: "No presets to export",
  "已导出预设，{{n}} 张参考图缺失被跳过":
    "Presets exported; {{n}} missing reference images were skipped",
  "已导入 {{ok}} 个预设": "Imported {{ok}} presets",
  "已导入 {{ok}} 个预设，{{failed}} 个失败":
    "Imported {{ok}} presets, {{failed}} failed",
  "导入预设失败：{{error}}": "Failed to import presets: {{error}}",

  // 提示词助手：翻译
  "先在输入框写好提示词，再回来翻译":
    "Write a prompt in the composer first, then come back to translate",
  "翻译中…": "Translating…",
  翻译结果: "Translation result",
  "中 → 英": "Chinese → English",
  "英 → 中": "English → Chinese",
  "方向：{{dir}}": "Direction: {{dir}}",
  "方向：{{dir}}（需要先输入内容）":
    "Direction: {{dir}} (input required first)",
} as const;

export default chatComposer;
