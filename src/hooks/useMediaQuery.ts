import { useSyncExternalStore } from "react";

/// 断点驱动布局：与 index.css 的 --breakpoint-compact(1100px) / --breakpoint-wide(1500px)
/// 保持一致。用 CSS 断点时优先写类（`compact:hidden`）；只有当布局需要"不渲染"
/// 而不是"不显示"时才用这个 Hook。
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export const useCompact = () => useMediaQuery("(max-width: 1099px)");
