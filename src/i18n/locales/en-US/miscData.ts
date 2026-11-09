/// 非组件数据模块：时间线分组文案（presets / types 的标签沿用 chatComposer 分片：
/// 自动 / 低 / 中 / 高 / 构图参考 / 风格参考 / 人脸参考 / 元素参考）。
/// key 是中文原文，value 是英文译文；缺失的 key 在英文下会回退中文。
/// 注意：含中文标点或插值的 key 必须写成带引号的字符串。
const miscData = {
  // lib/date.ts · 画廊时间线分组
  今天: "Today",
  昨天: "Yesterday",
  "{{month}}月{{day}}日": "{{month}}/{{day}}",
  "{{year}}年{{month}}月{{day}}日": "{{month}}/{{day}}/{{year}}",

  // lib/bodyTimeouts.ts
  "{{label}}必须是整数": "{{label}} must be an integer",
  "{{label}}应在 {{min}}–{{max}} 秒之间":
    "{{label}} must be between {{min}}–{{max}} seconds",
  响应体总超时不能小于无数据超时:
    "Total timeout cannot be shorter than the idle timeout",
} as const;

export default miscData;
