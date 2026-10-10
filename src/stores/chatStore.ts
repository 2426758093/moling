import { create } from "zustand";
import {
  api,
  AdapterError,
  ChatMessage,
  Conversation,
  parseAdapterError,
} from "../lib/api";
import { toast } from "../lib/notify";
import { useAppStore } from "./appStore";
import { useProviderStore } from "./providerStore";

export interface Attachment {
  id: string;
  dataUrl: string;
  name: string;
  path?: string;
}

export interface ChatImage {
  historyId: number;
  dataUrl: string;
  path?: string;
  prompt: string;
  seed: number | null;
}

export interface DisplayMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  refined: string;
  thinkingUsed: boolean;
  attachments: Attachment[];
  images: ChatImage[];
  pendingImages: number;
  status: "thinking" | "generating" | "done" | "error";
  error: AdapterError | null;
}

interface ChatState {
  conversations: Conversation[];
  conversationsLoaded: boolean;
  activeId: number | null;
  messages: DisplayMessage[];
  attachments: Attachment[];
  sending: boolean;
  stopRequested: boolean;
  thinkingText: string;
  draftPrompt: string | null;
  setDraftPrompt: (text: string | null) => void;
  loadConversations: () => Promise<void>;
  newConversation: () => Promise<void>;
  selectConversation: (id: number) => Promise<void>;
  deleteConvo: (id: number) => Promise<void>;
  addAttachment: (att: Attachment) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  send: (text: string) => Promise<void>;
  stop: () => void;
  retryLast: () => Promise<void>;
  appendImageMessage: (
    img: { historyId: number; dataUrl: string; path: string },
    displayPrompt: string,
  ) => Promise<void>;
}

// 会话标题截取长度：取首条消息前 20 字
const TITLE_MAX_LEN = 20;

// 当前时间戳（字符串，与 DB created_at 列格式一致）
export function nowTimestamp(): string {
  return String(Date.now());
}

// 未持久化的本地消息使用负数 id（与用户消息 id 运算错开），避免与 DB 自增 id 冲突
function localAssistantId(userMsgId: number): number {
  return -(userMsgId * 10 + 1);
}

function toDisplay(m: ChatMessage): DisplayMessage {
  let attachments: Attachment[] = [];
  let images: ChatImage[] = [];
  try {
    const arr = JSON.parse(m.imagesJson || "[]");
    if (Array.isArray(arr)) {
      if (m.role === "user") attachments = arr;
      else images = arr;
    }
  } catch {
    // 忽略损坏数据
  }
  return {
    id: m.id,
    role: m.role as "user" | "assistant",
    content: m.content,
    refined: m.refinedContent,
    thinkingUsed: Boolean(m.refinedContent && m.refinedContent !== m.content),
    attachments,
    images,
    pendingImages: 0,
    status: "done",
    error: null,
  };
}

let sendSeq = 0;

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  conversationsLoaded: false,
  activeId: null,
  messages: [],
  attachments: [],
  sending: false,
  stopRequested: false,
  thinkingText: "",
  draftPrompt: null,
  setDraftPrompt: (text) => set({ draftPrompt: text }),

  loadConversations: async () => {
    try {
      const { conversations } = await api.listConversations();
      set({ conversations, conversationsLoaded: true });
      if (conversations.length > 0 && get().activeId === null) {
        await get().selectConversation(conversations[0].id);
      }
    } catch {
      // 会话列表加载失败兜底，避免 unhandled rejection
    }
  },

  newConversation: async () => {
    try {
      const id = await api.createConversation("新对话");
      await get().loadConversations();
      set({ activeId: id, messages: [], attachments: [] });
    } catch (e) {
      toast(`新建会话失败：${parseAdapterError(String(e)).message}`, "error");
    }
  },

  selectConversation: async (id) => {
    try {
      const { messages } = await api.listMessages(id);
      set({
        activeId: id,
        messages: messages.map(toDisplay),
        attachments: [],
        thinkingText: "",
      });
    } catch {
      // 消息加载失败兜底，避免 unhandled rejection
    }
  },

  deleteConvo: async (id) => {
    await api.deleteConversation(id);
    if (get().activeId === id) {
      set({ activeId: null, messages: [] });
    }
    await get().loadConversations();
  },

  addAttachment: (att) =>
    set((s) => ({ attachments: [...s.attachments, att] })),
  removeAttachment: (id) =>
    set((s) => ({ attachments: s.attachments.filter((a) => a.id !== id) })),
  clearAttachments: () => set({ attachments: [] }),

  send: async (text) => {
    const trimmed = text.trim();
    const { sending } = get();
    if (!trimmed || sending) return;
    const { providers, defaultProviderId } = useProviderStore.getState();
    const provider = providers.find((p) => p.provider.id === defaultProviderId);
    const model = provider?.provider.defaultModel;
    if (!provider || defaultProviderId == null || !model) {
      toast("请先在「设置」中配置绘图服务商与模型", "error");
      return;
    }

    const mySeq = ++sendSeq;
    const isMine = () => sendSeq === mySeq;

    let convId = get().activeId;
    if (convId === null) {
      try {
        convId = await api.createConversation(trimmed.slice(0, TITLE_MAX_LEN));
      } catch (e) {
        toast(`创建会话失败：${parseAdapterError(String(e)).message}`, "error");
        return;
      }
      if (!isMine()) return;
    }

    // 附件先落盘，拿到 path 再入库（DB 不再存 dataUrl）
    const rawAtts = [...get().attachments];
    const atts = await Promise.all(
      rawAtts.map(async (a) => {
        if (a.path) return a;
        try {
          const { path } = await api.saveChatImage(a.dataUrl, a.name);
          return { ...a, path };
        } catch {
          return a;
        }
      }),
    );
    let userResp;
    try {
      userResp = await api.addMessage({
        conversationId: convId,
        role: "user",
        content: trimmed,
        refinedContent: "",
        imagesJson: JSON.stringify(
          atts.map(({ id, name, path }) => ({ id, name, path })),
        ),
        paramsJson: JSON.stringify(useAppStore.getState().prefs),
        createdAt: nowTimestamp(),
      });
    } catch (e) {
      toast(`发送失败：${parseAdapterError(String(e)).message}`, "error");
      set({ sending: false });
      return;
    }
    if (!isMine()) return;
    const userMsgId = userResp.id;

    const userMsg: DisplayMessage = {
      id: userMsgId,
      role: "user",
      content: trimmed,
      refined: "",
      thinkingUsed: false,
      attachments: atts,
      images: [],
      pendingImages: 0,
      status: "done",
      error: null,
    };

    const assistantLocalId = localAssistantId(userMsgId);
    const assistantMsg: DisplayMessage = {
      id: assistantLocalId,
      role: "assistant",
      content: trimmed,
      refined: "",
      thinkingUsed: false,
      attachments: [],
      images: [],
      pendingImages: 0,
      status: "thinking",
      error: null,
    };

    set({
      activeId: convId,
      messages: [...get().messages, userMsg, assistantMsg],
      attachments: [],
      sending: true,
      stopRequested: false,
      thinkingText: "",
    });
    if (get().conversations.find((c) => c.id === convId) === undefined) {
      await get().loadConversations();
    }

    const updateAssistant = (patch: Partial<DisplayMessage>) =>
      set({
        messages: get().messages.map((m) =>
          m.id === assistantLocalId ? { ...m, ...patch } : m,
        ),
      });

    // 1. 思考模型优化提示词
    const lastAssistant = [...get().messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.refined);
    try {
      const result = await api.refinePrompt(
        trimmed,
        lastAssistant?.refined ?? null,
      );
      if (!isMine()) return;
      if (result.used) {
        updateAssistant({
          refined: result.refined,
          thinkingUsed: true,
          content: result.refined,
        });
        set({ thinkingText: result.refined });
      }
    } catch {
      // 思考失败静默降级为原文
    }
    if (!isMine() || get().stopRequested) {
      if (isMine()) finalize();
      return;
    }

    // 2. 生成图片：单次 invoke 透传 count=n，响应按序解析、逐张更新进度。
    //    注意：前端无法中断在途 HTTP 请求（invoke 无取消语义），用户点停止后结果返回即被丢弃。
    updateAssistant({ status: "generating" });
    const prefs = useAppStore.getState().prefs;
    const count = prefs.count;
    updateAssistant({ pendingImages: count });
    const images: ChatImage[] = [];
    let genError: AdapterError | null = null;
    try {
      const { images: batch } = await api.generateImages({
        providerId: defaultProviderId,
        prompt:
          get().messages.find((m) => m.id === assistantLocalId)?.content ??
          trimmed,
        model,
        width: prefs.width,
        height: prefs.height,
        style: prefs.style,
        count,
        images: atts.map((a) => a.dataUrl),
      });
      if (!isMine()) return;
      if (get().stopRequested) {
        finalize();
        return;
      }
      for (const img of batch) {
        images.push({
          historyId: img.historyId,
          dataUrl: img.dataUrl,
          path: img.filePath,
          prompt: img.prompt,
          seed: img.seed,
        });
        updateAssistant({
          images: [...images],
          pendingImages: count - images.length,
        });
      }
    } catch (e) {
      if (!isMine()) return;
      genError = parseAdapterError(String(e));
    }
    if (get().stopRequested) {
      finalize();
      return;
    }
    updateAssistant({
      images: [...images],
      pendingImages: Math.max(0, count - images.length),
    });
    if (genError) {
      updateAssistant({ status: "error", error: genError });
    } else {
      updateAssistant({ status: "done" });
    }

    // 3. 持久化助手消息（只存 {historyId, path}）
    const finalMsg = get().messages.find((m) => m.id === assistantLocalId);
    let persisted;
    try {
      persisted = await api.addMessage({
        conversationId: convId,
        role: "assistant",
        content: finalMsg?.content ?? trimmed,
        refinedContent: finalMsg?.refined ?? "",
        imagesJson: JSON.stringify(
          images.map(({ historyId, path }) => ({ historyId, path })),
        ),
        paramsJson: JSON.stringify(prefs),
        createdAt: nowTimestamp(),
      });
    } catch (e) {
      if (!isMine()) return;
      updateAssistant({
        status: "error",
        error: parseAdapterError(String(e)),
      });
      finalize();
      return;
    }
    if (!isMine()) return;
    set({
      messages: get().messages.map((m) =>
        m.id === assistantLocalId ? { ...m, id: persisted.id } : m,
      ),
    });
    await get().loadConversations();

    function finalize() {
      set({ sending: false, thinkingText: "" });
    }
    finalize();
  },

  stop: () => {
    // 停止语义：立即回到空闲 UI。已知限制——前端无法取消在途 HTTP 请求
    // （Tauri invoke 无取消语义），进行中的结果返回后由 send() 检查 stopRequested 丢弃。
    set({ stopRequested: true, sending: false, thinkingText: "" });
  },

  retryLast: async () => {
    const lastUser = [...get().messages]
      .reverse()
      .find((m) => m.role === "user");
    if (!lastUser) return;
    // 恢复参考图：取最近一条 user 消息中带 path 的附件。
    // dataUrl 仅当前会话内存中存在（DB 只存 path，前端无读盘通道），
    // 应用重启后无法恢复，提示并放弃参考图后继续重试。
    const restorable = lastUser.attachments.filter((a) => a.path);
    if (restorable.length > 0) {
      const withData = restorable.filter((a) => a.dataUrl);
      if (withData.length === restorable.length) {
        set({ attachments: withData });
      } else {
        toast("重试未能恢复参考图", "error");
      }
    }
    await get().send(lastUser.content);
  },

  appendImageMessage: async (img, displayPrompt) => {
    const convId = get().activeId;
    if (convId === null) return;
    const persisted = await api.addMessage({
      conversationId: convId,
      role: "assistant",
      content: displayPrompt,
      refinedContent: displayPrompt,
      imagesJson: JSON.stringify([
        { historyId: img.historyId, path: img.path },
      ]),
      paramsJson: "{}",
      createdAt: nowTimestamp(),
    });
    set((s) => ({
      messages: [
        ...s.messages,
        {
          id: persisted.id,
          role: "assistant",
          content: displayPrompt,
          refined: displayPrompt,
          thinkingUsed: false,
          attachments: [],
          images: [
            {
              historyId: img.historyId,
              dataUrl: img.dataUrl,
              path: img.path,
              prompt: displayPrompt,
              seed: null,
            },
          ],
          pendingImages: 0,
          status: "done",
          error: null,
        },
      ],
    }));
  },
}));
