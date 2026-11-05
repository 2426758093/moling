import { useMemo } from "react";
import { useReducedMotion, type Transition } from "framer-motion";
import { DUR, EASE, SPRING, type SpringPreset } from "./motion";

const STILL: Transition = { duration: 0 };

/// 统一的动效入口：组件不再各自判断 reduce，只声明"我要哪一档"。
///
/// - `spring("press")` 形变（按压、弹层入场、layout、侧栏宽度）
/// - `fade(DUR.base)` 颜色与透明度
///
/// 减少动态时两者都退化成 duration 0（不是 0.01s —— framer-motion 的
/// duration 0 会直接跳到终态，不产生一帧中间值）。
export function useMotionTokens() {
  const reduce = useReducedMotion() ?? false;

  return useMemo(
    () => ({
      reduce,
      spring: (preset: SpringPreset): Transition =>
        reduce ? STILL : { type: "spring", ...SPRING[preset] },
      fade: (duration: number = DUR.base): Transition =>
        reduce ? STILL : { duration, ease: EASE.ios },
    }),
    [reduce],
  );
}
