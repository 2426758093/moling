/**
 * 更新链路端到端冒烟用的本地服务器（仅测试密钥，不用于对外发布）。
 *
 * 提供：
 *   GET /latest.json          按 bundle/nsis 里最新的签名产物即时生成清单
 *   GET /<安装包名>            带 Range 支持（客户端分段下载）
 *
 * 清单里的 url 指向本机，因此不需要把测试包传到 GitHub。
 * 端点 http://127.0.0.1:8787/latest.json 与 tauri.updater-test.conf.json 保持一致；
 * 端口可用 MOLING_UPDATER_PORT 覆盖。
 */
import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fail, readVersion, root } from "./lib/release-shared.mjs";

const bundleDir = path.join(
  root,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "nsis",
);
const port = Number(process.env.MOLING_UPDATER_PORT ?? 8787);
const version = readVersion();

if (!existsSync(bundleDir)) {
  fail(
    `未找到构建产物目录：${bundleDir}\n  请先用 updater-test 配置构建带签名的安装包`,
  );
}

function pickSignedArtifact() {
  const names = readdirSync(bundleDir).filter(
    (name) =>
      (/\.nsis\.zip$/.test(name) || /-setup\.exe$/.test(name)) &&
      existsSync(path.join(bundleDir, `${name}.sig`)) &&
      name.includes(version),
  );
  if (names.length === 0) {
    fail(
      `没有找到版本 ${version} 的已签名更新包：${bundleDir}\n` +
        "  构建时需 --config src-tauri/tauri.updater-test.conf.json 并提供测试私钥。",
    );
  }
  names.sort(
    (a, b) =>
      statSync(path.join(bundleDir, b)).mtimeMs -
      statSync(path.join(bundleDir, a)).mtimeMs,
  );
  if (names.length > 1) {
    console.warn(
      `[更新冒烟] 发现多个已签名产物，取最新的 ${names[0]}（忽略：${names.slice(1).join(", ")}）`,
    );
  }
  return names[0];
}

const artifactName = pickSignedArtifact();
const artifactPath = path.join(bundleDir, artifactName);
const signature = readFileSync(`${artifactPath}.sig`, "utf8").trim();
if (!signature) fail(`签名文件为空：${artifactPath}.sig`);

const manifest = {
  version,
  notes: "本地更新冒烟",
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: `http://127.0.0.1:${port}/${encodeURIComponent(artifactName)}`,
    },
  },
};

function sendFile(req, res, file) {
  const size = statSync(file).size;
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (range) {
    start = range[1] ? Number(range[1]) : 0;
    end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (!(start <= end) || start >= size) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      res.end();
      return;
    }
    status = 206;
  }
  const headers = {
    "Content-Type": "application/octet-stream",
    "Content-Length": end - start + 1,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  if (status === 206)
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = readFileSync(file).subarray(start, end + 1);
  res.end(stream);
}

createServer((req, res) => {
  const raw = decodeURIComponent((req.url ?? "/").split("?")[0]);
  const name = raw.replace(/^\/+/, "");
  if (!raw || raw === "/") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(
      [
        "墨灵更新冒烟服务器",
        `清单：http://127.0.0.1:${port}/latest.json`,
        `安装包：${artifactName}`,
        "",
      ].join("\n"),
    );
    return;
  }
  if (name === "latest.json") {
    const body = `${JSON.stringify(manifest, null, 2)}\n`;
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }
  // 只允许取 bundle/nsis 下的单层文件，拒绝目录穿越
  if (name !== path.basename(name)) {
    res.writeHead(404).end();
    return;
  }
  const file = path.join(bundleDir, name);
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  sendFile(req, res, file);
}).listen(port, "127.0.0.1", () => {
  console.log("[更新冒烟] 服务已启动");
  console.log(`  清单   http://127.0.0.1:${port}/latest.json`);
  console.log(`  版本   ${manifest.version}`);
  console.log(`  包     ${artifactName}`);
  console.log("  停止   Ctrl+C");
});
