import { beforeAll, describe, expect, it } from "vitest";
import type { HistoryItem } from "./api";
import i18n from "../i18n";
import {
  DEFAULT_ICON_SIZE,
  DEFAULT_PREFS,
  DETAILS_COLUMNS,
  GROUP_HEADER_HEIGHT,
  ICON_SIZE_MAX,
  ICON_SIZE_MIN,
  SORT_OPTIONS,
  VIEW_OPTIONS,
  appendHistoryItems,
  buildGalleryRows,
  buildHistoryQuery,
  defaultIconSizeForMode,
  formatBytes,
  formatDimensions,
  formatHistoryDate,
  groupHistoryItems,
  historyType,
  iconModeForSize,
  layoutForMode,
  nextSortState,
  parseGalleryPrefs,
  rowHeightForMode,
  rowThumbSize,
  serializeGalleryPrefs,
  snapIconSize,
  sortHistoryItems,
  zoomIconSize,
  type GallerySort,
} from "./galleryView";

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

function item(
  id: number,
  overrides: Partial<HistoryItem["history"]> = {},
): HistoryItem {
  return {
    history: {
      id,
      prompt: `prompt ${id}`,
      negativePrompt: "",
      model: "flux",
      providerName: "test",
      seed: null,
      width: 1024,
      height: 1024,
      guidance: 3.5,
      steps: 20,
      style: "",
      filePath: `/media/${id}.png`,
      favorite: false,
      createdAt: String(1_700_000_000 + id),
      fileSize: 1024 * 1024,
      parentId: null,
      op: "generate",
      ...overrides,
    },
    thumbUrl: "",
  };
}

describe("缩放映射", () => {
  it("夹在 64–320 并按 16 对齐", () => {
    expect(snapIconSize(1)).toBe(ICON_SIZE_MIN);
    expect(snapIconSize(10_000)).toBe(ICON_SIZE_MAX);
    expect(snapIconSize(100)).toBe(96);
    expect(snapIconSize(108)).toBe(112);
    expect(snapIconSize(Number.NaN)).toBe(DEFAULT_ICON_SIZE);
  });

  it("滚轮每格 ±16", () => {
    expect(zoomIconSize(160, 1)).toBe(176);
    expect(zoomIconSize(160, -1)).toBe(144);
    expect(zoomIconSize(64, -5)).toBe(ICON_SIZE_MIN);
    expect(zoomIconSize(320, 5)).toBe(ICON_SIZE_MAX);
  });

  it("跨阈值切换模式标签", () => {
    expect(iconModeForSize(64)).toBe("small");
    expect(iconModeForSize(79)).toBe("small");
    expect(iconModeForSize(80)).toBe("medium");
    expect(iconModeForSize(127)).toBe("medium");
    expect(iconModeForSize(128)).toBe("large");
    expect(iconModeForSize(191)).toBe("large");
    expect(iconModeForSize(192)).toBe("xlarge");
    expect(iconModeForSize(320)).toBe("xlarge");
  });

  it("行内缩略图映射到 16–96", () => {
    expect(rowThumbSize(64)).toBe(16);
    expect(rowThumbSize(320)).toBe(96);
    expect(rowThumbSize(160)).toBeGreaterThan(16);
    expect(rowThumbSize(160)).toBeLessThan(96);
  });

  it("视图默认尺寸落在自己的阈值区间", () => {
    expect(iconModeForSize(defaultIconSizeForMode("xlarge"))).toBe("xlarge");
    expect(iconModeForSize(defaultIconSizeForMode("large"))).toBe("large");
    expect(iconModeForSize(defaultIconSizeForMode("medium"))).toBe("medium");
    expect(iconModeForSize(defaultIconSizeForMode("small"))).toBe("small");
  });
});

describe("偏好持久化", () => {
  it("默认值：大图标 + 日期降序 + 按日期分组", () => {
    expect(DEFAULT_PREFS).toMatchObject({
      mode: "large",
      iconSize: 160,
      sort: "date",
      order: "desc",
      group: "date",
      detailsPane: false,
    });
  });

  it("坏数据回退默认值", () => {
    expect(parseGalleryPrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parseGalleryPrefs("not json")).toEqual(DEFAULT_PREFS);
    expect(parseGalleryPrefs("[]")).toEqual(DEFAULT_PREFS);
    expect(parseGalleryPrefs('{"mode":"huge","iconSize":"x"}')).toEqual(
      DEFAULT_PREFS,
    );
  });

  it("合法字段保留并规整尺寸", () => {
    const raw = JSON.stringify({
      mode: "details",
      iconSize: 999,
      sort: "style",
      order: "asc",
      group: "size",
      detailsPane: true,
    });
    expect(parseGalleryPrefs(raw)).toEqual({
      mode: "details",
      iconSize: 320,
      sort: "style",
      order: "asc",
      group: "size",
      detailsPane: true,
    });
  });

  it("序列化可往返", () => {
    const prefs = {
      mode: "tiles" as const,
      iconSize: 192,
      sort: "type" as const,
      order: "asc" as const,
      group: "model" as const,
      detailsPane: true,
    };
    expect(parseGalleryPrefs(serializeGalleryPrefs(prefs))).toEqual(prefs);
  });
});

describe("排序", () => {
  const items = [
    item(1, { prompt: "banana", createdAt: "100", fileSize: 30 * 1024 * 1024 }),
    item(2, { prompt: "apple", createdAt: "300", fileSize: 0 }),
    item(3, { prompt: "cherry", createdAt: "200", fileSize: 2 * 1024 * 1024 }),
  ];

  it("日期默认降序", () => {
    expect(
      sortHistoryItems(items, "date", "desc").map((i) => i.history.id),
    ).toEqual([2, 3, 1]);
  });

  it("名称升序", () => {
    expect(
      sortHistoryItems(items, "name", "asc").map((i) => i.history.id),
    ).toEqual([2, 1, 3]);
  });

  it("大小 / 尺寸可排序", () => {
    expect(
      sortHistoryItems(items, "size", "asc").map((i) => i.history.id),
    ).toEqual([2, 3, 1]);
  });

  it("同值按 id 稳定", () => {
    const same = [item(9, { prompt: "x" }), item(4, { prompt: "x" })];
    expect(
      sortHistoryItems(same, "name", "asc").map((i) => i.history.id),
    ).toEqual([4, 9]);
  });

  it("点表头：同列切换方向，换列重新给默认方向", () => {
    expect(nextSortState("date", "date", "desc")).toEqual({
      sort: "date",
      order: "asc",
    });
    expect(nextSortState("name", "date", "desc")).toEqual({
      sort: "name",
      order: "asc",
    });
    expect(nextSortState("date", "name", "asc")).toEqual({
      sort: "date",
      order: "desc",
    });
  });
});

describe("分组", () => {
  const items = [
    item(1, { model: "flux", style: "ink", fileSize: 0, favorite: true }),
    item(2, { model: "flux", style: "ink", fileSize: 2 * 1024 * 1024 }),
    item(3, { model: "sdxl", style: "", fileSize: 30 * 1024 * 1024 }),
  ];

  it("无分组只返回一段无标题", () => {
    const sections = groupHistoryItems(items, "none");
    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe("");
    expect(sections[0].items).toHaveLength(3);
  });

  it("按模型相邻合并", () => {
    const sections = groupHistoryItems(items, "model");
    expect(sections.map((s) => s.label)).toEqual(["flux", "sdxl"]);
    expect(sections[0].items.map((i) => i.history.id)).toEqual([1, 2]);
  });

  it("按风格：空串回退未知风格", () => {
    const sections = groupHistoryItems(items, "style");
    expect(sections.map((s) => s.label)).toEqual(["ink", "未知风格"]);
  });

  it("按收藏", () => {
    expect(groupHistoryItems(items, "favorite").map((s) => s.label)).toEqual([
      "已收藏",
      "未收藏",
    ]);
  });

  it("按大小区间", () => {
    expect(groupHistoryItems(items, "size").map((s) => s.label)).toEqual([
      "未知大小",
      "1–5 MB",
      "大于 20 MB",
    ]);
  });

  it("按日期：同一天合并", () => {
    const sections = groupHistoryItems(
      [
        item(1, { createdAt: "1700000000" }),
        item(2, { createdAt: "1700000500" }),
      ],
      "date",
    );
    expect(sections).toHaveLength(1);
    expect(sections[0].label).not.toBe("");
  });
});

describe("行结构", () => {
  it("组头按排序流插入并按列切行", () => {
    const sections = groupHistoryItems([item(1), item(2), item(3)], "none");
    const rows = buildGalleryRows(sections, 2);
    expect(rows.map((row) => row.type)).toEqual(["items", "items"]);
    const [first, second] = rows;
    if (first.type !== "items" || second.type !== "items") {
      throw new Error("expected item rows");
    }
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
  });

  it("有分组时先插组头", () => {
    const sections = groupHistoryItems([item(1, { model: "a" })], "model");
    const rows = buildGalleryRows(sections, 4);
    expect(rows[0]).toMatchObject({
      type: "header",
      label: "a",
      count: 1,
    });
  });

  it("列数随宽度与图标尺寸变化", () => {
    expect(layoutForMode("large", 1000, 160).columns).toBeGreaterThan(1);
    expect(layoutForMode("list", 1000, 160)).toEqual({
      columns: 1,
      cellWidth: 1000,
    });
    const narrow = layoutForMode("xlarge", 300, 320);
    expect(narrow.columns).toBe(1);
  });

  it("行高与组头高度", () => {
    expect(rowHeightForMode("large", 160)).toBe(206);
    expect(rowHeightForMode("details", 160)).toBeGreaterThan(36);
    expect(GROUP_HEADER_HEIGHT).toBe(40);
  });
});

describe("查询与格式化", () => {
  it("首页游标为 null，空筛选不传", () => {
    expect(buildHistoryQuery({ sort: "date", order: "desc" })).toMatchObject({
      cursor: null,
      model: undefined,
      style: undefined,
      query: undefined,
      sort: "date",
      order: "desc",
    });
  });

  it("类型 / 风格排序原样透传给服务端（已支持全局排序）", () => {
    expect(buildHistoryQuery({ sort: "type", order: "asc" })).toMatchObject({
      sort: "type",
      order: "asc",
    });
    expect(buildHistoryQuery({ sort: "style", order: "asc" })).toMatchObject({
      sort: "style",
      order: "asc",
    });
  });

  it("搜索词去空白并透传游标", () => {
    expect(
      buildHistoryQuery({
        cursor: "c1",
        query: "  cat  ",
        model: "flux",
        favoriteOnly: true,
        sort: "size",
        order: "asc",
      }),
    ).toMatchObject({
      cursor: "c1",
      query: "cat",
      model: "flux",
      favoriteOnly: true,
      sort: "size",
      order: "asc",
    });
  });

  it("翻页按 id 去重", () => {
    const merged = appendHistoryItems([item(1)], [item(1), item(2)]);
    expect(merged.map((i) => i.history.id)).toEqual([1, 2]);
  });

  it("字节格式化", () => {
    expect(formatBytes(0)).toBe("—");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024 * 1024 * 2)).toBe("2.0 MB");
  });

  it("尺寸格式化", () => {
    expect(formatDimensions(0, 0)).toBe("—");
    expect(formatDimensions(1024, 768)).toBe("1024 × 768");
  });

  it("类型取文件扩展名", () => {
    expect(historyType(item(1, { filePath: "/a/b.gif" }))).toBe("GIF");
  });

  it("日期格式稳定", () => {
    expect(formatHistoryDate("1700000000")).toMatch(
      /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/,
    );
    expect(formatHistoryDate("bad")).toBe("—");
  });
});

describe("选项与详情列", () => {
  it("8 种视图 / 8 种排序 / 6 种分组", () => {
    expect(VIEW_OPTIONS).toHaveLength(8);
    expect(SORT_OPTIONS).toHaveLength(8);
  });

  it("详情列覆盖需求中的全部字段且可排序", () => {
    const keys = DETAILS_COLUMNS.map((column) => column.key);
    expect(keys).toEqual([
      "name",
      "date",
      "type",
      "size",
      "dimensions",
      "model",
      "style",
      "favorite",
    ]);
    const sorts = new Set<GallerySort>(SORT_OPTIONS.map((o) => o.value));
    for (const column of DETAILS_COLUMNS) {
      expect(sorts.has(column.sort)).toBe(true);
      expect(column.label.length).toBeGreaterThan(0);
    }
  });
});
