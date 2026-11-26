import { beforeEach, describe, expect, it } from "vitest";
import {
  COMPOSER_DEFAULT,
  COMPOSER_MAX,
  COMPOSER_MIN,
  DEFAULT_LAYOUT,
  INSPECTOR_DEFAULT,
  INSPECTOR_MAX,
  INSPECTOR_MIN,
  LAYOUT_STORAGE_KEY,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  clampSize,
  readLayout,
  sanitizeLayout,
  writeLayout,
} from "./layout";

beforeEach(() => {
  localStorage.clear();
});

describe("布局默认值", () => {
  it("默认尺寸与范围符合设计约定", () => {
    expect(DEFAULT_LAYOUT).toEqual({
      sidebar: 248,
      inspector: 288,
      composer: 160,
    });
    expect([SIDEBAR_MIN, SIDEBAR_MAX]).toEqual([200, 420]);
    expect([INSPECTOR_MIN, INSPECTOR_MAX]).toEqual([240, 420]);
    expect([COMPOSER_MIN, COMPOSER_MAX]).toEqual([120, 360]);
    expect(SIDEBAR_DEFAULT).toBe(248);
    expect(INSPECTOR_DEFAULT).toBe(288);
    expect(COMPOSER_DEFAULT).toBe(160);
  });
});

describe("clampSize", () => {
  it("夹取到闭区间并取整", () => {
    expect(clampSize(150, 200, 420)).toBe(200);
    expect(clampSize(500, 200, 420)).toBe(420);
    expect(clampSize(248.6, 200, 420)).toBe(249);
    expect(clampSize(300, 200, 420)).toBe(300);
  });

  it("非有限值回退到下限", () => {
    expect(clampSize(Number.NaN, 200, 420)).toBe(200);
    expect(clampSize(Number.POSITIVE_INFINITY, 200, 420)).toBe(420);
  });
});

describe("sanitizeLayout", () => {
  it("坏数据回退默认值", () => {
    expect(sanitizeLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(sanitizeLayout("x")).toEqual(DEFAULT_LAYOUT);
    expect(sanitizeLayout({})).toEqual(DEFAULT_LAYOUT);
  });

  it("越界值夹取、非法字段单独回退", () => {
    expect(
      sanitizeLayout({ sidebar: 9999, inspector: 1, composer: "tall" }),
    ).toEqual({
      sidebar: SIDEBAR_MAX,
      inspector: INSPECTOR_MIN,
      composer: COMPOSER_DEFAULT,
    });
  });
});

describe("localStorage 读写", () => {
  it("没有快照时返回默认值", () => {
    expect(readLayout()).toEqual(DEFAULT_LAYOUT);
  });

  it("写入后可读回并夹取残留越界值", () => {
    writeLayout({ sidebar: 300, inspector: 320, composer: 220 });
    expect(readLayout()).toEqual({
      sidebar: 300,
      inspector: 320,
      composer: 220,
    });

    localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({ sidebar: 10, inspector: 800, composer: 200 }),
    );
    expect(readLayout()).toEqual({
      sidebar: SIDEBAR_MIN,
      inspector: INSPECTOR_MAX,
      composer: 200,
    });
  });

  it("损坏的 JSON 不影响启动", () => {
    localStorage.setItem(LAYOUT_STORAGE_KEY, "{oops");
    expect(readLayout()).toEqual(DEFAULT_LAYOUT);
  });
});
