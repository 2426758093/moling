import { describe, expect, it } from "vitest";
import { ModelCaps } from "../../../lib/api";
import { DEFAULT_MODEL_CAPS } from "../../../lib/useModelCaps";
import { keepDefaultModel, pruneCapsEdits } from "./caps";

const CAPS: ModelCaps = { ...DEFAULT_MODEL_CAPS, negative: false };

describe("重新拉取后的选择保留", () => {
  it("只保留仍存在模型的能力修改", () => {
    expect(
      pruneCapsEdits({ "gpt-image-1": CAPS, "dall-e-3": CAPS }, ["dall-e-3"]),
    ).toEqual({ "dall-e-3": CAPS });
  });

  it("仍存在的默认模型在重新拉取后保留", () => {
    expect(
      keepDefaultModel(["dall-e-3", "gpt-image-2.6"], "dall-e-3", true),
    ).toBe("dall-e-3");
  });

  it("默认模型消失时按推荐规则重选（优先图像模型）", () => {
    expect(
      keepDefaultModel(
        ["text-embedding-3-large", "gpt-image-1"],
        "removed-model",
        true,
      ),
    ).toBe("gpt-image-1");
  });

  it("用户主动选择「未选择」时重新拉取不重置为空推荐值", () => {
    expect(keepDefaultModel(["dall-e-3"], "", false)).toBe("");
  });

  it("首次拉取自动补推荐默认值", () => {
    expect(keepDefaultModel(["text-embedding", "dall-e-3"], "", true)).toBe(
      "dall-e-3",
    );
  });
});
