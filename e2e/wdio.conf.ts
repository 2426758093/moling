import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
/** 与 src-tauri/tauri.conf.json 的 package 名一致，debug 产物为 target/debug/moling.exe */
const appBinary = path.join(
  rootDir,
  "src-tauri",
  "target",
  "debug",
  "moling.exe",
);
/** cargo install 的默认落盘位置，避免依赖 PATH 顺序 */
const tauriDriverBinary = path.join(
  os.homedir(),
  ".cargo",
  "bin",
  process.platform === "win32" ? "tauri-driver.exe" : "tauri-driver",
);

let tauriDriver: ChildProcess | undefined;

function stopTauriDriver(): void {
  tauriDriver?.kill();
  tauriDriver = undefined;
}

export const config = {
  hostname: "127.0.0.1",
  port: 4444,
  specs: [path.join(__dirname, "specs", "**", "*.e2e.ts")],
  maxInstances: 1,
  // tauri-driver 透传 tauri:options 给 WebView2 驱动；msedgedriver 必须已在 PATH 中
  capabilities: [
    {
      maxInstances: 1,
      "tauri:options": {
        application: appBinary,
      },
    },
  ],
  logLevel: "warn",
  waitforTimeout: 15000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 1,
  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    timeout: 120000,
  },
  beforeSession(): void {
    tauriDriver = spawn(tauriDriverBinary, [], {
      stdio: [null, process.stdout, process.stderr],
    });
    tauriDriver.on("error", (error: Error) => {
      console.error(
        "tauri-driver 启动失败（是否已 cargo install tauri-driver？）:",
        error,
      );
      process.exit(1);
    });
  },
  afterSession(): void {
    stopTauriDriver();
  },
};

// 会话异常中断时也要回收 tauri-driver，避免占用 4444 端口
for (const signal of ["exit", "SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopTauriDriver();
  });
}
