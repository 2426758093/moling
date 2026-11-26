/// 可拖拽布局：尺寸常量、夹取与 localStorage 快照。
/// 纯显示偏好，不进入 Rust 设置白名单；坏数据只丢对应字段，不拖垮整张界面。

export const LAYOUT_STORAGE_KEY = "moling.layout.v1";

export const SIDEBAR_DEFAULT = 248;
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 420;

export const INSPECTOR_DEFAULT = 288;
export const INSPECTOR_MIN = 240;
export const INSPECTOR_MAX = 420;

export const COMPOSER_DEFAULT = 160;
export const COMPOSER_MIN = 120;
export const COMPOSER_MAX = 360;

export interface LayoutSizes {
  sidebar: number;
  inspector: number;
  composer: number;
}

export const DEFAULT_LAYOUT: LayoutSizes = {
  sidebar: SIDEBAR_DEFAULT,
  inspector: INSPECTOR_DEFAULT,
  composer: COMPOSER_DEFAULT,
};

/// 统一取整并夹取到区间；NaN（清空输入等）回退到下限，±Infinity 自然夹到端点。
export function clampSize(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/// 从磁盘/旧版本恢复尺寸：越界值夹取到区间，非法值回退默认值。
export function sanitizeLayout(raw: unknown): LayoutSizes {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_LAYOUT };
  const src = raw as Record<string, unknown>;
  const pick = (
    value: unknown,
    min: number,
    max: number,
    fallback: number,
  ): number =>
    typeof value === "number" && Number.isFinite(value)
      ? clampSize(value, min, max)
      : fallback;
  return {
    sidebar: pick(src.sidebar, SIDEBAR_MIN, SIDEBAR_MAX, SIDEBAR_DEFAULT),
    inspector: pick(
      src.inspector,
      INSPECTOR_MIN,
      INSPECTOR_MAX,
      INSPECTOR_DEFAULT,
    ),
    composer: pick(src.composer, COMPOSER_MIN, COMPOSER_MAX, COMPOSER_DEFAULT),
  };
}

export function readLayout(): LayoutSizes {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LAYOUT };
    return sanitizeLayout(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

export function writeLayout(sizes: LayoutSizes): void {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(sizes));
  } catch {
    // 隐私模式等写不了 localStorage 时只在本次会话生效
  }
}
