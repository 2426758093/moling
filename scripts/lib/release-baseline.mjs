/**
 * 发布包体基线：防止某次改动（新增模型、依赖、字体）让安装包悄悄膨胀。
 *
 * 基线写在 scripts/release-baseline.json，门禁只允许「基线 + maxGrowthMiB」以内的增长；
 * 超限时阻断发布而不是只打警告 —— 体积回归一旦发出去，无法通过热更新收回。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fail, readJson, root } from "./release-shared.mjs";

const BASELINE_PATH = path.join(root, "scripts", "release-baseline.json");
const MIB = 1024 * 1024;

export function readReleaseBaseline() {
  if (!existsSync(BASELINE_PATH)) {
    fail(
      `缺少发布包体基线：${BASELINE_PATH}\n` +
        "  请先补一个 installerMiB / latestJsonMiB / maxGrowthMiB 的 JSON。",
    );
  }
  const baseline = readJson(BASELINE_PATH);
  for (const key of ["installerMiB", "latestJsonMiB"]) {
    if (typeof baseline[key] !== "number" || !(baseline[key] >= 0)) {
      fail(`发布基线 ${key} 必须是 >= 0 的数字`);
    }
  }
  if (
    typeof baseline.maxGrowthMiB !== "number" ||
    !(baseline.maxGrowthMiB > 0)
  ) {
    fail("发布基线 maxGrowthMiB 必须是正数");
  }
  return baseline;
}

/**
 * 校验单个产物体积；超限直接退出发布。
 * 返回本次体积与相对基线的增量，供调用方打印。
 */
export function assertWithinBaseline({ bytes, baseline, field, label }) {
  const base = baseline[field];
  if (typeof base !== "number" || !(base >= 0)) {
    fail(`发布基线缺少字段：${field}`);
  }
  const mib = bytes / MIB;
  const limit = base + baseline.maxGrowthMiB;
  if (mib > limit) {
    fail(
      `${label}体积超基线：${mib.toFixed(2)} MB > ${base.toFixed(2)} + ${baseline.maxGrowthMiB} MB（上限 ${limit.toFixed(2)} MB）。\n` +
        "  若增长确属预期，请先在本机确认安装、冷启动与更新冒烟正常，" +
        "再修改 scripts/release-baseline.json，并在发版说明里写明原因。",
    );
  }
  return { mib, delta: mib - base, limit };
}
