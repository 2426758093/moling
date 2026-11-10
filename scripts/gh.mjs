/**
 * GitHub 操作入口：push / release / status。
 *
 * 网络受限时自动降级（直连 → 环境代理 → 边缘 IP + 本地 CONNECT 代理），
 * 所有代理只作用于当前命令，不写入 git 配置。
 *
 * 用法：
 *   pnpm gh:push                 推送当前分支
 *   pnpm gh:release [--notes s]  校验版本与同步状态，创建并推送 v<version> tag
 *   pnpm gh:status               查看最近 5 次 Actions 运行（可用 GITHUB_TOKEN）
 */
import https from "node:https";
import {
  isSshRemote,
  parseGithubRemote,
  runProcess,
  selectTransport,
} from "./lib/gh-net.mjs";
import { readVersion, releaseTag, resolveRepo } from "./lib/release-shared.mjs";

const PREFIX = "[GitHub]";
const CAPTURE = ["ignore", "pipe", "pipe"];

function fail(message) {
  console.error(`\n${PREFIX} ${message}\n`);
  process.exit(1);
}

function log(message) {
  console.log(`${PREFIX} ${message}`);
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function git(args, { transport, stdio = "inherit" } = {}) {
  const result = await runProcess(
    "git",
    [...(transport?.args ?? []), ...args],
    { stdio },
  );
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`git ${args.join(" ")} 失败${detail ? `：${detail}` : ""}`);
  }
  return result.stdout.trim();
}

async function tryGit(args) {
  try {
    return await git(args, { stdio: CAPTURE });
  } catch {
    return "";
  }
}

async function getRemoteUrl() {
  try {
    const result = await runProcess("git", ["remote", "get-url", "origin"], {
      stdio: CAPTURE,
    });
    if (result.code !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  } catch {
    fail(
      "未配置 git remote origin。\n" +
        "  git remote add origin https://github.com/<owner>/<repo>.git",
    );
  }
}

async function withTransport(url, run) {
  const transport = await selectTransport({
    remoteUrl: url,
    log: (message) => console.error(`${PREFIX} ${message}`),
  });
  log(`传输方式：${transport.via}`);
  try {
    await run(transport);
  } finally {
    transport.close();
  }
}

async function push() {
  const url = await getRemoteUrl();
  const remote = parseGithubRemote(url);
  if (!remote) {
    fail(
      `origin 不是 GitHub 地址：${url}\n` +
        "  可执行：git remote set-url origin https://github.com/<owner>/<repo>.git",
    );
  }
  if (isSshRemote(url)) {
    fail(
      "origin 是 SSH 地址，本地 CONNECT 代理只能转发 HTTPS。\n" +
        `  请先切换：git remote set-url origin ${remote.httpsUrl}.git`,
    );
  }

  await withTransport(url, async (transport) => {
    await git(["push", "origin", "HEAD"], { transport });
  });
  log("推送完成");
}

async function release() {
  const version = readVersion();
  const tag = releaseTag(version);
  const notes = argValue("--notes") ?? `Release ${tag}`;
  const allowDirty = process.argv.includes("--allow-dirty");
  const dryRun = process.argv.includes("--dry-run");
  const repo = resolveRepo();
  const url = await getRemoteUrl();

  if (isSshRemote(url)) {
    fail(
      "origin 是 SSH 地址，本地 CONNECT 代理只能转发 HTTPS。\n" +
        `  请先切换：git remote set-url origin ${parseGithubRemote(url)?.httpsUrl ?? "https://github.com/<owner>/<repo>"}.git`,
    );
  }

  const dirty = await tryGit(["status", "--porcelain"]);
  if (dirty && !allowDirty) {
    fail(
      "工作区有未提交改动，发版前请先提交（或加 --allow-dirty 跳过检查）：\n" +
        dirty,
    );
  }

  const branch = await tryGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") {
    fail("当前处于游离 HEAD，请先切到要发版的分支");
  }

  await withTransport(url, async (transport) => {
    await git(["fetch", "origin", "--tags", "--prune"], { transport });

    const head = await git(["rev-parse", "HEAD"], { stdio: CAPTURE });
    const remoteHead = await tryGit([
      "rev-parse",
      "--verify",
      `refs/remotes/origin/${branch}`,
    ]);
    if (!remoteHead) {
      fail(`远端还没有分支 origin/${branch}，请先执行 pnpm gh:push`);
    }
    if (remoteHead !== head) {
      fail(
        `本地 ${branch}（${head.slice(0, 7)}）与 origin/${branch}（${remoteHead.slice(0, 7)}）不一致。\n` +
          "  请先提交并执行 pnpm gh:push，确保 tag 指向远端已有的提交。",
      );
    }

    // 附注 tag 的 ref 指向 tag 对象而非提交，必须剥离到 ^{commit} 才能与 HEAD 比较
    const existing = await tryGit([
      "rev-parse",
      "--verify",
      `refs/tags/${tag}^{commit}`,
    ]);
    if (existing && existing !== head) {
      fail(
        `tag ${tag} 已存在且指向 ${existing.slice(0, 7)}，不是当前提交 ${head.slice(0, 7)}。\n` +
          "  更新版本后重试：同步 package.json 与 src-tauri/tauri.conf.json 的 version。",
      );
    }

    if (existing) {
      log(`tag ${tag} 已存在于当前提交，跳过创建`);
    } else {
      if (dryRun) {
        log(`[dry-run] 校验通过，将创建并推送 tag ${tag}`);
        return;
      }
      await git(["tag", "-a", tag, "-m", notes]);
      log(`已创建 tag ${tag}（${notes}）`);
    }

    if (dryRun) {
      log(`[dry-run] 校验通过，tag ${tag} 已存在，将推送（若远端缺失）`);
      return;
    }
    await git(["push", "origin", `refs/tags/${tag}`], { transport });
  });

  if (dryRun) {
    log("[dry-run] 未创建或推送任何内容");
  } else {
    log(`已推送 ${tag}，Release 流水线将自动开始`);
    log(`查看进度：https://github.com/${repo}/actions/workflows/release.yml`);
  }
}

function githubApi(pathname) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
  return new Promise((resolve, reject) => {
    const request = https.get(
      `https://api.github.com${pathname}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "moling-release-script",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        timeout: 15000,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(
              new Error(
                `GitHub API 返回 ${response.statusCode}（私有仓库需设置 GITHUB_TOKEN）：${body.slice(0, 200)}`,
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`无法解析 GitHub API 响应：${error.message}`));
          }
        });
      },
    );
    request.on("timeout", () =>
      request.destroy(new Error("连接 api.github.com 超时")),
    );
    request.on("error", reject);
  });
}

async function status() {
  const repo = resolveRepo();
  const data = await githubApi(`/repos/${repo}/actions/runs?per_page=5`);
  const runs = data?.workflow_runs ?? [];
  if (runs.length === 0) {
    log("没有找到工作流运行记录");
    return;
  }
  log(`最近 ${runs.length} 次运行（${repo}）`);
  for (const run of runs) {
    const state = run.conclusion ?? run.status;
    log(
      `  ${String(state).padEnd(10)} ${String(run.name).padEnd(18)} ` +
        `${String(run.head_branch ?? "").padEnd(10)} ${String(run.head_sha).slice(0, 7)}  ` +
        `${run.created_at}  ${run.html_url}`,
    );
  }
}

const commands = { push, release, status };
const command = process.argv[2];

if (!command || !commands[command]) {
  log(`未知命令：${command ?? "(空)"}`);
  console.log("可用命令：gh:push / gh:release / gh:status");
  process.exit(command ? 1 : 0);
}

try {
  await commands[command]();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
