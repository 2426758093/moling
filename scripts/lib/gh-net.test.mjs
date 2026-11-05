import { describe, expect, it } from "vitest";
import { dedupe, parseGithubRemote } from "./gh-net.mjs";

describe("parseGithubRemote", () => {
  it("识别 https 地址并去掉 .git", () => {
    expect(
      parseGithubRemote("https://github.com/2426758093/moling.git"),
    ).toEqual({
      owner: "2426758093",
      repo: "moling",
      httpsUrl: "https://github.com/2426758093/moling",
    });
  });

  it("识别 ssh 地址", () => {
    expect(parseGithubRemote("git@github.com:owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
      httpsUrl: "https://github.com/owner/repo",
    });
  });

  it("忽略大小写与末尾斜杠", () => {
    expect(parseGithubRemote("https://GitHub.com/Owner/Repo/")).toMatchObject({
      owner: "Owner",
      repo: "Repo",
    });
  });

  it("拒绝非 GitHub 地址", () => {
    expect(parseGithubRemote("https://gitlab.com/owner/repo.git")).toBeNull();
    expect(parseGithubRemote("origin")).toBeNull();
    expect(parseGithubRemote("")).toBeNull();
  });
});

describe("dedupe", () => {
  it("保序去重", () => {
    expect(dedupe(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });
});
