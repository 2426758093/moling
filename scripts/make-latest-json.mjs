/**
 * 由构建产物生成 Tauri updater 清单 latest.json。
 *
 * 输入：src-tauri/target/release/bundle/nsis/ 下的 *.nsis.zip 与同名 *.sig
 * 输出：bundle/nsis/latest.json
 *
 * 清单字段（Tauri v2 静态清单格式）：
 *   version / notes / pub_date / platforms["windows-x86_64"].{ signature, url }
 * signature 是 .sig 文件的整段文本（多行，保留换行）。
 *
 * 发布顺序要求：先上传 zip 与 sig，确认可下载，最后才替换 latest.json。
 * 反过来会出现清单指向 404，所有客户端检查更新立刻报错。
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  TAURI_CONF,
  assetUrl,
  fail,
  readJson,
  readVersion,
  releaseTag,
  resolveRepo,
  root,
} from "./lib/release-shared.mjs";

const bundleDir = path.join(
  root,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "nsis",
);

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (!existsSync(bundleDir)) {
  fail(
    `未找到构建产物目录：${bundleDir}\n` +
      "  请先执行：pnpm release:config && pnpm tauri build --config src-tauri/tauri.release.conf.json",
  );
}

const version = readVersion();
const repo = resolveRepo();

const files = readdirSync(bundleDir);
// Tauri 2 对 NSIS 的更新包形态随版本不同：可能是 *.nsis.zip，也可能直接签名 *-setup.exe。
// 两种都要认，但同一次构建里只能有一个待发布的包。
const zips = files.filter((f) => f.endsWith(".nsis.zip"));
const exes = files.filter((f) => /-setup\.exe$/.test(f));
const candidates = zips.length > 0 ? zips : exes;

if (candidates.length === 0) {
  fail(
    `目录中没有可发布的更新包（*.nsis.zip 或 *-setup.exe）：${bundleDir}\n` +
      "  更新制品需要 createUpdaterArtifacts: true，请确认用了 --config src-tauri/tauri.release.conf.json",
  );
}
if (candidates.length > 1) {
  fail(
    `发现多个更新包（${candidates.join(", ")}），无法判断该发布哪一个，请先清理目录`,
  );
}

const artifactName = candidates[0];
const artifactPath = path.join(bundleDir, artifactName);
const sigPath = `${artifactPath}.sig`;

if (!existsSync(sigPath)) {
  fail(
    `缺少签名文件：${sigPath}\n  构建时需提供 TAURI_SIGNING_PRIVATE_KEY 与口令`,
  );
}

// signature 字段原样使用 .sig 文件内容：Tauri 生成的是整段签名的 base64，
// 校验器会自行解码，因此这里不做再编码或换行处理。
const signature = readFileSync(sigPath, "utf8").trim();
if (!signature) fail(`签名文件为空：${sigPath}`);
const decoded = Buffer.from(signature, "base64").toString("utf8");
if (
  !decoded.includes("untrusted comment") &&
  !signature.includes("untrusted comment")
) {
  fail(`签名文件格式异常（既不是 base64 也不是 minisign 文本）：${sigPath}`);
}

// 防呆：更新包文件名必须与当前版本号一致，否则说明产物是上次构建残留
if (!artifactName.includes(version)) {
  fail(
    `更新包文件名与版本号不匹配：${artifactName} 不含 ${version}。\n` +
      "  产物可能是旧构建残留，请先清理 bundle 目录后重新构建。",
  );
}

// 防呆：签名 keyid 必须与内置公钥一致。公钥编译进二进制后不可更换，
// 一旦这里配错（换了密钥却忘了更新 pubkey），所有客户端都会验签失败且无法自行修复。
const decodedSig = Buffer.from(signature, "base64").toString("utf8").trim();
const pubKeyB64 = readJson(TAURI_CONF).plugins?.updater?.pubkey;
if (!pubKeyB64) fail("tauri.conf.json 缺少 plugins.updater.pubkey");

const keyIdOf = (minisignText) => {
  const line = minisignText.split("\n")[1]?.trim();
  if (!line) return "";
  // 结构：2 字节算法标识（"Ed" / "ED"）+ 8 字节 keyid + 密钥材料
  return Buffer.from(line, "base64").subarray(2, 10).toString("hex");
};

const pubKeyId = keyIdOf(
  Buffer.from(pubKeyB64, "base64").toString("utf8").trim(),
);
const sigKeyId = keyIdOf(decodedSig);
if (!pubKeyId || !sigKeyId) fail("无法解析公钥或签名中的 keyid");
if (pubKeyId !== sigKeyId) {
  fail(
    `签名与内置公钥不配对：公钥 keyid=${pubKeyId}，签名 keyid=${sigKeyId}。\n` +
      "  说明构建时用的私钥不是 tauri.conf.json 中 pubkey 对应的那把，发出去会导致全员更新失败。",
  );
}

const notes =
  argValue("--notes") ??
  (argValue("--notes-file")
    ? readFileSync(argValue("--notes-file"), "utf8").trim()
    : "");

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: assetUrl(repo, version, artifactName),
    },
  },
};

const outPath = path.join(bundleDir, "latest.json");
writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log("[发布脚本] 已生成更新清单");
console.log(`  版本   ${version}（tag ${releaseTag(version)}）`);
console.log(
  `  包     ${artifactName}  ${(statSync(artifactPath).size / 1024 / 1024).toFixed(2)} MB`,
);
console.log(`  签名   ${sigPath.split(/[\\/]/).pop()}`);
console.log(`  地址   ${manifest.platforms["windows-x86_64"].url}`);
console.log(`  输出   ${outPath}`);
