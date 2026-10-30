/// 动效常量：全站只允许这三档时长与两条缓动。
///
/// 与 index.css 的 --ease-ios / --ease-exit 保持一致 —— CSS 与 JS 各写一份是
/// 不可避免的（framer-motion 不读 CSS 变量做插值），但数值必须同源，改一处就
/// 同步另一处，否则同一次状态变化里 CSS 过渡与 JS 动画会走出两种手感。
export const DUR = {
  /// 按压、微反馈
  quick: 0.15,
  /// 默认过渡
  base: 0.2,
  /// 视图切换、侧栏折叠
  slow: 0.3,
} as const;

export const EASE = {
  /// 进入与移动
  ios: [0.32, 0.72, 0, 1],
  /// 退场
  exit: [0.4, 0, 1, 1],
} satisfies Record<string, [number, number, number, number]>;

/// 页面级切换：轻微位移 + 淡入，不横向滑动整屏。
export const VIEW_TRANSITION = {
  duration: DUR.slow,
  ease: EASE.ios,
} as const;
