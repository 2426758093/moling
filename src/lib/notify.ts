// 全局轻提示：供组件与 store（非 React 环境）共用。
// 直接向 body 注入 fixed 容器，避免为了一个提示条把 30+ 调用点改成 React 组件。

let host: HTMLDivElement | null = null;

function ensureHost(): HTMLDivElement {
  if (host && document.body.contains(host)) return host;
  host = document.createElement("div");
  host.className =
    "pointer-events-none fixed left-1/2 top-4 z-[60] flex -translate-x-1/2 flex-col items-center gap-2";
  document.body.appendChild(host);
  return host;
}

const INFO_CLASS =
  "glass anim-pop pointer-events-auto rounded-pop border border-line px-4 py-2 text-subhead text-secondary shadow-sheet";
const ERROR_CLASS =
  "glass anim-pop pointer-events-auto rounded-pop border border-danger/30 px-4 py-2 text-subhead text-danger shadow-sheet";

export function toast(message: string, kind: "info" | "error" = "info") {
  const box = ensureHost();
  const el = document.createElement("div");
  el.textContent = message;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
  el.className = kind === "error" ? ERROR_CLASS : INFO_CLASS;
  box.appendChild(el);

  let timer = window.setTimeout(dismiss, 2500);
  function dismiss() {
    window.clearTimeout(timer);
    el.style.transition = "opacity 0.15s";
    el.style.opacity = "0";
    timer = window.setTimeout(() => el.remove(), 200);
  }
  // 悬停时暂停自动消失，读得完再走
  el.addEventListener("mouseenter", () => window.clearTimeout(timer));
  el.addEventListener("mouseleave", () => {
    timer = window.setTimeout(dismiss, 1200);
  });
}
