import { describe, expect, it } from "vitest";
import {
  analysisSuggestionText,
  autoOps,
  BEAUTY_SHARPEN_AMOUNT,
  beautyOps,
  DEFAULT_AUTO_STRENGTH,
  DEFAULT_BEAUTY_AMOUNT,
  isCloudRetouchAction,
  isLocalRetouchAction,
  outputStepDims,
  resolveEditInputSize,
  retouchActionReason,
  RETOUCH_ACTIONS,
  stepLabelForOp,
  type RetouchGateCtx,
} from "./retouchActions";

const PERFECT: RetouchGateCtx = {
  hasProvider: true,
  hasModel: true,
  instructionEdit: true,
  edit: true,
  isGif: false,
  online: true,
};

describe("RETOUCH_ACTIONS", () => {
  it("只暴露 v2.1.0 的四个动作，本地/云标记正确", () => {
    expect(RETOUCH_ACTIONS.map((a) => a.id)).toEqual([
      "auto",
      "beauty",
      "erase",
      "instruction",
    ]);
    expect(RETOUCH_ACTIONS.filter((a) => a.cloud).map((a) => a.id)).toEqual([
      "erase",
      "instruction",
    ]);
  });

  it("本地动作判定只认 auto / beauty", () => {
    expect(isLocalRetouchAction("auto")).toBe(true);
    expect(isLocalRetouchAction("beauty")).toBe(true);
    expect(isLocalRetouchAction("erase")).toBe(false);
    expect(isLocalRetouchAction("instruction")).toBe(false);
  });
});

describe("retouchActionReason", () => {
  it("服务商/模型/能力齐备时四个动作都可用", () => {
    for (const action of RETOUCH_ACTIONS) {
      expect(retouchActionReason(action.id, PERFECT)).toBeNull();
    }
  });

  it("本地动作在离线、无服务商、无模型、无能力时依然可用", () => {
    const bare: RetouchGateCtx = {
      hasProvider: false,
      hasModel: false,
      instructionEdit: false,
      edit: false,
      isGif: false,
      online: false,
    };
    expect(retouchActionReason("auto", bare)).toBeNull();
    expect(retouchActionReason("beauty", bare)).toBeNull();
  });

  it("动图优先于一切，本地动作也不放行", () => {
    const gif: RetouchGateCtx = { ...PERFECT, isGif: true };
    for (const action of RETOUCH_ACTIONS) {
      expect(retouchActionReason(action.id, gif)).toBe("动图暂不支持修图");
    }
    expect(
      retouchActionReason("auto", {
        ...gif,
        online: false,
        hasProvider: false,
      }),
    ).toBe("动图暂不支持修图");
  });

  it("云动作按 离线 → 服务商 → 模型 → 能力 的顺序给原因", () => {
    const offline: RetouchGateCtx = { ...PERFECT, online: false };
    expect(retouchActionReason("erase", offline)).toBe("当前离线");
    expect(retouchActionReason("instruction", offline)).toBe("当前离线");

    const noProvider: RetouchGateCtx = { ...PERFECT, hasProvider: false };
    expect(retouchActionReason("erase", noProvider)).toBe(
      "请先在设置中配置服务商",
    );
    expect(retouchActionReason("instruction", noProvider)).toBe(
      "请先在设置中配置服务商",
    );

    const noModel: RetouchGateCtx = { ...PERFECT, hasModel: false };
    expect(retouchActionReason("erase", noModel)).toBe(
      "请先在设置中选择默认模型",
    );
    expect(retouchActionReason("instruction", noModel)).toBe(
      "请先在设置中选择默认模型",
    );
  });

  it("instructionEdit 只影响一句话改图", () => {
    const noInstruction: RetouchGateCtx = {
      ...PERFECT,
      instructionEdit: false,
    };
    expect(retouchActionReason("instruction", noInstruction)).toBe(
      "当前模型不支持指令改图",
    );
    expect(retouchActionReason("erase", noInstruction)).toBeNull();
  });

  it("edit 只影响 AI 消除", () => {
    const noEdit: RetouchGateCtx = { ...PERFECT, edit: false };
    expect(retouchActionReason("erase", noEdit)).toBe("当前模型不支持局部编辑");
    expect(retouchActionReason("instruction", noEdit)).toBeNull();
  });
});

describe("本地动作参数", () => {
  it("一键优化只有一个 autoEnhance，且夹在 0–1", () => {
    expect(autoOps(DEFAULT_AUTO_STRENGTH)).toEqual([
      { type: "autoEnhance", strength: 1 },
    ]);
    expect(autoOps(0)).toEqual([{ type: "autoEnhance", strength: 0 }]);
    expect(autoOps(2)).toEqual([{ type: "autoEnhance", strength: 1 }]);
    expect(autoOps(-1)).toEqual([{ type: "autoEnhance", strength: 0 }]);
    expect(autoOps(Number.NaN)).toEqual([{ type: "autoEnhance", strength: 0 }]);
  });

  it("美颜是磨皮 + 固定锐化", () => {
    expect(beautyOps(DEFAULT_BEAUTY_AMOUNT)).toEqual([
      { type: "skinSmooth", amount: 0.6 },
      { type: "sharpen", amount: BEAUTY_SHARPEN_AMOUNT },
    ]);
  });
});

describe("analysisSuggestionText", () => {
  const base = { exposureEv: 0, wbCast: 0 };

  it("曝光与白平衡按符号给方向", () => {
    expect(
      analysisSuggestionText("exposure", { ...base, exposureEv: 0.4 }),
    ).toBe("偏暗");
    expect(
      analysisSuggestionText("exposure", { ...base, exposureEv: -0.4 }),
    ).toBe("偏亮");
    expect(
      analysisSuggestionText("whiteBalance", { ...base, wbCast: 0.2 }),
    ).toBe("偏暖");
    expect(
      analysisSuggestionText("whiteBalance", { ...base, wbCast: -0.2 }),
    ).toBe("偏冷");
  });

  it("其余建议是固定文案", () => {
    expect(analysisSuggestionText("contrast", base)).toBe("对比偏低");
    expect(analysisSuggestionText("saturation", base)).toBe("色彩偏淡");
    expect(analysisSuggestionText("skin", base)).toBe("检测到人像");
    expect(analysisSuggestionText("clipping", base)).toBe("有过曝或死黑");
  });
});

describe("云端尺寸口径", () => {
  it("本地动作不用上报尺寸，云动作要", () => {
    expect(isCloudRetouchAction("auto")).toBe(false);
    expect(isCloudRetouchAction("beauty")).toBe(false);
    expect(isCloudRetouchAction("erase")).toBe(true);
    expect(isCloudRetouchAction("instruction")).toBe(true);
  });

  it("编辑输入尺寸优先用步骤记录，其次用现场解码结果", () => {
    expect(
      resolveEditInputSize(
        { width: 800, height: 600 },
        { width: 1, height: 1 },
      ),
    ).toEqual({ width: 800, height: 600 });
    expect(resolveEditInputSize({}, { width: 1024, height: 768 })).toEqual({
      width: 1024,
      height: 768,
    });
  });

  it("两处都量不到时返回 null（调用方必须拒绝提交，不发 0×0）", () => {
    expect(resolveEditInputSize({}, null)).toBeNull();
    expect(resolveEditInputSize({ width: 0, height: 0 }, null)).toBeNull();
    expect(resolveEditInputSize({ width: 800 }, null)).toBeNull();
    expect(
      resolveEditInputSize({}, { width: Number.NaN, height: 600 }),
    ).toBeNull();
  });

  it("步骤记录半残时不和现场解码拼尺寸", () => {
    // 只有宽度时整对作废：混用会得到非等比的一对数字
    expect(
      resolveEditInputSize({ width: 800 }, { width: 1024, height: 768 }),
    ).toEqual({ width: 1024, height: 768 });
  });

  it("旧历史行横竖颠倒时以实测尺寸为准", () => {
    // 入库时没摆正：记录的是 4000×3000，实际像素是 3000×4000
    expect(
      resolveEditInputSize(
        { width: 4000, height: 3000 },
        { width: 3000, height: 4000 },
        true,
      ),
    ).toEqual({ width: 3000, height: 4000 });
  });

  it("实测与记录一致时仍用记录（不清空已有口径）", () => {
    expect(
      resolveEditInputSize(
        { width: 800, height: 600 },
        { width: 800, height: 600 },
        true,
      ),
    ).toEqual({ width: 800, height: 600 });
    // 默认（不偏好实测）时沿用旧口径：记录优先
    expect(
      resolveEditInputSize(
        { width: 800, height: 600 },
        { width: 1, height: 1 },
      ),
    ).toEqual({ width: 800, height: 600 });
  });

  it("实测无效时回退记录；记录缺失时用实测", () => {
    expect(
      resolveEditInputSize({ width: 800, height: 600 }, null, true),
    ).toEqual({ width: 800, height: 600 });
    expect(
      resolveEditInputSize(
        { width: 800, height: 600 },
        { width: 0, height: 0 },
        true,
      ),
    ).toEqual({ width: 800, height: 600 });
    expect(
      resolveEditInputSize({}, { width: 3000, height: 4000 }, true),
    ).toEqual({ width: 3000, height: 4000 });
    expect(resolveEditInputSize({}, null, true)).toBeNull();
  });

  it("新步骤尺寸只认量到的值，量不到就留空（绝不回填输入尺寸）", () => {
    expect(outputStepDims({ width: 512, height: 512 })).toEqual({
      width: 512,
      height: 512,
    });
    expect(outputStepDims(null)).toEqual({});
    expect(outputStepDims({ width: 0, height: 0 })).toEqual({});
    expect(outputStepDims({ width: 512.6, height: 511.4 })).toEqual({
      width: 513,
      height: 511,
    });
  });
});

describe("stepLabelForOp", () => {
  it("首帧固定原图，其余按 Rust 写的 op 映射", () => {
    expect(stepLabelForOp("auto-enhance", 0)).toBe("原图");
    expect(stepLabelForOp("generate", 1)).toBe("编辑");
    expect(stepLabelForOp("auto-enhance", 1)).toBe("一键优化");
    expect(stepLabelForOp("beauty", 2)).toBe("美颜");
    expect(stepLabelForOp("erase", 3)).toBe("AI 消除");
    expect(stepLabelForOp("retouch", 4)).toBe("一句话改图");
  });

  it("认不出的 op（画布导出 / 基础编辑等）记作编辑", () => {
    expect(stepLabelForOp("basic-edit", 1)).toBe("编辑");
    expect(stepLabelForOp("canvas", 2)).toBe("编辑");
    expect(stepLabelForOp("upscale", 3)).toBe("编辑");
    expect(stepLabelForOp("", 4)).toBe("编辑");
  });
});
