/// 动效常量：颜色与透明度走三档时长，形变走物理弹簧。
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

/// 弹簧档位：刚度越高越快，阻尼决定回弹。全站 ζ ≥ 0.85，收敛 ≤600ms。
///
/// 不要给这里加"更弹"的档位 —— 回弹超过 2% 在桌面上像玩具。
export const SPRING = {
  /// 按压：立即响应，几乎不回弹
  press: { stiffness: 520, damping: 30, mass: 0.6 },
  /// 弹层入场、列表 layout（scale .97→1）
  snappy: { stiffness: 420, damping: 32, mass: 0.8 },
  /// 展开折叠
  smooth: { stiffness: 260, damping: 28, mass: 0.9 },
  /// 侧栏宽度：慢、稳，不抢注意力
  gentle: { stiffness: 170, damping: 26, mass: 1.0 },
  /// 拖拽跟随：紧贴指针，过冲最小
  follow: { stiffness: 700, damping: 42, mass: 0.7 },
} as const;

export type SpringPreset = keyof typeof SPRING;

/// 页面级切换：轻微位移 + 淡入，不横向滑动整屏。
export const VIEW_TRANSITION = {
  duration: DUR.slow,
  ease: EASE.ios,
} as const;
