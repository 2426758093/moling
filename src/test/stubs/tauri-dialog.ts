import { vi } from "vitest";

/** @tauri-apps/plugin-dialog 的测试替身。 */
export const open = vi.fn();
export const save = vi.fn();
