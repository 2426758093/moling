import { RefObject, useEffect } from "react";

/// 滚动边缘：内容滚动时在容器上下边缘做渐隐（mask-image，不是背景渐变）。
///
/// 这样栏头不需要常驻一条 1px 分割线 —— 内容从栏头下方滚过，由栏头玻璃把它
/// 压下去。两个 CSS 变量由 .scroll-edge 消费，滚动位置为 0 时遮罩宽度归零。
export function useScrollEdge(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => {
      const top = el.scrollTop;
      const bottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      el.style.setProperty("--edge-top", top > 2 ? "12px" : "0px");
      el.style.setProperty("--edge-bottom", bottom > 2 ? "12px" : "0px");
    };

    update();
    el.addEventListener("scroll", update, { passive: true });
    // 内容高度变化（流式文字、图片加载）也要重算，否则底边遮罩会残留
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [ref]);
}
