import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, EMPTY_PROVIDER, type ProviderItem } from "../lib/api";
import { toast } from "../lib/notify";
import { useAppStore } from "./appStore";
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
  vi.spyOn(api, "generateImages").mockResolvedValue({ images: [] });
  vi.spyOn(api, "deleteMessage").mockResolvedValue(true);
  vi.spyOn(api, "generateConversationTitle").mockResolvedValue({
    ok: false,
    skipped: true,
  });
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

describe("生成前的提示词处理（原文直达）", () => {
  const generated = (historyId: number, dataUrl: string) => ({
    historyId,
    dataUrl,
    prompt: "上一轮",
    seed: null,
  });

  beforeEach(() => {
    useAppStore.setState({ mode: "expert" });
  });

  it("跳过的前置改写不再调用思考模型，原文直接交给绘图模型", async () => {
    const refine = vi.spyOn(api, "refinePrompt");

    await useChatStore.getState().send("画一只橘猫");

    expect(refine).not.toHaveBeenCalled();
    const input = vi.mocked(api.generateImages).mock.calls[0][0];
    expect(input.prompt).toBe("画一只橘猫");
    expect(input.images).toEqual([]);
  });

  it("没有新参考图时，上一轮画面作为 previous 上下文一起传入", async () => {
    useChatStore.setState({
      activeId: 7,
      messages: [
        display({ id: 1, role: "user", content: "一只橘猫" }),
        display({
          id: 2,
          role: "assistant",
          content: "一只橘猫",
          images: [generated(9, "data:image/png;base64,PREV")],
        }),
      ],
    });

    await useChatStore.getState().send("把背景换成蓝色");

    const input = vi.mocked(api.generateImages).mock.calls[0][0];
    expect(input.prompt).toBe("把背景换成蓝色");
    expect(input.images).toEqual(["data:image/png;base64,PREV"]);
    expect(input.references).toEqual([{ role: "previous", strength: 60 }]);
  });

  it("带新参考图时同时带上上一轮画面，二者都进入请求", async () => {
    useChatStore.setState({
      activeId: 7,
      attachments: [
        {
          id: "a1",
          dataUrl: "data:image/png;base64,NEW",
          name: "new.png",
          path: "/tmp/new.png",
        },
      ],
      messages: [
        display({
          id: 2,
          role: "assistant",
          content: "一只橘猫",
          images: [generated(9, "data:image/png;base64,PREV")],
        }),
      ],
    });

    await useChatStore.getState().send("参考这张画一只狗");

    const input = vi.mocked(api.generateImages).mock.calls[0][0];
    expect(input.images).toEqual([
      "data:image/png;base64,NEW",
      "data:image/png;base64,PREV",
    ]);
    expect(input.references).toEqual([
      { role: "composition", strength: 60 },
      { role: "previous", strength: 60 },
    ]);
  });

  it("参考图占满上限时优先保留用户选择的图，不追加上一轮画面", async () => {
    useChatStore.setState({
      activeId: 7,
      attachments: Array.from({ length: 4 }, (_, i) => ({
        id: `a${i}`,
        dataUrl: `data:image/png;base64,NEW${i}`,
        name: `${i}.png`,
        path: `/tmp/${i}.png`,
      })),
      messages: [
        display({
          id: 2,
          role: "assistant",
          content: "一只橘猫",
          images: [generated(9, "data:image/png;base64,PREV")],
        }),
      ],
    });

    await useChatStore.getState().send("综合这些参考图");

    const input = vi.mocked(api.generateImages).mock.calls[0][0];
    expect(input.images).toHaveLength(4);
    expect(input.images).not.toContain("data:image/png;base64,PREV");
  });
});

describe("首条消息后生成会话标题", () => {
  it("空会话的首条消息触发 AI 标题并回写会话列表", async () => {
    vi.mocked(api.generateConversationTitle).mockResolvedValue({
      ok: true,
      title: "橘猫宇航员",
    });
    useChatStore.setState({
      activeId: 7,
      conversations: [{ id: 7, title: "新对话", createdAt: "1" }],
    });
    // 卡住生成尾声，观察标题回写（结束后 store 会重新拉会话列表）
    let finish!: (v: { images: [] }) => void;
    vi.mocked(api.generateImages).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );

    const pending = useChatStore.getState().send("画一只穿宇航服的橘猫");

    await vi.waitFor(() => {
      expect(api.generateConversationTitle).toHaveBeenCalledWith(
        7,
        "画一只穿宇航服的橘猫",
      );
      expect(
        useChatStore.getState().conversations.find((c) => c.id === 7)?.title,
      ).toBe("橘猫宇航员");
    });
    finish({ images: [] });
    await pending;
  });

  it("已有标题的会话不再触发标题生成", async () => {
    useChatStore.setState({
      activeId: 7,
      conversations: [{ id: 7, title: "旧标题", createdAt: "1" }],
      messages: [display({ id: 1, role: "user", content: "上一轮" })],
    });

    await useChatStore.getState().send("继续画");

    expect(api.generateConversationTitle).not.toHaveBeenCalled();
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

describe("生成过程中切换会话", () => {
  it("切到新会话再切回原会话，占位与最终结果都还在", async () => {
    vi.mocked(api.createConversation).mockResolvedValue(99);
    vi.spyOn(api, "listMessages").mockResolvedValue({
      messages: [
        {
          id: 11,
          conversationId: 7,
          role: "user",
          content: "画一只猫",
          refinedContent: "",
          imagesJson: "[]",
          paramsJson: "{}",
          createdAt: "1",
        },
      ],
      hasMore: false,
    });
    const addMessage = vi.mocked(api.addMessage);
    addMessage.mockReset();
    addMessage.mockResolvedValueOnce({ id: 11, imagesJson: "[]" });
    addMessage.mockResolvedValueOnce({ id: 12, imagesJson: "[]" });

    let finish!: (v: Awaited<ReturnType<typeof api.generateImages>>) => void;
    vi.mocked(api.generateImages).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );

    useChatStore.setState({
      activeId: 7,
      conversations: [{ id: 7, title: "旧会话", createdAt: "1" }],
    });

    const pending = useChatStore.getState().send("画一只猫");
    await vi.waitFor(() => {
      expect(api.generateImages).toHaveBeenCalled();
      expect(
        useChatStore.getState().messages.some((m) => m.status === "generating"),
      ).toBe(true);
    });

    await useChatStore.getState().newConversation();
    expect(useChatStore.getState().activeId).toBe(99);
    expect(useChatStore.getState().messages).toEqual([]);

    await useChatStore.getState().selectConversation(7);
    const reattached = useChatStore.getState().messages;
    expect(reattached.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(reattached[1].status).toBe("generating");

    finish({
      images: [
        {
          historyId: 5,
          dataUrl: "data:image/png;base64,AA",
          filePath: "/tmp/a.png",
          prompt: "画一只猫",
          model: "test-model",
          seed: null,
        },
      ],
    });
    await pending;

    const done = useChatStore.getState().messages;
    expect(done[1].id).toBe(12);
    expect(done[1].status).toBe("done");
    expect(done[1].images).toHaveLength(1);
  });

  it("生成在别的会话里完成后再切回，只显示数据库里的结果、不重复", async () => {
    const userRow = {
      id: 11,
      conversationId: 7,
      role: "user" as const,
      content: "画一只猫",
      refinedContent: "",
      imagesJson: "[]",
      paramsJson: "{}",
      createdAt: "1",
    };
    const assistantRow = {
      id: 12,
      conversationId: 7,
      role: "assistant" as const,
      content: "画一只猫",
      refinedContent: "",
      imagesJson: JSON.stringify([
        {
          historyId: 5,
          dataUrl: "data:image/png;base64,AA",
          path: "/tmp/a.png",
          prompt: "画一只猫",
          seed: null,
        },
      ]),
      paramsJson: "{}",
      createdAt: "2",
    };
    vi.mocked(api.createConversation).mockResolvedValue(99);
    vi.spyOn(api, "listMessages")
      .mockResolvedValueOnce({ messages: [userRow], hasMore: false })
      .mockResolvedValueOnce({
        messages: [userRow, assistantRow],
        hasMore: false,
      });
    const addMessage = vi.mocked(api.addMessage);
    addMessage.mockReset();
    addMessage.mockResolvedValueOnce({ id: 11, imagesJson: "[]" });
    addMessage.mockResolvedValueOnce({ id: 12, imagesJson: "[]" });

    let finish!: (v: Awaited<ReturnType<typeof api.generateImages>>) => void;
    vi.mocked(api.generateImages).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    useChatStore.setState({
      activeId: 7,
      conversations: [{ id: 7, title: "旧会话", createdAt: "1" }],
    });

    const pending = useChatStore.getState().send("画一只猫");
    await vi.waitFor(() => {
      expect(api.generateImages).toHaveBeenCalled();
    });
    await useChatStore.getState().newConversation();
    await useChatStore.getState().selectConversation(7);
    expect(useChatStore.getState().messages[1]?.status).toBe("generating");

    await useChatStore.getState().newConversation();
    finish({
      images: [
        {
          historyId: 5,
          dataUrl: "data:image/png;base64,AA",
          filePath: "/tmp/a.png",
          prompt: "画一只猫",
          model: "test-model",
          seed: null,
        },
      ],
    });
    await pending;

    await useChatStore.getState().selectConversation(7);
    const done = useChatStore.getState().messages;
    expect(done.map((m) => m.id)).toEqual([11, 12]);
    expect(done[1].images).toHaveLength(1);
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
