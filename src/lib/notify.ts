// 全局轻提示：供组件与 store（非 React 环境）共用。
// 直接向 body 注入 fixed 容器，避免为了一个提示条把 30+ 调用点改成 React 组件。
//
// 规则：底部居中、同时最多 3 条、同文案去重（重触发只重置计时，不叠一摞）。

let host: HTMLDivElement | null = null;
const live = new Map<string, { el: HTMLDivElement; dismiss: () => void }>();

const MAX_VISIBLE = 3;
const LINGER_MS = 2600;

function ensureHost(): HTMLDivElement {
  if (host && document.body.contains(host)) return host;
  host = document.createElement("div");
  host.className =
    "pointer-events-none fixed bottom-6 left-1/2 z-[70] flex -translate-x-1/2 flex-col items-center gap-2";
  document.body.appendChild(host);
  return host;
}

const BASE =
  "anim-pop pointer-events-auto max-w-reading rounded-pop glass px-3.5 py-2 text-callout shadow-sheet";

export function toast(message: string, kind: "info" | "error" = "info") {
  const box = ensureHost();
  const key = `${kind}:${message}`;

  const existing = live.get(key);
  if (existing) {
    existing.dismiss();
    live.delete(key);
  }

  const el = document.createElement("div");
  el.textContent = message;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
  el.className =
    kind === "error"
      ? `${BASE} text-danger ring-1 ring-danger/30`
      : `${BASE} text-secondary`;
  box.appendChild(el);

  while (box.children.length > MAX_VISIBLE) {
    box.firstElementChild?.remove();
  }

  let hideTimer = 0;
  const dismiss = () => {
    window.clearTimeout(hideTimer);
    live.delete(key);
    el.style.opacity = "0";
    window.setTimeout(() => el.remove(), 160);
  };
  const schedule = (ms: number) => {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(dismiss, ms);
  };

  live.set(key, { el, dismiss });
  schedule(LINGER_MS);
  // 悬停时暂停自动消失，读得完再走
  el.addEventListener("mouseenter", () => window.clearTimeout(hideTimer));
  el.addEventListener("mouseleave", () => schedule(1200));
}
