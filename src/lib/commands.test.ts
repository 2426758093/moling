import { describe, expect, it } from "vitest";
import { COMMANDS, Command, filterCommands } from "./commands";

const cmd = (
  over: Partial<Command> & { id: string; title: string },
): Command => ({
  group: "工具",
  run: () => undefined,
  ...over,
});

describe("filterCommands", () => {
  const list = [
    cmd({ id: "nav.chat", title: "打开聊天", keywords: ["对话"] }),
    cmd({ id: "nav.gallery", title: "打开画廊", keywords: ["作品"] }),
    cmd({ id: "chat.new", title: "新建对话", keywords: ["new"] }),
    cmd({ id: "tools.logs", title: "打开日志目录" }),
  ];

  it("前缀匹配排在包含匹配之前", () => {
    const result = filterCommands(list, "打开");
    expect(result.map((c) => c.id)).toEqual([
      "nav.chat",
      "nav.gallery",
      "tools.logs",
    ]);
  });

  it("标题包含查询也会命中", () => {
    expect(filterCommands(list, "画廊").map((c) => c.id)).toEqual([
      "nav.gallery",
    ]);
  });

  it("关键词前缀优先于关键词包含", () => {
    const keywords = [
      cmd({ id: "a", title: "甲", keywords: ["new"] }),
      cmd({ id: "b", title: "乙", keywords: ["renew"] }),
    ];
    expect(filterCommands(keywords, "new").map((c) => c.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("支持子序列匹配（如 nc 命中 New Canvas）", () => {
    const latin = [cmd({ id: "x", title: "New Canvas" })];
    expect(filterCommands(latin, "nc").map((c) => c.id)).toEqual(["x"]);
  });

  it("无匹配时返回空数组", () => {
    expect(filterCommands(list, "zzzz")).toEqual([]);
  });

  it("空查询把最近使用提到最前，其余保持原顺序", () => {
    const result = filterCommands(list, "", ["tools.logs", "nav.gallery"]);
    expect(result.map((c) => c.id)).toEqual([
      "tools.logs",
      "nav.gallery",
      "nav.chat",
      "chat.new",
    ]);
  });

  it("最近使用里的失效 id 被忽略且不重复", () => {
    const result = filterCommands(list, "", ["gone", "nav.chat", "nav.chat"]);
    expect(result.map((c) => c.id)).toEqual([
      "nav.chat",
      "nav.gallery",
      "chat.new",
      "tools.logs",
    ]);
  });
});

describe("命令清单", () => {
  it("命令 id 唯一", () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每条命令都有标题与执行函数", () => {
    for (const command of COMMANDS) {
      expect(command.title.length).toBeGreaterThan(0);
      expect(typeof command.run).toBe("function");
    }
  });
});
