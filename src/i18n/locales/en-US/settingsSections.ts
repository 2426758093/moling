/// 设置页分区：服务商增删改、AI 助手、网络代理、存储缓存与更新。
/// key 是中文原文，value 是英文译文；缺失的 key 在英文下会回退中文。
const settingsSections = {
  // 服务商接口类型（ui.ts KIND_OPTIONS）
  "OpenAI 兼容接口": "OpenAI-compatible API",
  "自定义接口（占位符模板）": "Custom API (placeholder template)",
  "Mock 调试适配器": "Mock debug adapter",

  // ProviderDialog · 步骤与表单
  基本信息: "Basics",
  拉取模型: "Fetch models",
  拉取模型列表: "Fetch model list",
  编辑服务商: "Edit provider",
  上一步: "Back",
  下一步: "Next",
  配置步骤: "Configuration steps",
  名称: "Name",
  "例如：SiliconFlow": "e.g. SiliconFlow",
  接口类型: "API type",
  "API 地址（Base URL）": "API base URL",
  "留空则继续使用已保存的 Key": "Leave empty to keep the saved key",
  "已保存 {{key}}。出于安全考虑不回填明文 Key；留空保存即保持不变。":
    "Saved key {{key}}. Plain keys are never shown; leave empty to keep it.",
  "已保存 {{key}}。出于安全考虑不回填明文 Key；留空保存即保持不变。填写新 Key 会替换第 1 个，其余保留。":
    "Saved key {{key}}. Plain keys are never shown; leave empty to keep it. A new key replaces the first one and keeps the rest.",
  "仅保存在本机，不会随备份导出（除非显式勾选）":
    "Stored only on this device; not exported with backups unless selected",

  // ProviderDialog · Key 池
  "Key 池（鉴权失败时自动切换到下一个）":
    "Key pool (switches to the next key on auth failure)",
  "{{n}} 个": "{{n}} keys",
  "· {{n}} 失效": "· {{n}} invalid",
  已失效: "Invalid",
  可用: "Active",
  "恢复 Key {{n}}": "Restore key {{n}}",
  "删除 Key {{n}}": "Delete key {{n}}",
  恢复: "Restore",
  "还没有 Key，可在上方 API Key 里填写主 Key 后保存。":
    "No keys yet. Enter a primary key above and save.",
  "添加备用 Key": "Add backup key",
  添加: "Add",

  // ProviderDialog · 模板与高级设置
  请求地址模板: "Request URL template",
  "可用占位符：{{prompt}} {{image}} {{size}} {{key}}":
    "Available placeholders: {{prompt}} {{image}} {{size}} {{key}}",
  "请求体模板（JSON）": "Request body template (JSON)",
  "可用变量：prompt / negative_prompt / size / width / height / model / seed / count / key / image / images / image_count。image 为第一张参考图的 base64。":
    "Available variables: prompt / negative_prompt / size / width / height / model / seed / count / key / image / images / image_count. image is the base64 of the first reference image.",
  "高级设置（编辑模板 / 变换模板）": "Advanced (edit / transform templates)",
  "配置后可局部重绘、消除、扩图、放大与风格转换":
    "Enables inpaint, erase, expand, upscale and restyle",
  编辑模板: "Edit template",
  "局部重绘 / AI 消除 / 扩图共用": "Shared by inpaint, AI erase and expand",
  变换模板: "Transform template",
  "高清放大 / 风格转换共用": "Shared by upscale and restyle",
  插入占位符: "Insert placeholder",
  请求地址: "Request URL",
  "请求体（JSON）": "Request body (JSON)",
  响应路径: "Response path",
  "留空按 data[0].b64_json 提取":
    "Leave empty to extract from data[0].b64_json",
  "超时（秒）": "Timeout (seconds)",
  "等待服务商返回响应的上限。图片生成（高画质 / 多参考图）常需 1–5 分钟，建议不低于 300 秒；客户端提前断开时上游可能仍在生成并计费":
    "Max wait for the provider to respond. Image generation (high quality / multiple references) often takes 1–5 minutes, so 300 seconds or more is recommended; if the client disconnects early, the upstream job may still run and be billed",
  "透传参数（JSON，可选）": "Extra params (JSON, optional)",
  '{"quality":"high"} 或 {"steps":30,"seed":42}':
    '{"quality":"high"} or {"steps":30,"seed":42}',
  "会合并进请求体，优先于默认参数":
    "Merged into the request body and overrides defaults",

  // ProviderDialog · 模型与能力
  "模型列表（英文逗号分隔）": "Model list (comma-separated)",
  "点击「拉取模型列表」自动请求服务商的模型接口。":
    "Click “Fetch model list” to query the provider's model API.",
  默认模型: "Default model",
  模型能力: "Model capabilities",
  "只影响界面可用项，不改变请求格式":
    "Only changes available UI actions, not the request format",
  编辑能力: "Editing",
  变换能力: "Transform",
  多参考图: "Multiple references",
  "GIF 输出": "GIF output",
  "GIF 帧数上限": "GIF frame cap",
  "{{model}} GIF 帧数上限": "{{model}} GIF frame cap",
  最大边长: "Max side length",
  "{{model}} 最大边长": "{{model}} max side length",
  "共获取 {{n}} 个模型，保存后可在生成页直接使用。":
    "{{n}} models found — ready to use once saved.",
  "服务商已保存，但模型能力保存失败：{{error}}":
    "Provider saved, but model capabilities failed to save: {{error}}",

  // ProviderCard
  "连接正常 · {{ms}}ms · {{n}} 个模型": "Connected · {{ms}}ms · {{n}} models",
  "连接正常 · {{ms}}ms": "Connected · {{ms}}ms",
  "连接失败：{{error}}": "Connection failed: {{error}}",
  "测试中…": "Testing…",
  默认: "Default",
  "（无地址）": "(No URL)",
  "{{n}} 个 Key": "{{n}} keys",
  "· 默认: {{model}}": "· Default: {{model}}",
  "Key 失效：请重新填写": "Key invalid: please re-enter",
  "把 {{name}} 设为默认服务商": "Set {{name}} as default provider",
  "编辑服务商 {{name}}": "Edit provider {{name}}",
  "测试服务商 {{name}}": "Test provider {{name}}",
  "删除服务商 {{name}}": "Delete provider {{name}}",
  编辑: "Edit",
  测试: "Test",

  // ThinkingSection
  未知: "Unknown",
  "AI 助手": "AI assistant",
  "复用文本模型：思考扩写、会话标题与提示词优化":
    "Reuses text models for reasoning, chat titles and prompt refinement",
  接入方式: "Connection",
  复用绘图服务商: "Reuse image provider",
  独立配置: "Custom setup",
  "沿用绘图服务商的地址与 Key": "Uses the image provider's URL and key",
  思考模型服务商: "Thinking model provider",
  "如 gpt-4o-mini / deepseek-chat": "e.g. gpt-4o-mini / deepseek-chat",
  "如 gpt-4o-mini": "e.g. gpt-4o-mini",
  思考模型名称: "Thinking model name",
  "API 地址": "API base URL",
  "思考模型 API 地址": "Thinking model API URL",
  "已保存 {{key}}（留空则不变）": "Saved {{key}} (leave empty to keep)",
  "仅保存在本机，不明文回填":
    "Stored only on this device; never shown in plain text",
  "思考模型 API Key": "Thinking model API key",
  连接测试: "Connection test",
  测试连接: "Test connection",
  自动生成会话标题: "Auto-name chats",
  "首条消息后由 AI 命名，不打断出图":
    "AI names the chat after the first message without interrupting generation",
  "需先启用 AI 助手": "Requires the AI assistant",
  提示词优化助手: "Prompt refinement",
  在输入框的提示词助手里改写草稿:
    "Rewrites drafts in the composer's prompt assistant",
  失焦自动翻译: "Auto-translate on blur",
  "输入框失焦 0.6 秒后把中文提示词翻成英文，可撤销":
    "Translates Chinese prompts to English 0.6 s after the composer loses focus; undoable",

  // NetworkSection
  "直连（不使用代理）": "Direct (no proxy)",
  手动代理: "Manual proxy",
  "读取代理设置失败：{{error}}": "Couldn't read proxy settings: {{error}}",
  已保存并生效: "Saved and applied",
  "请先在「服务商管理」中添加服务商，再测试代理":
    "Add a provider in Provider management before testing the proxy",
  "正在测试…": "Testing…",
  "代理链路可达（{{ms}}ms，HTTP {{status}}）":
    "Proxy reachable ({{ms}}ms, HTTP {{status}})",
  "测试失败：{{error}}": "Test failed: {{error}}",
  网络与代理: "Network & proxy",
  下载模型与生成图片都会走这里的设置:
    "Model downloads and image generation both use these settings",
  代理模式: "Proxy mode",
  代理地址: "Proxy URL",
  "支持 http / https / socks5 / socks5h；应用内更新不支持 socks5":
    "Supports http / https / socks5 / socks5h; in-app updates don't support socks5",
  "http://127.0.0.1:7890 或 socks5://127.0.0.1:1080":
    "http://127.0.0.1:7890 or socks5://127.0.0.1:1080",
  用户名: "Username",
  可选: "Optional",
  代理用户名: "Proxy username",
  密码: "Password",
  "已保存，留空不修改": "Saved; leave empty to keep",
  代理密码: "Proxy password",
  跳过代理: "Bypass proxy",
  逗号分隔的主机名不经过代理: "Comma-separated hosts that skip the proxy",
  跳过代理的主机: "Hosts to bypass",
  无数据超时: "Idle timeout",
  "连续 {{idle}} 秒收不到新数据才判定失败（{{min}}–{{max}} 秒）":
    "Fails only after {{idle}} seconds without new data ({{min}}–{{max}} s)",
  响应体无数据超时: "Response body idle timeout",
  响应体总超时: "Response body total timeout",
  "整段响应体下载的最长耗时，不能小于无数据超时（{{min}}–{{max}} 秒）":
    "Max time to download the whole response body; must not be less than the idle timeout ({{min}}–{{max}} s)",
  秒: "s",
  应用设置: "Apply settings",
  "目前只支持 HTTP/HTTPS 代理": "Only HTTP/HTTPS proxies are supported",
  测试代理: "Test proxy",

  // StorageSection
  "{{n}} 天": "{{n}} days",
  "{{n}} 个 · {{size}}": "{{n}} files · {{size}}",
  "选择媒体目录（图片与参考图）": "Choose media folder (images and references)",
  "打开目录选择器失败：{{error}}": "Couldn't open the folder picker: {{error}}",
  "已迁移 {{n}} 个文件（{{size}}）": "Migrated {{n}} files ({{size}})",
  "更改位置失败：{{error}}": "Couldn't change location: {{error}}",
  "缓存保留期已设为 {{n}} 天": "Cache retention set to {{n}} days",
  "保存缓存保留期失败：{{error}}": "Couldn't save cache retention: {{error}}",
  "已清理：图片 {{images}}、参考图 {{refs}}、过期缓存 {{pruned}}":
    "Cleaned up: {{images}} images, {{refs}} references, {{pruned}} expired cache items",
  没有可清理的缓存: "Nothing to clean up",
  "清理缓存失败：{{error}}": "Couldn't clean cache: {{error}}",
  图片: "Images",
  缩略图: "Thumbnails",
  回收站: "Trash",
  数据库: "Database",
  存储与缓存: "Storage & cache",
  "图片与参考图可以放到其它磁盘；数据库与日志始终留在应用数据目录。删除或移动图片前会先进入各自的 .trash，保留期到期后才清理。":
    "Images and references can live on another disk; the database and logs always stay in the app data folder. Deleted or moved media first goes to its own .trash and is removed after the retention period.",
  刷新占用: "Refresh usage",
  媒体目录: "Media folder",
  "画廊图片、聊天附件、队列与预设参考图":
    "Gallery images, chat attachments, queue and preset references",
  "读取中…": "Reading…",
  "更改位置…": "Change location…",
  数据库与日志: "Database & logs",
  "固定位置，不随媒体目录迁移":
    "Fixed location; not moved with the media folder",
  缓存保留期: "Cache retention",
  "回收站中的文件超过该天数后，在下次启动或手动清理时删除":
    "Files kept in trash longer than this are deleted on the next launch or manual cleanup",
  立即清理缓存: "Clean cache now",
  更改媒体目录: "Change media folder",
  "将把图片与参考图复制到：": "Images and references will be copied to:",
  "迁移成功后更新数据库中的路径并删除旧目录中的媒体文件；数据库与日志位置不变。队列有任务运行时会拒绝执行。":
    "After migration the database paths are updated and media in the old folder is deleted. Database and log locations stay the same. Migration is refused while queue jobs are running.",
  开始迁移: "Start migration",

  // AboutSection
  "下载失败：{{error}}": "Download failed: {{error}}",
  关于与更新: "About & updates",
  当前版本: "Current version",
  检查更新: "Check for updates",
  "安装 {{version}}": "Install {{version}}",
  查看下载进度: "View download progress",
  查看更新: "View update",
  "新版本 {{version}}": "New version {{version}}",
  该版本未提供更新说明: "No release notes for this version",
} as const;

export default settingsSections;
