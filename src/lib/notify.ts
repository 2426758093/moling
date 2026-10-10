// 全局轻提示：供组件与 store（非 React 环境）共用。
// 实现为向 body 注入 fixed 定位条，样式对齐现有内联错误条（border-danger/30 bg-danger/10），自动消失。

let host: HTMLDivElement | null = null;

function ensureHost(): HTMLDivElement {
  if (host && document.body.contains(host)) return host;
  host = document.createElement("div");
  host.className =
    "pointer-events-none fixed left-1/2 top-4 z-[100] flex -translate-x-1/2 flex-col items-center gap-2";
  document.body.appendChild(host);
  return host;
}

export function toast(message: string, kind: "info" | "error" = "info") {
  const box = ensureHost();
  const el = document.createElement("div");
  el.textContent = message;
  el.className =
    kind === "error"
      ? "rounded-lg border border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger shadow-card"
      : "bg-glass rounded-lg border border-theme px-4 py-2 text-xs text-secondary shadow-card";
  box.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity 0.25s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 300);
  }, 2500);
}
