import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// RTL 的自动 cleanup 依赖全局 afterEach；本项目不开 vitest globals，故显式注册。
afterEach(() => {
  cleanup();
});

// jsdom 没有 matchMedia：主题/系统深色判定与 App 挂载都依赖它。
if (typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  });
}

// jsdom 未实现 object URL：下载与缩略图相关代码会调用。
if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = () => "blob:moling-test";
}
if (typeof URL.revokeObjectURL !== "function") {
  URL.revokeObjectURL = () => undefined;
}

// 虚拟列表 / 自动撑高输入框会用到 ResizeObserver。
if (typeof globalThis.ResizeObserver !== "function") {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;
}

// jsdom 的滚动 API 只声明不实现，调用会抛错。
if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = () => undefined;
}
if (typeof Element.prototype.scrollTo !== "function") {
  Element.prototype.scrollTo = () => undefined;
}

// 部分 jsdom 版本没有 crypto.randomUUID（store 用它生成 jobId/refineId）。
if (typeof globalThis.crypto?.randomUUID !== "function") {
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    value: () => "00000000-0000-4000-8000-000000000000",
  });
}

// 组件里偶有用 rAF 等下一帧布局；jsdom 的 pretendToBeVisual 可能关闭。
if (typeof globalThis.requestAnimationFrame !== "function") {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number;
  globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id);
}
