/// 画布、命令面板与应用外壳级提示。
/// 注意：key 是中文原文，Prettier 的 quoteProps "as-needed" 会去掉纯中文键的引号，
/// 这里与其它分片一致统一带引号（中文标点本来就必须加引号）。
const canvas = {
  // App：启动与拖入提示
  "加载服务商失败：{{error}}": "Failed to load providers: {{error}}",
  "加载队列失败：{{error}}": "Failed to load queue: {{error}}",
  "最多添加 {{limit}} 张参考图": "At most {{limit}} reference images",
  "最多添加 {{limit}} 张参考图，已忽略多余文件":
    "At most {{limit}} reference images; extra files were ignored",

  // CanvasView
  画布: "Canvas",
  "{{name}} · {{n}} 个节点": "{{name}} · {{n}} nodes",
  "保存中…": "Saving…",
  未保存: "Unsaved",
  已保存: "Saved",
  "把作品放到一张无限画布上，再从节点进入编辑":
    "Arrange works on an infinite canvas, then edit from a node",
  重命名画布: "Rename canvas",
  删除画布: "Delete canvas",
  切换画布: "Switch canvas",
  新建画布: "New canvas",
  画布操作: "Canvas actions",
  添加图片: "Add image",
  画布编辑面板: "Canvas edit panel",
  画布名称: "Canvas name",
  "给这张画布起个名字，之后可以随时切换":
    "Name this canvas; you can switch anytime later",
  创建: "Create",
  名称会随画布一起保存: "The name is saved with the canvas",
  "删除这张画布？": "Delete this canvas?",
  "画布内的节点与连线会被删除，画廊里的作品不受影响。":
    "Nodes and connections on this canvas will be deleted. Gallery works are unaffected.",

  // CanvasBoard
  已粘贴图片到画布: "Image pasted to canvas",
  "粘贴失败：图片无法读取": "Paste failed: the image could not be read",
  剪贴板里没有图片: "No image in the clipboard",
  "无法读取剪贴板，可先复制图片再按 Ctrl V":
    "Cannot read the clipboard. Copy an image and press Ctrl V",
  "画布：拖动空白处平移，滚轮缩放":
    "Canvas: drag empty space to pan, scroll to zoom",
  画布还是空的: "The canvas is empty",
  "从画廊挑几张作品放进来，拖动排布、滚轮缩放，再从节点进入编辑。":
    "Add a few works from the gallery, drag to arrange, scroll to zoom, then edit from a node.",
  粘贴图片: "Paste image",
  去画廊: "Go to gallery",
  "点击起点节点，再点击终点连线 · Esc 退出":
    "Click a start node, then an end node to connect · Esc to exit",
  "再点击一个节点完成连线 · Esc 取消":
    "Click another node to finish the connection · Esc to cancel",
  "已选中连线 · 按 Delete 删除": "Connection selected · Press Delete to remove",
  浏览: "Browse",
  连线: "Connect",
  缩小: "Zoom out",
  放大: "Zoom in",
  "缩放 {{percent}}%": "Zoom {{percent}}%",
  适应: "Fit",

  // CanvasNode
  "图片不可用：{{error}}": "Image unavailable: {{error}}",
  "画布图 #{{id}}": "Canvas image #{{id}}",
  已加入聊天参考图: "Added to chat references",
  "添加参考图失败：{{error}}": "Failed to add reference image: {{error}}",
  该作品已从画廊删除: "This work was deleted from the gallery",
  "读取参数失败：{{error}}": "Failed to read settings: {{error}}",
  已回填生成参数: "Generation settings restored",
  局部重绘: "Inpaint",
  "AI 消除": "AI erase",
  扩图: "Expand",
  高清放大: "Upscale",
  风格转换: "Restyle",
  换背景: "Change background",
  基础编辑: "Basic edit",
  用作参考图: "Use as reference",
  动图: "Animated",
  播放动图: "Play animation",
  暂停动图: "Pause animation",
  动图不支持图层: "Animated images do not support layers",
  动图请用动图编辑器或单帧修复:
    "Use the animation editor or single-frame repair for animated images",
  "转静图（取首帧）": "Convert to still (first frame)",
  已转静图: "Converted to a still image",
  "转静图失败：{{error}}": "Failed to convert to a still image: {{error}}",
  复用参数: "Reuse settings",
  删除节点: "Delete node",
  "画布节点：作品 #{{id}}": "Canvas node: work #{{id}}",
  节点操作: "Node actions",
  点击另一个节点连线: "Click another node to connect",

  // CommandPalette
  命令面板: "Command palette",
  "输入关键词搜索命令，方向键选择，回车执行。":
    "Type to search commands, use the arrow keys to select, press Enter to run.",
  "搜索命令、页面或设置…": "Search commands, pages or settings…",
  搜索命令: "Search commands",
  命令: "Commands",
  没有匹配的命令: "No matching commands",
  选择: "Select",
  执行: "Run",
  "Esc 关闭": "Esc to close",

  // 命令分组与标题（lib/commands.ts 的字面量即 key）
  导航: "Navigation",
  对话: "Chats",
  队列: "Queue",
  外观: "Appearance",
  工具: "Tools",
  打开聊天: "Open chat",
  打开画廊: "Open gallery",
  打开画布: "Open canvas",
  打开队列: "Open queue",
  打开设置: "Open settings",
  新建对话: "New chat",
  聚焦提示词输入框: "Focus prompt input",
  打开提示词助手: "Open prompt assistant",
  搜索对话: "Search chats",
  开始队列: "Start queue",
  执行暂停中的生成任务: "Run paused generation tasks",
  清空已完成的队列任务: "Clear finished queue tasks",
  "主题：跟随系统": "Theme: System",
  "主题：浅色": "Theme: Light",
  "主题：暗色": "Theme: Dark",
  "玻璃质感：清晰": "Glass: Clear",
  "玻璃质感：标准": "Glass: Standard",
  "玻璃质感：着色": "Glass: Tinted",
  减少透明效果: "Reduce transparency",
  "关闭玻璃模糊，换取更低的绘制开销":
    "Turn off glass blur to lower rendering cost",
  恢复玻璃透明效果: "Restore glass transparency",
  "折叠 / 展开侧栏": "Collapse / expand sidebar",
  快捷键一览: "Show keyboard shortcuts",
  打开日志目录: "Open log directory",
  "打开日志目录失败：{{error}}": "Failed to open log directory: {{error}}",
} as const;

export default canvas;
