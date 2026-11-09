import { beforeEach, describe, expect, test, vi } from "vitest";

const getStylePresets = vi.hoisted(() => vi.fn());
const saveStylePresets = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());

vi.mock("../lib/api", () => ({
  api: { getStylePresets, saveStylePresets },
}));
vi.mock("../lib/notify", () => ({ toast }));

import { STYLE_PRESETS } from "../lib/presets";
import { useStylePresetStore } from "./stylePresetStore";

const custom = [
  { id: "c_1", label: "暖调胶片", prompt: "warm analog film, soft grain" },
];

beforeEach(() => {
  getStylePresets.mockReset();
  saveStylePresets.mockReset();
  toast.mockReset();
  useStylePresetStore.setState({
    builtin: STYLE_PRESETS,
    custom: [],
    loaded: false,
    loading: false,
  });
});

describe("stylePresetStore", () => {
  test("load 合并内置与自定义，内置为空时退回本地兜底", async () => {
    getStylePresets.mockResolvedValueOnce({ builtin: [], custom });
    await useStylePresetStore.getState().load();
    const s = useStylePresetStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.builtin).toBe(STYLE_PRESETS);
    expect(s.custom).toEqual(custom);
  });

  test("后端不可用时静默退回内置，不影响输入", async () => {
    getStylePresets.mockRejectedValueOnce(new Error("no backend"));
    await useStylePresetStore.getState().load();
    const s = useStylePresetStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.builtin).toBe(STYLE_PRESETS);
    expect(toast).not.toHaveBeenCalled();
  });

  test("addCustom 只保存自定义部分并追加本地列表", async () => {
    saveStylePresets.mockResolvedValueOnce(undefined);
    const ok = await useStylePresetStore
      .getState()
      .addCustom(" 暖调胶片 ", " warm analog film ");
    expect(ok).toBe(true);
    const s = useStylePresetStore.getState();
    expect(s.custom).toHaveLength(1);
    expect(s.custom[0]).toMatchObject({
      label: "暖调胶片",
      prompt: "warm analog film",
    });
    expect(saveStylePresets).toHaveBeenCalledWith(s.custom);
  });

  test("空名称或空提示词直接拒绝", async () => {
    expect(await useStylePresetStore.getState().addCustom("", "x")).toBe(false);
    expect(await useStylePresetStore.getState().addCustom("名", "  ")).toBe(
      false,
    );
    expect(saveStylePresets).not.toHaveBeenCalled();
  });

  test("removeCustom 失败时保留原列表", async () => {
    useStylePresetStore.setState({ custom });
    saveStylePresets.mockRejectedValueOnce(new Error("boom"));
    await useStylePresetStore.getState().removeCustom("c_1");
    expect(useStylePresetStore.getState().custom).toEqual(custom);
    expect(toast).toHaveBeenCalledWith(
      expect.stringContaining("删除风格失败"),
      "error",
    );
  });
});
