import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import ProviderDialog from "./index";
import { resetPullCache } from "./modelPull";

const mockInvoke = vi.mocked(invoke);

/** 打开「新增服务商」并选中预设 */
function renderWithPreset(preset = "OpenAI") {
  render(<ProviderDialog initial={null} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: preset }));
}

function goNext() {
  fireEvent.click(screen.getByRole("button", { name: "下一步" }));
}

beforeEach(() => {
  mockInvoke.mockReset();
  resetPullCache();
});

describe("ProviderDialog 服务商配置向导", () => {
  it("默认停在基本信息步骤并展示关键字段", () => {
    render(<ProviderDialog initial={null} onClose={vi.fn()} />);

    expect(screen.getByText("新增服务商")).toBeTruthy();
    expect(screen.getByText(/基本信息/)).toBeTruthy();
    expect(screen.getByLabelText("名称")).toBeTruthy();
    expect(screen.getByLabelText("API 地址（Base URL）")).toBeTruthy();
    expect(screen.getByLabelText("API Key")).toBeTruthy();
  });

  it("取消按钮只关闭弹窗，不触发保存", () => {
    const onClose = vi.fn();
    render(<ProviderDialog initial={null} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
  });

  it("选择预设填充名称与地址，不填 Key 并展示推荐", () => {
    renderWithPreset("OpenAI");

    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe(
      "OpenAI",
    );
    expect(
      (screen.getByLabelText("API 地址（Base URL）") as HTMLInputElement).value,
    ).toBe("https://api.openai.com/v1");
    expect((screen.getByLabelText("API Key") as HTMLInputElement).value).toBe(
      "",
    );
    expect(screen.getByText(/推荐模型：gpt-image-1/)).toBeTruthy();
  });

  it("本地预设允许空 Key", () => {
    renderWithPreset("Ollama");

    expect(
      (screen.getByLabelText("API 地址（Base URL）") as HTMLInputElement).value,
    ).toBe("http://localhost:11434/v1");
    expect(screen.getByText("本地服务可以不填 Key")).toBeTruthy();
  });

  it("进入模型步骤自动拉取一次，返回上一步再进入不重复请求", async () => {
    mockInvoke.mockResolvedValue(["gpt-image-1", "dall-e-3"]);
    renderWithPreset();
    goNext();

    await screen.findByRole("button", { name: "把 gpt-image-1 设为默认模型" });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    // 默认模型推荐优先图像模型
    expect(
      screen
        .getByRole("button", { name: "把 gpt-image-1 设为默认模型" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "上一步" }));
    goNext();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("测试连接期间重复点击只请求一次", async () => {
    let resolveModels: (value: string[]) => void = () => undefined;
    mockInvoke.mockImplementation(
      () =>
        new Promise<string[]>((resolve) => {
          resolveModels = resolve;
        }),
    );
    renderWithPreset();

    const button = screen.getByRole("button", { name: "测试连接" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveModels(["dall-e-3"]);
      await Promise.resolve();
    });
    expect(screen.getByText(/连接正常/)).toBeTruthy();
  });

  it("重新拉取强制请求，并保留仍存在的默认模型与能力修改", async () => {
    let calls = 0;
    mockInvoke.mockImplementation(() => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? ["gpt-image-1", "dall-e-3"]
          : ["dall-e-3", "gpt-image-2.6"],
      );
    });
    renderWithPreset();
    goNext();

    await screen.findByRole("button", { name: "把 dall-e-3 设为默认模型" });
    fireEvent.click(
      screen.getByRole("button", { name: "把 dall-e-3 设为默认模型" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /模型能力/ }));
    const negativeSwitch = screen.getByRole("switch", {
      name: "dall-e-3 负向提示词",
    });
    fireEvent.click(negativeSwitch);
    expect(negativeSwitch.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "重新拉取" }));
    await screen.findByRole("button", {
      name: "把 gpt-image-2.6 设为默认模型",
    });

    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(
      screen
        .getByRole("button", { name: "把 dall-e-3 设为默认模型" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen
        .getByRole("switch", { name: "dall-e-3 负向提示词" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.queryByRole("switch", { name: "gpt-image-1 负向提示词" }),
    ).toBeNull();
  });

  it("模型搜索与图像筛选只保留匹配项", async () => {
    mockInvoke.mockResolvedValue([
      "gpt-image-1",
      "dall-e-3",
      "text-embedding-3-large",
    ]);
    renderWithPreset();
    goNext();

    await screen.findByRole("button", { name: "把 dall-e-3 设为默认模型" });
    const search = screen.getByLabelText("搜索模型");
    fireEvent.change(search, { target: { value: "dall" } });
    expect(
      screen.queryByRole("button", { name: "把 gpt-image-1 设为默认模型" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "把 dall-e-3 设为默认模型" }),
    ).toBeTruthy();

    fireEvent.change(search, { target: { value: "" } });
    fireEvent.click(screen.getByRole("radio", { name: "图像" }));
    expect(
      screen.queryByRole("button", {
        name: "把 text-embedding-3-large 设为默认模型",
      }),
    ).toBeNull();
  });

  it("丢弃过期拉取响应", async () => {
    const pending: Record<string, (value: string[]) => void> = {};
    mockInvoke.mockImplementation((_cmd, args) => {
      const url =
        (args as { input?: { baseUrl?: string } } | undefined)?.input
          ?.baseUrl ?? "";
      return new Promise<string[]>((resolve) => {
        pending[url] = resolve;
      });
    });
    renderWithPreset();
    goNext();
    await waitFor(() => {
      expect(pending["https://api.openai.com/v1"]).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "上一步" }));
    fireEvent.change(screen.getByLabelText("API 地址（Base URL）"), {
      target: { value: "https://api.example.com/v1" },
    });
    goNext();
    await waitFor(() => {
      expect(pending["https://api.example.com/v1"]).toBeTruthy();
    });

    await act(async () => {
      pending["https://api.openai.com/v1"](["old-model"]);
      await Promise.resolve();
    });
    await act(async () => {
      pending["https://api.example.com/v1"](["new-model"]);
      await Promise.resolve();
    });

    expect(
      screen.getByRole("button", { name: "把 new-model 设为默认模型" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "把 old-model 设为默认模型" }),
    ).toBeNull();
  });

  it("没有模型时禁用保存并提示", async () => {
    mockInvoke.mockResolvedValue([]);
    renderWithPreset();
    goNext();
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });
    goNext();

    const save = screen.getByRole("button", {
      name: "保存",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(
      screen.getByText("还没有可用模型，请返回上一步拉取或检查地址与 Key。"),
    ).toBeTruthy();
  });

  it("模板类型无模型也允许保存", () => {
    renderWithPreset("自定义模板");
    goNext();
    goNext();

    const save = screen.getByRole("button", {
      name: "保存",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
  });

  it("拉取失败展示错误结论、重试与复制", async () => {
    mockInvoke.mockRejectedValue(
      '{"type":"auth_invalid","message":"HTTP 401"}',
    );
    renderWithPreset();
    goNext();

    expect(await screen.findByText("Key 无效，请检查 API Key")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制" })).toBeTruthy();
  });
});
