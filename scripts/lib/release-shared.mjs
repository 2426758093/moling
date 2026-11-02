/**
 * 发布脚本共享工具。
 *
 * 单一真源约定：
 * - 仓库地址：优先 `MOLING_UPDATE_REPO=owner/repo`，否则从 `git remote get-url origin` 解析。
 *   不在代码里硬编码 owner/repo —— 否则 fork、改名或本地为空的仓库都会拿到错误端点。
 * - 版本号：`src-tauri/tauri.conf.json` 是构建真源，`package.json` 必须与之一致（发布前校验）。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export const TAURI_CONF = path.join(root, "src-tauri", "tauri.conf.json");
export const RELEASE_CONF = path.join(
  root,
  "src-tauri",
  "tauri.release.conf.json",
);

function fail(message) {
  console.error(`\n[发布脚本] ${message}\n`);
  process.exit(1);
}

/** 校验并规范化 owner/repo，避免拼出半截 URL */
function normalizeRepo(value) {
  const repo = value.trim().replace(/\.git$/i, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    fail(`仓库标识不合法：'${value}'，应为 owner/repo 形式`);
  }
  return repo;
}

/** 解析 GitHub 仓库：环境变量优先，其次 git remote。两者都没有就明确失败。 */
export function resolveRepo() {
  const fromEnv = process.env.MOLING_UPDATE_REPO;
  if (fromEnv && fromEnv.trim()) return normalizeRepo(fromEnv);

  let url = "";
  try {
    url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    fail(
      "无法确定 GitHub 仓库：未配置 git remote origin。\n" +
        "  · 已有远端：git remote add origin https://github.com/<owner>/<repo>.git\n" +
        "  · 或临时指定：MOLING_UPDATE_REPO=<owner>/<repo> pnpm release:config",
    );
  }

  // 兼容 https://github.com/o/r.git 与 git@github.com:o/r.git
  const matched = url.match(/github\.com[:/]+([^/]+)\/([^/#?]+)/i);
  if (!matched) {
    fail(`origin 不是 GitHub 地址：'${url}'，请用 MOLING_UPDATE_REPO 显式指定`);
  }
  return normalizeRepo(`${matched[1]}/${matched[2]}`);
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** 构建真源版本号，同时校验 package.json 与之一致（双真源漂移会让更新器误判） */
export function readVersion() {
  const tauriVersion = readJson(TAURI_CONF).version;
  const pkgVersion = readJson(path.join(root, "package.json")).version;
  if (!tauriVersion) fail("tauri.conf.json 缺少 version 字段");
  if (tauriVersion !== pkgVersion) {
    fail(
      `版本号不一致：tauri.conf.json=${tauriVersion}，package.json=${pkgVersion}。\n` +
        "  请先同步两者，否则安装包版本与应用内显示会对不上。",
    );
  }
  return tauriVersion;
}

export function releaseTag(version) {
  return `v${version}`;
}

/** GitHub Releases 资产直链（与 latest.json 里的 url 必须完全一致） */
export function assetUrl(repo, version, fileName) {
  return `https://github.com/${repo}/releases/download/${releaseTag(version)}/${encodeURIComponent(fileName)}`;
}

export { fail };
