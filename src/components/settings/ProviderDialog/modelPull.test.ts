import { beforeEach, describe, expect, it } from "vitest";
import {
  filterAndSortModels,
  hashKey,
  isImageModel,
  PULL_CACHE_TTL_MS,
  pullSignature,
  readPullCache,
  recommendDefaultModel,
  resetPullCache,
  writePullCache,
} from "./modelPull";

const MODELS = [
  "gpt-image-1",
  "dall-e-3",
  "flux-dev",
  "text-embedding-3-large",
];

describe("模型拉取签名与缓存", () => {
  beforeEach(() => {
    resetPullCache();
  });

  it("签名忽略地址末尾斜杠，且不泄露明文 Key", () => {
    const a = pullSignature(
      {
        baseUrl: "https://api.openai.com/v1/",
        kind: "openai",
        apiKey: "sk-secret",
      },
      null,
      false,
    );
    const b = pullSignature(
      {
        baseUrl: "https://api.openai.com/v1",
        kind: "openai",
        apiKey: "sk-secret",
      },
      null,
      false,
    );
    expect(a).toBe(b);
    expect(a).not.toContain("sk-secret");
    expect(a).toContain(hashKey("sk-secret"));
  });

  it("地址、类型或 Key 变化都会生成新签名", () => {
    const base = pullSignature(
      { baseUrl: "https://api.openai.com/v1", kind: "openai", apiKey: "a" },
      null,
      false,
    );
    const otherUrl = pullSignature(
      { baseUrl: "https://api.openai.com/v1beta", kind: "openai", apiKey: "a" },
      null,
      false,
    );
    const otherKind = pullSignature(
      { baseUrl: "https://api.openai.com/v1", kind: "mock", apiKey: "a" },
      null,
      false,
    );
    const otherKey = pullSignature(
      { baseUrl: "https://api.openai.com/v1", kind: "openai", apiKey: "b" },
      null,
      false,
    );
    expect(new Set([base, otherUrl, otherKind, otherKey]).size).toBe(4);
  });

  it("已存 Key 的签名只记 providerId，不接触明文", () => {
    const signature = pullSignature(
      { baseUrl: "https://api.openai.com/v1", kind: "openai", apiKey: "" },
      7,
      true,
    );
    expect(signature).toContain("saved:7");
  });

  it("30 秒内命中缓存，超时后失效", () => {
    const signature = "openai|https://api.example.com/v1|none";
    writePullCache(signature, MODELS, 1_000);
    expect(readPullCache(signature, 1_000 + PULL_CACHE_TTL_MS)).toEqual(MODELS);
    expect(readPullCache(signature, 1_001 + PULL_CACHE_TTL_MS)).toBeNull();
  });
});

describe("模型推荐与筛选", () => {
  it("图像模型识别与默认推荐优先图像模型", () => {
    expect(isImageModel("gpt-image-1")).toBe(true);
    expect(isImageModel("dall-e-3")).toBe(true);
    expect(isImageModel("flux-dev")).toBe(true);
    expect(isImageModel("text-embedding-3-large")).toBe(false);
    expect(recommendDefaultModel(MODELS)).toBe("gpt-image-1");
    expect(recommendDefaultModel(["text-embedding-3-large"])).toBe(
      "text-embedding-3-large",
    );
    expect(recommendDefaultModel([])).toBe("");
  });

  it("搜索、图像过滤与排序互不干扰", () => {
    expect(
      filterAndSortModels(MODELS, {
        query: "dall",
        filter: "all",
        sort: "default",
      }),
    ).toEqual(["dall-e-3"]);

    expect(
      filterAndSortModels(MODELS, {
        query: "",
        filter: "image",
        sort: "default",
      }),
    ).toEqual(["gpt-image-1", "dall-e-3", "flux-dev"]);

    expect(
      filterAndSortModels(MODELS, {
        query: "",
        filter: "all",
        sort: "name",
      }),
    ).toEqual([
      "dall-e-3",
      "flux-dev",
      "gpt-image-1",
      "text-embedding-3-large",
    ]);
  });

  it("推荐筛选优先用预设声明的模型，缺省时退回图像模型", () => {
    expect(
      filterAndSortModels(MODELS, {
        query: "",
        filter: "recommended",
        sort: "default",
        recommended: ["dall-e-3"],
      }),
    ).toEqual(["dall-e-3"]);

    expect(
      filterAndSortModels(MODELS, {
        query: "",
        filter: "recommended",
        sort: "default",
        recommended: [],
      }),
    ).toEqual(["gpt-image-1", "dall-e-3", "flux-dev"]);
  });

  it("推荐优先排序把图像模型排在前面", () => {
    const result = filterAndSortModels(MODELS, {
      query: "",
      filter: "all",
      sort: "recommended",
    });
    expect(result[result.length - 1]).toBe("text-embedding-3-large");
    expect(result.slice(0, 3)).toEqual(["dall-e-3", "flux-dev", "gpt-image-1"]);
  });
});
