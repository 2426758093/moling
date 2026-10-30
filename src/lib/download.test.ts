import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REVOKE_DELAY_MS, downloadBlob, downloadUrl } from "./file";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-url");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
    () => undefined,
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("下载对象 URL 的生命周期（F-018）", () => {
  it("downloadBlob 延迟 revoke，anchor 挂载后移除", () => {
    const append = vi.spyOn(document.body, "appendChild");

    downloadBlob(new Blob(["{}"], { type: "application/json" }), "backup.json");

    expect(vi.mocked(URL.createObjectURL)).toHaveBeenCalledTimes(1);
    const anchor = append.mock.calls[0][0] as HTMLAnchorElement;
    expect(anchor.download).toBe("backup.json");
    expect(anchor.getAttribute("href")).toBe("blob:mock-url");
    expect(vi.mocked(HTMLAnchorElement.prototype.click)).toHaveBeenCalledTimes(
      1,
    );
    expect(anchor.isConnected).toBe(false);
    expect(vi.mocked(URL.revokeObjectURL)).not.toHaveBeenCalled();

    vi.advanceTimersByTime(REVOKE_DELAY_MS);
    expect(vi.mocked(URL.revokeObjectURL)).toHaveBeenCalledWith(
      "blob:mock-url",
    );
  });

  it("downloadUrl 直接释放传入的对象 URL", () => {
    downloadUrl("blob:direct", "image.png");

    expect(vi.mocked(URL.revokeObjectURL)).not.toHaveBeenCalled();
    vi.advanceTimersByTime(REVOKE_DELAY_MS);
    expect(vi.mocked(URL.revokeObjectURL)).toHaveBeenCalledWith("blob:direct");
    expect(vi.mocked(HTMLAnchorElement.prototype.click)).toHaveBeenCalledTimes(
      1,
    );
  });
});
