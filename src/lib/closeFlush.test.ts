import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  destroy,
  resetWindowStub,
  triggerCloseRequest,
} from "../test/stubs/tauri-window";
import { installCloseFlush } from "./closeFlush";

beforeEach(() => {
  resetWindowStub();
  vi.mocked(destroy).mockImplementation(async () => undefined);
});

describe("installCloseFlush（F-010）", () => {
  it("关闭请求先 flush 再 destroy，并阻止默认关闭", async () => {
    const order: string[] = [];
    vi.mocked(destroy).mockImplementation(async () => {
      order.push("destroy");
    });
    const off = await installCloseFlush({
      flush: async () => {
        order.push("flush");
      },
    });

    const prevented = await triggerCloseRequest();

    expect(prevented).toEqual([true]);
    expect(order).toEqual(["flush", "destroy"]);
    off();
  });

  it("flush 失败时仍然 destroy（不能把窗口关不掉）", async () => {
    const off = await installCloseFlush({
      flush: async () => {
        throw new Error("flush failed");
      },
    });

    await triggerCloseRequest();

    expect(destroy).toHaveBeenCalledTimes(1);
    off();
  });

  it("flush 超时后仍然 destroy", async () => {
    const off = await installCloseFlush({
      flush: () => new Promise<void>(() => undefined),
      timeoutMs: 10,
    });

    await triggerCloseRequest();

    expect(destroy).toHaveBeenCalledTimes(1);
    off();
  });

  it("并发关闭请求只 destroy 一次", async () => {
    const off = await installCloseFlush({});

    const [first, second] = await Promise.all([
      triggerCloseRequest(),
      triggerCloseRequest(),
    ]);

    expect(first).toEqual([true]);
    expect(second).toEqual([true]);
    expect(destroy).toHaveBeenCalledTimes(1);
    off();
  });

  it("卸载后不再接管关闭请求", async () => {
    const off = await installCloseFlush({});
    off();

    expect(await triggerCloseRequest()).toEqual([]);
    expect(destroy).not.toHaveBeenCalled();
  });
});
