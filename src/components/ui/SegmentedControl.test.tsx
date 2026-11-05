import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "./SegmentedControl";

const OPTIONS = [
  { value: "light" as const, label: "浅色" },
  { value: "dark" as const, label: "暗色" },
];

describe("SegmentedControl", () => {
  it("用 aria-label 暴露当前选中项", () => {
    render(
      <SegmentedControl
        value="dark"
        onValueChange={() => undefined}
        options={OPTIONS}
        label="主题"
      />,
    );
    expect(screen.getByRole("radiogroup", { name: "主题" })).toBeTruthy();
    expect(
      screen.getByRole("radio", { name: "暗色" }).getAttribute("data-state"),
    ).toBe("on");
    expect(
      screen.getByRole("radio", { name: "浅色" }).getAttribute("data-state"),
    ).toBe("off");
  });

  it("点击其它分段回传对应值", () => {
    const onValueChange = vi.fn();
    render(
      <SegmentedControl
        value="light"
        onValueChange={onValueChange}
        options={OPTIONS}
        label="主题"
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "暗色" }));
    expect(onValueChange).toHaveBeenCalledWith("dark");
  });

  it("再次点击当前分段不会清空选中", () => {
    const onValueChange = vi.fn();
    render(
      <SegmentedControl
        value="light"
        onValueChange={onValueChange}
        options={OPTIONS}
        label="主题"
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "浅色" }));
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
