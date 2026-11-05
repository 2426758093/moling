// @ts-expect-error type error without @types/node package
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/** Tauri 运行时模块在 node/jsdom 下不存在，统一指向 src/test/stubs 下的假实现。 */
const stub = (name: string) =>
  fileURLToPath(new URL(`./src/test/stubs/${name}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@tauri-apps\/api\/core$/, replacement: stub("tauri-core.ts") },
      {
        find: /^@tauri-apps\/api\/event$/,
        replacement: stub("tauri-event.ts"),
      },
      {
        find: /^@tauri-apps\/api\/window$/,
        replacement: stub("tauri-window.ts"),
      },
      {
        find: /^@tauri-apps\/plugin-dialog$/,
        replacement: stub("tauri-dialog.ts"),
      },
      {
        find: /^@tauri-apps\/plugin-opener$/,
        replacement: stub("tauri-opener.ts"),
      },
    ],
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
    restoreMocks: true,
    clearMocks: true,
  },
});
