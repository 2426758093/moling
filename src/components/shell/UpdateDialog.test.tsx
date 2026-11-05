import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import UpdateDialog from "./UpdateDialog";
import { api } from "../../lib/api";
import { useUpdateStore } from "../../stores/updateStore";

const release = {
  version: "1.2.0",
  notes: "修复若干问题",
  date: "2026-11-05T00:00:00Z",
};

beforeEach(() => {
  useUpdateStore.getState().unsubscribe();
  useUpdateStore.setState({
    phase: "idle",
    currentVersion: "1.1.0",
    info: null,
    progress: null,
    error: "",
    notice: "",
    dialogOpen: false,
    checked: true,
  });
});

describe("更新弹窗", () => {
  it("展示版本与更新内容，点击下载后进入待安装", async () => {
    useUpdateStore.setState({
      phase: "available",
      dialogOpen: true,
      info: release,
    });
    vi.spyOn(api, "downloadUpdate").mockResolvedValue(undefined);
    render(<UpdateDialog />);

    expect(screen.getByText("发现新版本")).toBeTruthy();
    expect(screen.getByText("修复若干问题")).toBeTruthy();

    fireEvent.click(screen.getByText("下载更新"));
    await waitFor(() =>
      expect(useUpdateStore.getState().phase).toBe("downloaded"),
    );
    expect(screen.getByText("立即安装并重启")).toBeTruthy();
  });

  it("下载中显示进度与线路，关闭弹窗不打断下载", () => {
    useUpdateStore.setState({
      phase: "downloading",
      dialogOpen: true,
      info: release,
      progress: {
        downloaded: 512,
        total: 1024,
        speed: 256,
        route: "系统网络",
      },
    });
    render(<UpdateDialog />);

    expect(screen.getByText(/50%/)).toBeTruthy();
    expect(screen.getByText(/系统网络/)).toBeTruthy();

    fireEvent.click(screen.getByText("后台下载"));
    expect(useUpdateStore.getState().dialogOpen).toBe(false);
    expect(useUpdateStore.getState().phase).toBe("downloading");
  });

  it("安装失败时展示错误与重试入口", () => {
    useUpdateStore.setState({
      phase: "error",
      dialogOpen: true,
      error: "签名校验失败",
    });
    render(<UpdateDialog />);

    expect(screen.getByText("更新失败")).toBeTruthy();
    expect(screen.getByText("签名校验失败")).toBeTruthy();
    expect(screen.getByText("重试下载")).toBeTruthy();
  });
});
