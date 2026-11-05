/**
 * GitHub 传输层：在直连 github.com 被阻断时自动改用可达边缘 IP。
 *
 * 背景：部分网络下 github.com:443 时通时不通，而 api.github.com、DNS 本身正常。
 * 这里的做法是逐个探测 GitHub 边缘 IP，挑一个能建立 TCP 连接的，在进程内起一个
 * 临时 CONNECT 代理，把 git 的 http.proxy 指过去（仅本次命令生效，不改任何配置）。
 *
 * 降级顺序：直连 → 环境代理（HTTPS_PROXY 等）→ 边缘 IP + 本地 CONNECT 代理。
 * 三条路都不通时给出明确报错，而不是把 curl 的原始错误抛给用户。
 */
import { spawn } from "node:child_process";
import dns from "node:dns/promises";
import net from "node:net";

import { root } from "./release-shared.mjs";

const GITHUB_HOST = "github.com";
const GITHUB_PORT = 443;

// DNS 之外的候选：不同网络下可达的边缘节点不同，多列几个提高成功率。
// 这些 IP 会变，只作为兜底，解析结果始终排在前面。
const KNOWN_EDGE_IPS = [
  "20.205.243.166",
  "20.27.177.113",
  "20.201.28.151",
  "140.82.112.3",
  "140.82.113.3",
  "140.82.114.3",
  "140.82.121.3",
  "4.237.22.38",
];

/** 保序去重 */
export function dedupe(values) {
  return [...new Set(values)];
}

/** 解析 GitHub 远程地址（https 或 ssh），非 GitHub 返回 null */
export function parseGithubRemote(url) {
  const matched = String(url ?? "")
    .trim()
    .match(
      /^(?:https?:\/\/)?(?:[^@/]+@)?github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i,
    );
  if (!matched) return null;
  const owner = matched[1];
  const repo = matched[2];
  if (!owner || !repo || owner === "." || repo === ".") return null;
  return { owner, repo, httpsUrl: `https://github.com/${owner}/${repo}` };
}

export function isSshRemote(url) {
  return /^(?:ssh:\/\/)?(?:[^@/]+@)?github\.com[:/]/i.test(
    String(url ?? "").trim(),
  );
}

/** 探测 TCP 可达性（不发 TLS，够判断链路是否被封） */
export function canConnect(host, port = GITHUB_PORT, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** DNS 解析结果 + 内置候选，保序去重 */
export async function resolveGithubIps() {
  let resolved = [];
  try {
    const records = await dns.lookup(GITHUB_HOST, { all: true });
    resolved = records.map((record) => record.address);
  } catch {
    // DNS 失败也继续用内置候选
  }
  return dedupe([...resolved, ...KNOWN_EDGE_IPS]);
}

/**
 * 进程内 CONNECT 代理：只改写指向 github.com 及其子域名的连接，
 * 其余主机按原样转发（TLS 证书仍由 git 按 SNI 校验，不会降级为不校验）。
 */
export function startConnectProxy(targetIp) {
  const sockets = new Set();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));

    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString("latin1");
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (buffer.length > 16 * 1024) client.destroy();
        return;
      }
      client.off("data", onData);
      // 移除 data 监听不会自动暂停流；不暂停的话，握手期间到达的字节会被丢弃
      client.pause();

      const [requestLine] = buffer.split("\r\n", 1);
      const [method, authority] = requestLine.split(/\s+/);
      if (method !== "CONNECT" || !authority) {
        client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
        return;
      }

      const [host, portText] = authority.split(":");
      const hostname = (host ?? "").toLowerCase();
      const port = Number(portText) || GITHUB_PORT;
      const upstreamHost =
        hostname === GITHUB_HOST || hostname.endsWith(`.${GITHUB_HOST}`)
          ? targetIp
          : host;
      // CONNECT 头之后可能已经跟着 TLS ClientHello，必须原样转交
      const leftover = Buffer.from(buffer.slice(headerEnd + 4), "latin1");

      const upstream = net.connect({ host: upstreamHost, port }, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (leftover.length > 0) upstream.write(leftover);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    };
    client.on("data", onData);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        close() {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      });
    });
  });
}

function proxyArgs(proxyUrl) {
  return ["-c", `http.proxy=${proxyUrl}`, "-c", `https.proxy=${proxyUrl}`];
}

/**
 * 异步执行子进程。必须用异步版本：本地 CONNECT 代理就跑在当前事件循环里，
 * execFileSync 会把循环整个卡住，git 连上代理后也永远等不到响应。
 */
export function runProcess(
  command,
  args,
  { cwd = root, env = process.env, stdio = "inherit", timeoutMs } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    if (stdio !== "inherit") {
      child.stdout?.on("data", (chunk) => (stdout += chunk.toString("utf8")));
      child.stderr?.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    }
    const timer = timeoutMs
      ? globalThis.setTimeout(() => child.kill(), timeoutMs)
      : undefined;
    child.on("error", (error) => {
      globalThis.clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      globalThis.clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function remoteReachable(remoteUrl, args, timeoutMs = 20000) {
  try {
    const result = await runProcess(
      "git",
      [...args, "ls-remote", "--heads", remoteUrl],
      {
        stdio: ["ignore", "ignore", "ignore"],
        timeoutMs,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
    );
    return result.code === 0;
  } catch {
    return false;
  }
}

/** 读取 Windows 系统代理（ProxyEnable=1 时）；非 Windows 或未启用返回空串 */
async function systemProxy() {
  if (process.platform !== "win32") return "";
  const key =
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  const read = async (name) => {
    const result = await runProcess("reg", ["query", key, "/v", name], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.code !== 0) return "";
    const line = result.stdout
      .split(/\r?\n/)
      .find((text) => text.includes(name));
    return line ? line.trim().split(/\s+/).pop() : "";
  };

  if ((await read("ProxyEnable")) !== "0x1") return "";
  const server = (await read("ProxyServer")).trim();
  if (!server) return "";
  const httpsEntry = server.split(";").find((part) => /^https?=/i.test(part));
  const raw = (httpsEntry ? httpsEntry.split("=")[1] : server).trim();
  if (!raw) return "";
  return /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
}

/**
 * 选出本次 git 命令可用的传输方式。
 * 返回的 args 为 `git -c ...` 配置参数，close 负责销毁临时代理。
 */
export async function selectTransport({ remoteUrl, log = () => {} }) {
  // 调试/验证用：MOLING_GH_FORCE_PROXY=1 强制走边缘 IP 代理，跳过直连与代理
  const forceEdge = process.env.MOLING_GH_FORCE_PROXY === "1";

  // TCP 能连上不代表能完成 TLS/握手：部分网络会先放行 SYN 再重置连接，
  // 所以直连必须用真实的 ls-remote 验证一次。
  if (!forceEdge && remoteUrl && /^https?:\/\//i.test(remoteUrl)) {
    if (
      (await canConnect(GITHUB_HOST, GITHUB_PORT)) &&
      (await remoteReachable(remoteUrl, []))
    ) {
      return { args: [], via: "直连", close() {} };
    }
    log("直连握手失败，尝试备用通道");
  }

  const envProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const candidates = forceEdge
    ? []
    : dedupe(
        [
          envProxy,
          process.env.ALL_PROXY,
          process.env.all_proxy,
          await systemProxy(),
        ].filter(Boolean),
      );
  for (const proxyUrl of candidates) {
    const args = proxyArgs(proxyUrl);
    if (await remoteReachable(remoteUrl, args)) {
      return { args, via: `代理 ${proxyUrl}`, close() {} };
    }
    log(`代理 ${proxyUrl} 不可用，继续探测 GitHub 边缘 IP`);
  }

  const ips = await resolveGithubIps();
  const checks = await Promise.all(
    ips.map(async (ip) => ({ ip, ok: await canConnect(ip, GITHUB_PORT) })),
  );
  const reachable = checks.filter((item) => item.ok).map((item) => item.ip);

  for (const ip of reachable) {
    const proxy = await startConnectProxy(ip);
    const args = proxyArgs(`http://127.0.0.1:${proxy.port}`);
    if (remoteReachable(remoteUrl, args)) {
      return {
        args,
        via: `边缘 IP ${ip}（本地 CONNECT 代理）`,
        close: proxy.close,
      };
    }
    proxy.close();
    log(`边缘 IP ${ip} 可连通但仓库握手失败，换下一个`);
  }

  throw new Error(
    [
      "无法访问 GitHub：直连、环境代理与所有候选边缘 IP 均失败。",
      "  · 请确认网络已连通，或先启用代理（如 FlClash 的 mixed 端口）后重试；",
      "  · 也可设置 HTTPS_PROXY=http://127.0.0.1:<端口> 再执行。",
    ].join("\n"),
  );
}
