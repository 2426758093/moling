export const BODY_IDLE_MIN = 5;
export const BODY_IDLE_MAX = 300;
export const BODY_IDLE_DEFAULT = 30;
export const BODY_TOTAL_MIN = 30;
export const BODY_TOTAL_MAX = 1800;
export const BODY_TOTAL_DEFAULT = 300;

function parseSecs(
  raw: string,
  min: number,
  max: number,
  label: string,
): number {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) throw new Error(`${label}必须是整数`);
  const secs = Number(text);
  if (secs < min || secs > max) {
    throw new Error(`${label}应在 ${min}–${max} 秒之间`);
  }
  return secs;
}

export function parseBodyTimeouts(
  idleRaw: string,
  totalRaw: string,
): { idle: number; total: number } {
  const idle = parseSecs(idleRaw, BODY_IDLE_MIN, BODY_IDLE_MAX, "无数据超时");
  const total = parseSecs(
    totalRaw,
    BODY_TOTAL_MIN,
    BODY_TOTAL_MAX,
    "响应体总超时",
  );
  if (total < idle) throw new Error("响应体总超时不能小于无数据超时");
  return { idle, total };
}
