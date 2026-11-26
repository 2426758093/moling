import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ProviderDialog from "./index";

describe("ProviderDialog 服务商配置向导", () => {
  it("默认停在基本信息步骤并展示关键字段", () => {
    render(<ProviderDialog initial={null} onClose={vi.fn()} />);

    expect(screen.getByText("新增服务商")).toBeTruthy();
    expect(screen.getByText(/基本信息/)).toBeTruthy();
    expect(screen.getByLabelText("名称")).toBeTruthy();
    expect(screen.getByLabelText("API 地址（Base URL）")).toBeTruthy();
    expect(screen.getByLabelText("API Key")).toBeTruthy();
  });

  it("取消按钮只关闭弹窗，不触发保存", () => {
    const onClose = vi.fn();
    render(<ProviderDialog initial={null} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
  });
});
