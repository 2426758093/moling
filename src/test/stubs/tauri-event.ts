import { vi } from "vitest";

type EventHandler = (event: { payload: unknown }) => void;

const listeners = new Map<string, Set<EventHandler>>();

/** @tauri-apps/api/event 的测试替身：记录监听、支持手工回放事件。 */
export const listen = vi.fn(
  async (event: string, handler: EventHandler): Promise<() => void> => {
    const set = listeners.get(event) ?? new Set<EventHandler>();
    set.add(handler);
    listeners.set(event, set);
    return () => {
      set.delete(handler);
    };
  },
);

/** 向指定事件的所有在册监听器推送一条 payload。 */
export function emitTauriEvent(event: string, payload: unknown): void {
  for (const handler of listeners.get(event) ?? []) handler({ payload });
}

/** 清空所有监听（用于 beforeEach）。 */
export function resetTauriEvents(): void {
  listeners.clear();
  listen.mockClear();
}
