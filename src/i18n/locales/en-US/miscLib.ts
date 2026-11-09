/// 非组件工具模块：服务商错误标题、保存对话框、附件校验与编辑结果落点。
/// key 是中文原文，value 是英文译文；缺失的 key 在英文下会回退中文。
/// 注意：含中文标点或插值的 key 必须写成带引号的字符串。
const miscLib = {
  // lib/api.ts · AdapterError 标题（type 枚举不翻译）
  "API Key 无效": "Invalid API key",
  余额不足或触发限额: "Out of balance or rate limit reached",
  请求超时: "Request timed out",
  内容审核拦截: "Blocked by content moderation",
  该服务商不支持此操作: "This provider doesn't support this action",
  请求失败: "Request failed",

  // lib/save.ts · 系统保存对话框
  "无法打开保存对话框：{{error}}": "Couldn't open the save dialog: {{error}}",
  图片: "Image",
  "ZIP 压缩包": "ZIP archive",
  文件: "File",

  // lib/file.ts · 参考图附件校验
  "「{{name}}」超过 10MB，无法作为参考图":
    "{{name}} is over 10MB and can't be used as a reference image",
  "「{{name}}」不是图片文件": "{{name}} isn't an image file",
  "「{{name}}」图片损坏或格式不受支持":
    "{{name}} is corrupted or in an unsupported format",

  // lib/deliverEditResult.ts · 编辑结果落点提示
  已加入画布: "Added to canvas",
  "已保存到画廊（当前没有打开的会话）":
    "Saved to the gallery (no conversation is open)",
  "已生成，结果已放入当前会话": "Generated, result added to this conversation",
} as const;

export default miscLib;
