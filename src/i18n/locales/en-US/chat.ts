/// 聊天：消息、输入框、提示词助手、图片卡片与查看器。
const chat = {
  // ChatView
  新对话: "New chat",
  未配置模型: "No model configured",
  "{{n}} 条消息 · {{model}}": "{{n}} messages · {{model}}",
  打开命令面板: "Open command palette",
  命令: "Commands",
  "AI 绘图": "AI Image",
  "描述画面，即刻成图": "Describe it, get an image",
  "像聊天一样描述想法，墨灵会读懂原话并绘制出来":
    "Describe your idea in chat; Moling understands and draws it",
  "拖入图片作为参考 · Ctrl K 打开命令面板":
    "Drop an image as reference · Ctrl K for command palette",
  "正在加载更早的消息…": "Loading earlier messages…",
  上滑加载更早的消息: "Scroll up to load earlier messages",

  // MessageItem
  思考模型已优化提示词: "Reasoning model refined your prompt",
  你的描述: "Your description",
  优化后的提示词: "Refined prompt",
  复制提示词: "Copy prompt",
  已复制提示词: "Prompt copied",
  编辑提示词: "Edit prompt",
  "正在绘制 · {{done}}/{{total}}": "Drawing · {{done}}/{{total}}",
  "正在绘制 · 剩余 {{n}} 张": "Drawing · {{n}} left",
  绘制中: "Drawing",
  已停止生成: "Generation stopped",
  "已停止等待，结果已保存": "Stopped waiting; result saved",
  "已停止等待，结果已保存到画廊": "Stopped waiting; result saved to gallery",
  "已停止等待，但结果未确认，请先到服务商后台核对是否计费":
    "Stopped waiting, but the result is unconfirmed. Check your provider console for charges first",
  结果未确认: "Result unconfirmed",
  "可能已计费，重试会再次扣费":
    "May already be charged; retrying will charge again",
  "已复制请求 ID": "Request ID copied",
  "复制请求 ID（对账用）": "Copy request ID (for reconciliation)",
  尝试恢复: "Try recover",
  "恢复中…": "Recovering…",
  "已恢复 {{n}} 张到画廊": "Recovered {{n}} image(s) to gallery",
  "（{{n}} 张仍失败）": " ({{n}} still failed)",
  "恢复失败：{{error}}": "Recovery failed: {{error}}",
  "确认重新生成？": "Regenerate anyway?",
  "这次请求可能已在服务商侧计费。重新生成会再次扣费，请先到服务商后台确认没有出图。":
    "This request may already have been billed. Regenerating will charge you again; confirm in your provider console that no image was produced first.",
  仍然重新生成: "Regenerate anyway",

  // ImageCard
  下载失败: "Download failed",
  "引用图 #{{id}}": "Reference image #{{id}}",
  添加参考图失败: "Failed to add reference image",
  "删除失败：{{error}}": "Delete failed: {{error}}",
  局部重绘: "Inpaint",
  "AI 消除": "AI erase",
  扩图: "Expand",
  高清放大: "Upscale",
  风格转换: "Restyle",
  引用为参考图: "Use as reference",
  换背景: "Change background",
  基础编辑: "Basic edit",
  下载: "Download",
  "查看大图：{{prompt}}": "View full size: {{prompt}}",
  "派生自 #{{id}}": "Derived from #{{id}}",
  查看原图: "View original",
  已复制: "Copied",
  更多操作: "More actions",

  // ImageViewer
  图片查看器: "Image viewer",
  下载图片: "Download image",
  退出全屏: "Exit fullscreen",
  全屏查看: "View fullscreen",
  关闭查看器: "Close viewer",
  上一张: "Previous image",
  下一张: "Next image",
  "查看第 {{n}} 张": "View image {{n}}",

  // CompareDialog
  未知模型: "Unknown model",
  对比模式: "Compare mode",
  滑动对比: "Slide",
  并排对比: "Side by side",
  "原图不可用，无法对比": "Originals unavailable, cannot compare",
  "加载原图中…": "Loading originals…",
  对比分隔位置: "Compare divider position",
  左图: "Left image",
  右图: "Right image",
  "左 #{{id}}": "Left #{{id}}",
  "右 #{{id}}": "Right #{{id}}",
  对比图: "Comparison image",
  "（无提示词）": "(No prompt)",
  "对比 #{{a}} 与 #{{b}}": "Compare #{{a}} vs #{{b}}",
  对比: "Compare",
  "滑动模式拖动分隔线（或按 ← →）查看两图差异":
    "In slide mode, drag the divider (or press ← →) to compare the images",

  // SafeImg
  "{{alt}}（图片缺失）": "{{alt}} (image missing)",
  图片缺失: "Image missing",
} as const;

export default chat;
