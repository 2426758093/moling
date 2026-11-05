import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitTauriEvent, resetTauriEvents } from "../test/stubs/tauri-event";
import { api, type UpdateStatus } from "../lib/api";
import { useUpdateStore } from "./updateStore";

const release = {
  version: "1.2.0",
  notes: "修复若干问题",
  date: "2026-11-05T00:00:00Z",
};

const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
  currentVersion: "1.1.0",
  configured: true,
  available: null,
  error: null,
  ...over,
});

function reset() {
  useUpdateStore.getState().unsubscribe();
  useUpdateStore.setState({
    phase: "idle",
    currentVersion: "",
    info: null,
    progress: null,
    error: "",
    notice: "",
    dialogOpen: false,
    checked: false,
  });
}

beforeEach(() => {
  resetTauriEvents();
  reset();
});

describe("启动检查", () => {
  it("发现新版本时展示弹窗与更新内容", async () => {
    vi.spyOn(api, "getUpdateStatus").mockResolvedValue(
      status({ available: release }),
    );
    await useUpdateStore.getState().subscribe();
    await useUpdateStore.getState().check(false);

    const s = useUpdateStore.getState();
    expect(s.phase).toBe("available");
    expect(s.info).toEqual(release);
    expect(s.dialogOpen).toBe(true);
    expect(s.notice).toBe("");
  });

  it("未配置更新源 / 已是最新 / 离线都保持静默", async () => {
    const cases = [
      status({ configured: false }),
      status(),
      status({ error: "network unreachable" }),
    ];
    const call = vi.spyOn(api, "getUpdateStatus");
    for (const result of cases) {
      reset();
      call.mockResolvedValueOnce(result);
      await useUpdateStore.getState().check(false);
      const s = useUpdateStore.getState();
      expect(s.dialogOpen).toBe(false);
      expect(s.notice).toBe("");
      expect(s.checked).toBe(true);
    }
  });

  it("手动检查给出结果提示", async () => {
    vi.spyOn(api, "getUpdateStatus").mockResolvedValue(status());
    await useUpdateStore.getState().check(true);
    expect(useUpdateStore.getState().notice).toBe("当前已是最新版本");

    vi.spyOn(api, "getUpdateStatus").mockResolvedValue(
      status({ available: release }),
    );
    await useUpdateStore.getState().check(true);
    expect(useUpdateStore.getState().dialogOpen).toBe(true);
  });
});

describe("下载与安装", () => {
  it("进度事件更新下载状态，完成后切到待安装并重新打开弹窗", async () => {
    vi.spyOn(api, "getUpdateStatus").mockResolvedValue(
      status({ available: release }),
    );
    let finish!: () => void;
    vi.spyOn(api, "downloadUpdate").mockImplementation(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    await useUpdateStore.getState().subscribe();
    await useUpdateStore.getState().check(false);

    const pending = useUpdateStore.getState().download();
    expect(useUpdateStore.getState().phase).toBe("downloading");

    emitTauriEvent("update:progress", {
      downloaded: 512,
      total: 1024,
      speed: 256,
      route: "系统网络",
    });
    expect(useUpdateStore.getState().progress).toMatchObject({
      downloaded: 512,
      total: 1024,
      route: "系统网络",
    });

    // 用户在下载中关掉弹窗，完成事件仍要把弹窗拉回来
    useUpdateStore.getState().closeDialog();
    emitTauriEvent("update:downloaded", {});
    expect(useUpdateStore.getState().phase).toBe("downloaded");
    expect(useUpdateStore.getState().dialogOpen).toBe(true);
    expect(useUpdateStore.getState().progress?.downloaded).toBe(1024);

    finish();
    await pending;
    expect(useUpdateStore.getState().phase).toBe("downloaded");
  });

  it("下载失败进入错误态，可再次下载", async () => {
    vi.spyOn(api, "downloadUpdate").mockRejectedValueOnce("网络中断");
    await useUpdateStore.getState().download();
    expect(useUpdateStore.getState().phase).toBe("error");
    expect(useUpdateStore.getState().error).toBe("网络中断");

    vi.spyOn(api, "downloadUpdate").mockResolvedValueOnce(undefined);
    await useUpdateStore.getState().download();
    expect(useUpdateStore.getState().phase).toBe("downloaded");
  });

  it("安装失败保留错误信息", async () => {
    vi.spyOn(api, "installUpdate").mockRejectedValueOnce("签名校验失败");
    await useUpdateStore.getState().install();
    expect(useUpdateStore.getState().phase).toBe("error");
    expect(useUpdateStore.getState().error).toBe("签名校验失败");
  });
});
