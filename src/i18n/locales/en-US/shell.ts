/// 外壳：侧栏、标题栏、页面头、快捷键、拖拽提示、窗口控制。
/// 注意：Prettier 的 quoteProps "as-needed" 会去掉纯中文键的引号，
/// 这里保持与其它分片一致的带引号写法（中文标点本来就必须加引号）。
const shell = {
  // 侧栏
  新对话: "New chat",
  搜索对话: "Search chats",
  对话: "Chats",
  导航: "Navigation",
  系统: "System",
  对话列表: "Chat list",
  "打开对话：{{title}}": "Open chat: {{title}}",
  "删除对话：{{title}}": "Delete chat: {{title}}",
  没有匹配的对话: "No matching chats",
  还没有对话: "No chats yet",
  画布: "Canvas",
  画廊: "Gallery",
  队列: "Queue",
  设置: "Settings",
  "{{n}} 个任务待执行": "{{n}} tasks pending",
  "主题：{{theme}}": "Theme: {{theme}}",
  "主题：{{theme}}，点击切换": "Theme: {{theme}}. Click to switch",
  跟随系统: "System",
  暗色: "Dark",
  浅色: "Light",
  命令面板: "Command palette",
  打开命令面板: "Open command palette",
  命令: "Commands",
  展开侧栏: "Expand sidebar",
  折叠侧栏: "Collapse sidebar",

  // 标题栏
  聊天: "Chat",
  切换侧栏: "Toggle sidebar",
  搜索或跳转: "Search or jump to",

  // 窗口控制
  最小化: "Minimize",
  最大化: "Maximize",
  还原: "Restore",

  // 快捷键一览
  快捷键: "Keyboard shortcuts",
  "输入框聚焦时，只有带 Ctrl 的组合键会触发全局命令。":
    "While an input is focused, only Ctrl shortcuts trigger global commands.",
  全局: "Global",
  列表: "List",
  "折叠 / 展开侧栏": "Collapse / expand sidebar",
  新建对话: "New chat",
  "切换聊天 / 画廊 / 画布 / 队列 / 设置":
    "Switch between chat / gallery / canvas / queue / settings",
  打开设置: "Open settings",
  快捷键一览: "Show keyboard shortcuts",
  "关闭浮层 / 退出连线": "Close overlay / leave connection mode",
  立即保存画布: "Save canvas now",
  适应画布视图: "Fit canvas to view",
  "放大 / 缩小画布": "Zoom canvas in / out",
  把剪贴板图片粘贴到画布: "Paste image from clipboard to canvas",
  删除选中的节点或连线: "Delete selected node or connection",
  画廊连续多选: "Multi-select in gallery",
  画廊全选已加载作品: "Select all loaded gallery items",

  // 拖拽遮罩
  松开以添加参考图: "Drop to add reference images",
  "支持 PNG / JPG / WebP，会加入当前对话的参考图":
    "PNG / JPG / WebP supported. Added as reference images for this chat.",

  // 设置侧栏
  生成设置: "Generation",
  折叠设置栏: "Collapse settings",
  展开生成设置: "Expand generation settings",
  绘图服务商: "Image provider",
  绘图模型: "Image model",
  "（未选择）": "(none)",
  思考模型: "Thinking model",
  未选模型: "no model",
  "已启用 · {{model}}": "Enabled · {{model}}",
  生成前理解意图: "Interprets intent before generating",
  启用思考模型: "Enable thinking model",
  "配置思考模型…": "Configure thinking model…",
  "保存思考模型配置失败：{{error}}": "Failed to save thinking model: {{error}}",
  "保存默认模型失败：{{error}}": "Failed to save default model: {{error}}",

  // 更新弹窗
  发现新版本: "Update available",
  正在下载更新: "Downloading update",
  更新已就绪: "Update ready",
  正在安装更新: "Installing update",
  更新失败: "Update failed",
  软件更新: "Software update",
  稍后: "Later",
  下载更新: "Download update",
  后台下载: "Download in background",
  稍后安装: "Install later",
  立即安装并重启: "Install and restart",
  "正在安装…": "Installing…",
  重试下载: "Retry download",
  "新版本 {{version}} 已发布": "Version {{version}} is available",
  "新版本 {{version}}": "Version {{version}}",
  该版本未提供更新说明: "No release notes for this version",
  "下载完成，安装后应用会自动重启":
    "Download complete. The app will restart after installation.",
  "{{percent}}% · {{downloaded}} / {{total}} · {{speed}} · {{route}}":
    "{{percent}}% · {{downloaded}} / {{total}} · {{speed}} · {{route}}",
  "已下载 {{downloaded}} · {{speed}} · {{route}}":
    "Downloaded {{downloaded}} · {{speed}} · {{route}}",
  自动选择线路: "auto-selected route",
  "正在安装更新，应用即将自动重启…":
    "Installing update. The app will restart shortly…",
} as const;

export default shell;
