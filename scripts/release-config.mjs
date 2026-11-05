/**
 * 生成发布专用配置 src-tauri/tauri.release.conf.json。
 *
 * 为什么不直接改基础 tauri.conf.json（开发规范 ADR #14）：
 * 基础配置必须保持 endpoints 为空、createUpdaterArtifacts 为 false，
 * 这样没有签名密钥的常规 `pnpm tauri build` 也能成功；
 * 更新端点与更新制品只在发布构建里通过 `--config` 叠加。
 *
 * Tauri 的 config 叠加是深合并，数组为替换语义，因此这里只需写要覆盖的字段。
 */
import { writeFileSync } from "node:fs";
import {
  RELEASE_CONF,
  resolveRepo,
  readVersion,
  releaseTag,
} from "./lib/release-shared.mjs";

const repo = resolveRepo();
const version = readVersion();

const config = {
  $schema: "https://schema.tauri.app/config/2",
  plugins: {
    updater: {
      // GitHub Releases 的固定别名地址：永远指向最新一次已发布版本
      endpoints: [
        `https://github.com/${repo}/releases/latest/download/latest.json`,
      ],
    },
  },
  bundle: {
    createUpdaterArtifacts: true,
  },
};

writeFileSync(RELEASE_CONF, `${JSON.stringify(config, null, 2)}\n`, "utf8");

console.log("[发布脚本] 已生成发布配置");
console.log(`  仓库   ${repo}`);
console.log(`  版本   ${version}（tag ${releaseTag(version)}）`);
console.log(`  端点   ${config.plugins.updater.endpoints[0]}`);
console.log(
  `  制品   更新包文件名需为 ASCII（如 moling_${version}_x64-setup.exe），GitHub 会丢弃中文`,
);
console.log(`  输出   ${RELEASE_CONF}`);
