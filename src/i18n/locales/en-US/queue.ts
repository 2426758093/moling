/// 队列：状态、筛选、并发设置、任务行与空态。
/// key 是中文原文，value 是英文译文；缺失的 key 在英文下会回退中文。
/// 注意：含中文标点或插值的 key 必须写成带引号的字符串。
const queue = {
  // QueueView · 页头与并发
  队列: "Queue",
  "生成任务按顺序执行，可随时暂停或重试":
    "Jobs run in order — pause or retry anytime",
  并发: "Concurrency",
  队列并发数: "Queue concurrency",
  每服务商: "Per provider",
  每服务商并发数: "Per-provider concurrency",
  "{{n}} 个任务": "{{n}} jobs",
  "恢复中断 {{n}}": "Resume {{n}} interrupted",
  开始队列: "Start queue",
  清空已完成: "Clear finished",
  "队列已暂停：启动应用后不会自动执行，避免重启即产生费用。点击右上角「开始队列」继续。":
    "Queue paused: jobs don't start automatically, so relaunching costs nothing. Click “Start queue” in the top right to continue.",
  没有符合条件的任务: "No jobs match this filter",
  队列还是空的: "Queue is empty",
  "在聊天页输入提示词后点「加入队列」，可附带参考图并按需调整并发数。":
    "Type a prompt in chat and click “Add to queue”. You can attach reference images and adjust concurrency.",
  去聊天页: "Go to chat",
  "加载中…": "Loading…",

  // 状态与筛选标签
  排队中: "Queued",
  生成中: "Running",
  已完成: "Done",
  失败: "Failed",
  已取消: "Canceled",
  已中断: "Interrupted",
  全部: "All",
  待处理: "Pending",
  异常: "Issues",

  // JobRow
  "任务 #{{id}} 详情": "Job #{{id}} details",
  "{{n}} 张": "{{n}} images",
  "限流 {{n}}s": "Rate limited {{n}}s",
  取消任务: "Cancel job",
  重试任务: "Retry job",
  "参考图 {{n}}": "Reference image {{n}}",
  提示词已复制: "Prompt copied",
  复制提示词: "Copy prompt",
  复制错误: "Copy error",
  错误详情已复制: "Error details copied",
  复制失败: "Copy failed",
  "已落盘 {{done}} / {{total}} 张": "Saved {{done}} / {{total}} images",
  "正在请求图片…": "Requesting images…",

  // 失败提示
  "加载队列失败：{{error}}": "Couldn't load queue: {{error}}",
  "取消失败：{{error}}": "Cancel failed: {{error}}",
  "重试失败：{{error}}": "Retry failed: {{error}}",
  "并发设置失败：{{error}}": "Couldn't update concurrency: {{error}}",
  "恢复失败：{{error}}": "Resume failed: {{error}}",
  "启动失败：{{error}}": "Couldn't start queue: {{error}}",
  "清空失败：{{error}}": "Couldn't clear finished jobs: {{error}}",
} as const;

export default queue;
