import { vi } from "vitest";

export interface CloseRequestedEvent {
  preventDefault: () => void;
}

type CloseHandler = (event: CloseRequestedEvent) => void | Promise<void>;

/** 已注册的关闭请求处理器（测试里用 triggerCloseRequest 触发）。 */
export const closeHandlers: CloseHandler[] = [];

export const destroy = vi.fn(async (): Promise<void> => undefined);

export const onCloseRequested = vi.fn(
  async (handler: CloseHandler): Promise<() => void> => {
    closeHandlers.push(handler);
    return () => {
      const index = closeHandlers.indexOf(handler);
      if (index >= 0) closeHandlers.splice(index, 1);
    };
  },
);

export const getCurrentWindow = vi.fn(() => ({
  destroy,
  onCloseRequested,
}));

/** 模拟用户点关闭：返回每个处理器收到的 preventDefault 记录。 */
export async function triggerCloseRequest(): Promise<boolean[]> {
  const prevented: boolean[] = [];
  for (const handler of [...closeHandlers]) {
    let preventedThis = false;
    await handler({
      preventDefault: () => {
        preventedThis = true;
      },
    });
    prevented.push(preventedThis);
  }
  return prevented;
}

export function resetWindowStub(): void {
  closeHandlers.length = 0;
  destroy.mockClear();
  onCloseRequested.mockClear();
  getCurrentWindow.mockClear();
}
