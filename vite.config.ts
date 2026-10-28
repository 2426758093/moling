import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],

  // 构建产物按依赖域分包：主包只留业务代码，避免单 chunk 超过 500 kB 告警。
  // 注意 Vite 8 的 rolldown 后端只接受函数形式的 manualChunks（对象形式会在
  // 输出阶段报 "Expected Function but received Object" 并整包构建失败）。
  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return;
          if (id.includes("@tanstack")) return "vendor-virtual";
          if (id.includes("jszip")) return "vendor-zip";
          if (id.includes("framer-motion") || id.includes("motion-dom"))
            return "vendor-motion";
          if (id.includes("react")) return "vendor-react";
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
