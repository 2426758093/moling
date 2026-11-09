/// 设置页：分区导航、外观、生成参数、自定义风格、数据备份、诊断。
/// 语法设置失败等通用键由 common / shell 分片提供，这里只放设置页自有文案。
const settings = {
  // 界面语言
  界面语言: "Language",
  "切换界面语言，立即生效": "Switch the display language. Applies immediately.",
  "保存语言设置失败：{{error}}": "Failed to save language: {{error}}",

  // 页面头与分区导航
  "服务商、外观与数据": "Providers, appearance and data",
  设置分区: "Settings sections",
  服务商: "Providers",
  外观: "Appearance",
  生成: "Generation",
  网络: "Network",
  存储: "Storage",
  诊断: "Diagnostics",
  关于: "About",

  // 服务商
  服务商管理: "Manage providers",
  至少添加一个服务商才能开始生成:
    "Add at least one provider before you can generate",
  新增服务商: "Add provider",
  "还没有服务商。点击「新增服务商」，填入地址和 Key 即可开始绘图。":
    "No providers yet. Click “Add provider”, enter the URL and key, and start creating.",

  // 外观
  "主题、材质与信息密度": "Theme, material and information density",
  清晰: "Clear",
  标准: "Standard",
  着色: "Tinted",
  玻璃质感: "Glass effect",
  "影响侧栏、标题栏与浮层的通透程度":
    "Controls how translucent the sidebar, title bar and overlays are",
  "浮层控制预览 · 玻璃只用在内容之上":
    "Overlay preview · Glass only sits above content",
  减少透明效果: "Reduce transparency",
  "关闭玻璃模糊、改用纯色面板，低性能设备更流畅":
    "Turns off glass blur and uses solid panels; smoother on low-end devices",
  画布内嵌编辑: "Inline canvas editing",
  "从画布节点进入的编辑在右侧面板展开；关闭后回到全屏浮层":
    "Edits started from canvas nodes open in the side panel; turn off to use a full-screen overlay",
  简单: "Simple",
  专家: "Expert",
  界面模式: "Interface mode",
  "简单模式只保留提示词、比例、风格与张数；专家模式显示负向词、队列与自定义尺寸":
    "Simple mode keeps only prompt, ratio, style and count; expert mode adds negative prompt, queue and custom size",

  // 生成
  默认生成参数: "Default generation settings",
  "决定新对话里的比例、风格与张数":
    "Sets the ratio, style and count used by new chats",
  当前参数: "Current settings",
  "以聊天页 Composer 里的设置为准":
    "Composer settings in the chat view take precedence",
  "{{size}} · 质量 {{quality}} · {{n}} 张":
    "{{size}} · Quality {{quality}} · {{n}} images",
  设为默认: "Set as default",
  将当前设为默认: "Set current as default",
  已保存为默认参数: "Saved as defaults",
  "保存默认参数失败：{{error}}": "Failed to save defaults: {{error}}",
  已恢复默认参数: "Defaults restored",
  "默认参数损坏，无法恢复":
    "Default settings are corrupted and cannot be restored",
  恢复默认: "Restore defaults",

  // 自定义风格
  自定义风格: "Custom styles",
  与内置风格一起出现在生成与风格转换里:
    "Shown alongside built-in styles in generation and style transfer",
  风格名称: "Style name",
  "例如：暖调胶片": "e.g. Warm film",
  风格提示词: "Style prompt",
  "例如：warm analog film, soft grain": "e.g. warm analog film, soft grain",
  添加风格: "Add style",
  已添加风格: "Style added",

  // 智能蒙版
  智能蒙版: "Smart mask",
  "本地 AI 识别主体，离线运行，不上传图片":
    "Local AI detects the subject. Runs offline and never uploads images",
  启用智能蒙版: "Enable smart mask",
  "一键选中背景、点选要消除的物体；首次使用会加载本地模型，之后约 0.1–0.5 秒出结果":
    "Select the background in one click, or click objects to remove them. The local model loads on first use, then takes about 0.1–0.5 s",
  已保存智能蒙版设置: "Smart mask setting saved",

  // 队列
  批量生成的启动行为与恢复策略: "How batch generation starts and resumes",
  启动时自动续跑队列: "Resume the queue on startup",
  "只处理排队中的任务；上次中断的任务仍需在队列页手动恢复，避免重复计费":
    "Only queued tasks resume; tasks interrupted last time still need a manual resume on the Queue page to avoid double billing",
  已保存队列设置: "Queue setting saved",

  // 数据备份
  数据备份: "Data backup",
  导出后可迁移到另一台设备: "Export to move your setup to another device",
  导出全部配置: "Export all settings",
  导出配置: "Export",
  导入配置: "Import",
  "同时导出 API Key": "Include API keys",
  "明文写入备份文件，仅用于本机迁移":
    "Written in plain text to the backup file; for local migration only",
  "导出文件将包含明文密钥，请勿分享或上传。":
    "The export will contain plain-text keys. Do not share or upload it.",
  "已导出（包含明文 API Key，请勿分享或上传）":
    "Exported (includes plain-text API keys; do not share or upload)",
  "已导出（不含 API Key）": "Exported (no API keys)",
  "导出失败：{{error}}": "Export failed: {{error}}",
  导入成功: "Imported",
  "导入失败：{{error}}": "Import failed: {{error}}",

  // 诊断
  诊断日志: "Diagnostic logs",
  "诊断包包含近 7 天日志、应用版本与系统信息、服务商元信息与设置项；不含图片、提示词与任何 API Key。日志里可能带上游返回的错误信息，分享前请自行确认。":
    "The diagnostics bundle contains the last 7 days of logs, app version and system info, provider metadata and settings. It never includes images, prompts or API keys. Logs may contain upstream error messages, so review them before sharing.",
  日志目录: "Log folder",
  导出诊断包: "Export diagnostics",
  打开所在目录: "Show in folder",
  "导出诊断包失败：{{error}}": "Failed to export diagnostics: {{error}}",
  "打开目录失败：{{error}}": "Failed to open folder: {{error}}",
  "已导出：{{path}}": "Exported: {{path}}",

  // 快捷键
  在任何页面都可用: "Works on any page",
} as const;

export default settings;
