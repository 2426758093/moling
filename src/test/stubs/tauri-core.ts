import { vi } from "vitest";

/**
 * @tauri-apps/api/core 的测试替身。
 * api.ts 在模块初始化时取出 `invoke`，因此测试必须通过本模块的同一个引用控制行为：
 *   import { invoke } from "@tauri-apps/api/core";
 *   vi.mocked(invoke).mockResolvedValue(...)
 */
export const invoke = vi.fn();
