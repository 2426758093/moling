import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, EMPTY_PROVIDER, type ProviderItem } from "../lib/api";
import { toast } from "../lib/notify";
import { useChatStore, type DisplayMessage } from "./chatStore";
import { useProviderStore } from "./providerStore";

vi.mock("../lib/notify", () => ({ toast: vi.fn() }));

const providerItem = (): ProviderItem => ({
  provider: {
    ...EMPTY_PROVIDER,
    id: 1,
    name: "测试服务商",
    baseUrl: "http://127.0.0.1:8000",
    defaultModel: "test-model",
  },
  apiKeyMasked: "sk-***",
  hasKey: true,
  keyError: false,
  keyCount: 1,
  invalidKeyCount: 0,
  keys: [],
});

const display = (
  over: Partial<DisplayMessage> &
    Pick<DisplayMessage, "id" | "role" | "content">,
): DisplayMessage => ({
  refined: "",
  thinkingUsed: false,
  attachments: [],
  images: [],
  pendingImages: 0,
  status: "done",
  error: null,
  ...over,
});

function resetStores() {
  useChatStore.setState({
    conversations: [],
    conversationsLoaded: false,
    activeId: null,
    messages: [],
    hasMore: false,
    loadingOlder: false,
    attachments: [],
    sending: false,
    stopRequested: false,
    draftPrompt: null,
  });
  useProviderStore.setState({
    providers: [providerItem()],
    loaded: true,
    defaultProviderId: 1,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStores();
  vi.spyOn(api, "listConversations").mockResolvedValue({ conversations: [] });
  vi.spyOn(api, "createConversation").mockResolvedValue(7);
  vi.spyOn(api, "addMessage").mockResolvedValue({ id: 11, imagesJson: "[]" });
  vi.spyOn(api, "refinePrompt").mockResolvedValue({ refined: "", used: false });
  vi.spyOn(api, "generateImages").mockResolvedValue({ images: [] });
  vi.spyOn(api, "deleteMessage").mockResolvedValue(true);
});

describe("send 的受理结果（F-008）", () => {
  it("未配置服务商时返回 false，并给出提示", async () => {
    useProviderStore.setState({ providers: [], defaultProviderId: null });

    const result = await useChatStore.getState().send("你好");

    expect(result).toBe(false);
    expect(useChatStore.getState().sending).toBe(false);
    expect(vi.mocked(toast)).toHaveBeenCalledWith(
      "请先在「设置」中配置绘图服务商与模型",
      "error",
    );
  });

  it("正在发送时直接返回 false", async () => {
    useChatStore.setState({ sending: true });

    expect(await useChatStore.getState().send("你好")).toBe(false);
  });

  it("成功落位返回 true，assistant 占位最终换成后端 id", async () => {
    const addMessage = vi.mocked(api.addMessage);
    addMessage.mockReset();
    addMessage.mockResolvedValueOnce({ id: 11, imagesJson: "[]" });
    addMessage.mockResolvedValueOnce({ id: 12, imagesJson: "[]" });

    const result = await useChatStore.getState().send("画一只猫");

    expect(result).toBe(true);
    const state = useChatStore.getState();
    expect(state.sending).toBe(false);
    expect(state.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(state.messages[1].id).toBe(12);
    expect(addMessage).toHaveBeenCalledTimes(2);
  });
});

describe("跨 await 的会话守卫（F-007）", () => {
  it("createConversation 在途时切走会话，不把本轮消息写进新会话", async () => {
    const create = vi.mocked(api.createConversation);
    create.mockReset();
    let resolveCreate!: (id: number) => void;
    create.mockReturnValueOnce(
      new Promise<number>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    create.mockResolvedValueOnce(99);

    const pendingSend = useChatStore.getState().send("旧会话消息");
    await useChatStore.getState().newConversation();
    resolveCreate(7);
    const result = await pendingSend;

    // 消息已入库：对调用方算「已受理」，否则 Composer 会回填草稿、用户重发造成重复
    expect(result).toBe(true);
    const state = useChatStore.getState();
    expect(state.activeId).toBe(99);
    expect(state.messages).toEqual([]);
    expect(state.sending).toBe(false);
    expect(vi.mocked(api.addMessage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.addMessage).mock.calls[0][0].conversationId).toBe(7);
  });
});

describe("按 id 重试指定回复（F-009）", () => {
  it("重试被点击的最后一条回复，并保留更早的轮次", async () => {
    useChatStore.setState({
      activeId: 7,
      messages: [
        display({ id: 1, role: "user", content: "第一轮" }),
        display({
          id: 2,
          role: "assistant",
          content: "第一轮结果",
          images: [
            {
              historyId: 9,
              dataUrl: "data:image/png;base64,AA",
              prompt: "第一轮",
              seed: null,
            },
          ],
        }),
        display({ id: 3, role: "user", content: "第二轮" }),
        display({
          id: 4,
          role: "assistant",
          content: "第二轮失败",
          status: "error",
          error: { type: "network", message: "boom" },
        }),
      ],
    });
    const addMessage = vi.mocked(api.addMessage);
    addMessage.mockReset();
    addMessage.mockResolvedValue({ id: 44, imagesJson: "[]" });

    await useChatStore.getState().retryLast(4);

    expect(vi.mocked(api.deleteMessage)).toHaveBeenCalledWith(4);
    const messages = useChatStore.getState().messages;
    expect(messages.map((m) => m.id)).toEqual([1, 2, 3, 44]);
    expect(messages[3].role).toBe("assistant");
    expect(messages[3].content).toBe("第二轮");
  });

  it("目标之后还有更新的用户消息时拒绝重试", async () => {
    useChatStore.setState({
      activeId: 7,
      messages: [
        display({ id: 1, role: "user", content: "第一轮" }),
        display({ id: 2, role: "assistant", content: "第一轮结果" }),
        display({ id: 3, role: "user", content: "第二轮" }),
        display({
          id: 4,
          role: "assistant",
          content: "第二轮失败",
          status: "error",
          error: { type: "network", message: "boom" },
        }),
      ],
    });

    await useChatStore.getState().retryLast(2);

    expect(vi.mocked(toast)).toHaveBeenCalledWith(
      "仅能重试最新一轮对话",
      "error",
    );
    expect(vi.mocked(api.deleteMessage)).not.toHaveBeenCalled();
    expect(useChatStore.getState().sending).toBe(false);
  });

  it("目标之后没有用户消息但不是最后一条时拒绝重试", async () => {
    useChatStore.setState({
      activeId: 7,
      messages: [
        display({ id: 1, role: "user", content: "第一轮" }),
        display({ id: 2, role: "assistant", content: "第一轮结果" }),
        display({ id: 3, role: "assistant", content: "追加的图片消息" }),
      ],
    });

    await useChatStore.getState().retryLast(2);

    expect(vi.mocked(toast)).toHaveBeenCalledWith(
      "仅能重试最新一条回复",
      "error",
    );
    expect(vi.mocked(api.deleteMessage)).not.toHaveBeenCalled();
  });

  it("目标是用户消息或不存在时直接返回", async () => {
    useChatStore.setState({
      activeId: 7,
      messages: [
        display({ id: 1, role: "user", content: "第一轮" }),
        display({ id: 2, role: "assistant", content: "第一轮结果" }),
      ],
    });

    await useChatStore.getState().retryLast(1);
    await useChatStore.getState().retryLast(999);

    expect(vi.mocked(toast)).not.toHaveBeenCalled();
    expect(vi.mocked(api.deleteMessage)).not.toHaveBeenCalled();
    expect(useChatStore.getState().sending).toBe(false);
  });
});
