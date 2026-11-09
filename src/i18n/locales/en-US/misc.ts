/// 非组件模块（store / lib）里的用户可见提示。
/// key 是中文原文，value 是英文译文；含中文标点或插值的 key 必须写成带引号的字符串。
const misc = {
  // appStore · 偏好保存失败
  "保存主题失败：{{error}}": "Couldn't save theme: {{error}}",
  "保存玻璃质感失败：{{error}}": "Couldn't save glass appearance: {{error}}",
  "保存界面模式失败：{{error}}": "Couldn't save interface mode: {{error}}",
  "保存语言设置失败：{{error}}": "Failed to save language: {{error}}",

  // chatStore · 会话与消息
  "请先在「设置」中配置绘图服务商与模型":
    "Configure an image provider and model in Settings first",
  "最多添加 {{n}} 张参考图": "You can add up to {{n}} reference images",
  "服务商仅返回 {{done}} 张（请求 {{total}} 张）":
    "Provider returned only {{done}} of {{total}} images",
  "新建会话失败：{{error}}": "Couldn't create chat: {{error}}",
  "创建会话失败：{{error}}": "Couldn't create conversation: {{error}}",
  "加载消息失败：{{error}}": "Couldn't load messages: {{error}}",
  "加载更早消息失败：{{error}}": "Couldn't load earlier messages: {{error}}",
  "参考图保存失败，已中止发送：{{error}}":
    "Couldn't save reference images, so sending was canceled: {{error}}",
  "发送失败：{{error}}": "Send failed: {{error}}",
  "保存图片消息失败：{{error}}": "Couldn't save image message: {{error}}",
  仅能重试最新一轮对话: "Only the latest exchange can be retried",
  仅能重试最新一条回复: "Only the latest reply can be retried",
  "会话不存在或已被删除，无法重试":
    "This conversation no longer exists, so it can't be retried",
  "参考图无法恢复，将仅用文本重试":
    "Reference images couldn't be restored; retrying with text only",
  "重试失败：{{error}}": "Retry failed: {{error}}",
  "重试失败：无法清理上一条回复（{{error}}）":
    "Retry failed: couldn't remove the previous reply ({{error}})",

  // canvasStore · 画布列表与保存
  "加载画布列表失败：{{error}}": "Couldn't load canvas list: {{error}}",
  画布名称不能为空: "Canvas name can't be empty",
  "新建画布失败：{{error}}": "Couldn't create canvas: {{error}}",
  "打开画布失败：{{error}}": "Couldn't open canvas: {{error}}",
  "删除画布失败：{{error}}": "Couldn't delete canvas: {{error}}",
  "画布保存失败：{{error}}": "Couldn't save canvas: {{error}}",

  // queueStore · 队列操作反馈
  队列已开始: "Queue started",
  "已恢复 {{n}} 个中断任务": "Resumed {{n}} interrupted jobs",
  没有需要恢复的中断任务: "No interrupted jobs to resume",
  "并发数已设为 {{n}}": "Concurrency set to {{n}}",
  "每服务商并发已设为 {{n}}": "Per-provider concurrency set to {{n}}",
  "已清空 {{n}} 条已结束任务": "Cleared {{n}} finished jobs",

  // updateStore · 更新检查提示
  当前已是最新版本: "You're on the latest version",
  "当前版本未接入更新源，无法检查更新":
    "This build has no update source, so updates can't be checked",
  "检查更新失败：{{error}}": "Couldn't check for updates: {{error}}",

  // promptAssetsStore · 收藏与预设
  "加载提示词资产失败，请稍后重试":
    "Failed to load prompt assets. Please try again later.",
  "收藏失败：{{error}}": "Failed to save favorite: {{error}}",
  "删除收藏失败：{{error}}": "Failed to delete favorite: {{error}}",
  "保存预设失败：{{error}}": "Failed to save preset: {{error}}",
  "删除预设失败：{{error}}": "Failed to delete preset: {{error}}",
  "已应用预设，{{n}} 张参考图不可用被跳过":
    "Preset applied; {{n}} reference images were unavailable and skipped",

  // stylePresetStore · 自定义风格
  "自定义风格最多 50 个": "Up to 50 custom styles",
  "保存风格失败：{{error}}": "Couldn't save style: {{error}}",
  "删除风格失败：{{error}}": "Couldn't delete style: {{error}}",
} as const;

export default misc;
