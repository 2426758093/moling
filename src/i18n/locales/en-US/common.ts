/// 通用词条：按钮、状态、确认框、无障碍标签。
/// key 是中文原文，value 是英文译文；缺失的 key 在英文下会回退中文。
/// 注意：key 一律加引号，中文标点不是合法的裸标识符。
const common = {
  取消: "Cancel",
  确认: "Confirm",
  保存: "Save",
  删除: "Delete",
  关闭: "Close",
  复制: "Copy",
  复制失败: "Copy failed",
  重试: "Retry",
  确定: "OK",
  加载中: "Loading",
  未知错误: "Unknown error",
  "保存失败：{{error}}": "Save failed: {{error}}",
  请选择: "Select…",
} as const;

export default common;
