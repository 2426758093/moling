import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  api,
  AdapterError,
  ChatMessage,
  Conversation,
  parseAdapterError,
  ThinkingDelta,
} from "../lib/api";
import { toast } from "../lib/notify";
import { MAX_REFERENCE_IMAGES } from "../lib/image";
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
  status: "thinking" | "generating" | "done" | "stopped" | "error";
  error: AdapterError | null;
  /// 思考模型的流式增量（仅 status=thinking 期间有值，落定后清空）
  streamText?: string;
}

interface ChatState {
  conversations: Conversation[];
  conversationsLoaded: boolean;
  activeId: number | null;
  messages: DisplayMessage[];
  /// 当前会话是否还有更旧的消息可加载（keyset 分页）
  hasMore: boolean;
  /// 正在加载更早的消息（用于顶部提示与去抖）
  loadingOlder: boolean;
  attachments: Attachment[];
  sending: boolean;
  stopRequested: boolean;
  draftPrompt: string | null;
  setDraftPrompt: (text: string | null) => void;
  loadConversations: () => Promise<void>;
  newConversation: () => Promise<void>;
  selectConversation: (id: number) => Promise<void>;
  /// 向上滚动时加载更早的一页（prepend），并保持滚动位置由调用方补偿
  loadOlder: () => Promise<void>;
  deleteConvo: (id: number) => Promise<void>;
  addAttachment: (att: Attachment) => boolean;
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

// 每页消息条数（与后端 clamp 上限 200 无关，这里只决定单次 IPC 体积）
const PAGE_SIZE = 50;

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
// 会话切换序号：切换会话时自增，用于丢弃「已切走」的旧会话消息响应
let convSeq = 0;
// 当前在途生成任务 id：stop() 用它请求后端取消（同一时刻只有一路生成）
let activeJobId: string | null = null;
// 当前在途思考请求 id：增量事件按它过滤，stop() 用它取消
let activeRefineId: string | null = null;
// 思考增量的退订函数（每轮请求重订阅，StrictMode 双订阅无副作用）
let detachThinking: (() => void) | null = null;

/// 退订思考增量并清空活动 id；不清空已落定的 refined 内容
function detachThinkingStream(): void {
  const off = detachThinking;
  detachThinking = null;
  activeRefineId = null;
  off?.();
}

export const useChatStore = create<ChatState>((set, get) => {
  // 抽出的「生成 + 持久化 assistant」流程，send()（新消息）与 retryLast()（重试）共用：
  // 只维护 1 条 assistant 气泡，不新增 user 消息（落实重试不重复用户消息）。
  // seq 为调用方持有的发送序号，用于丢弃已被新一轮发送取代的过期流程更新。
  const runGeneration = async (
    convId: number,
    userMsg: DisplayMessage,
    atts: Attachment[],
    assistantLocalId: number,
    seq: number,
  ): Promise<void> => {
    const isCurrent = () => sendSeq === seq;
    const updateAssistant = (patch: Partial<DisplayMessage>) =>
      set({
        messages: get().messages.map((m) =>
          m.id === assistantLocalId ? { ...m, ...patch } : m,
        ),
      });
    const finalize = () => {
      if (isCurrent()) set({ sending: false });
    };

    // 持久化助手消息（只存 {historyId, path}）；markError=false 时保留调用方已设置的 status
    const persistAssistant = async (
      images: ChatImage[],
      markError = true,
    ): Promise<boolean> => {
      const finalMsg = get().messages.find((m) => m.id === assistantLocalId);
      let persisted: { id: number; imagesJson: string };
      try {
        persisted = await api.addMessage({
          conversationId: convId,
          role: "assistant",
          content: finalMsg?.content ?? userMsg.content,
          refinedContent: finalMsg?.refined ?? "",
          imagesJson: JSON.stringify(
            images.map(({ historyId, path }) => ({ historyId, path })),
          ),
          paramsJson: JSON.stringify(useAppStore.getState().prefs),
          createdAt: nowTimestamp(),
        });
      } catch (e) {
        if (isCurrent() && markError) {
          updateAssistant({
            status: "error",
            error: parseAdapterError(String(e)),
          });
        }
        return false;
      }
      if (!isCurrent()) return true;
      set({
        messages: get().messages.map((m) =>
          m.id === assistantLocalId ? { ...m, id: persisted.id } : m,
        ),
      });
      return true;
    };

    // 停止发生在附件落盘/用户消息入库阶段：不再发起生成，占位直接收尾
    if (get().stopRequested) {
      updateAssistant({ status: "stopped", pendingImages: 0 });
      finalize();
      return;
    }

    const { providers, defaultProviderId } = useProviderStore.getState();
    const provider = providers.find((p) => p.provider.id === defaultProviderId);
    const model = provider?.provider.defaultModel;
    if (!provider || defaultProviderId == null || !model) {
      updateAssistant({
        status: "error",
        error: {
          type: "other",
          message: "请先在「设置」中配置绘图服务商与模型",
        },
        pendingImages: 0,
      });
      finalize();
      return;
    }

    // 1. 思考模型优化提示词（失败静默降级为原文）
    const lastAssistant = [...get().messages]
      .reverse()
      .find(
        (m) => m.role === "assistant" && m.refined && m.id !== assistantLocalId,
      );
    // 先订阅再发起：增量只写入本轮占位，且停止/过期后不再落任何片段
    detachThinkingStream();
    const refineId = crypto.randomUUID();
    activeRefineId = refineId;
    const off = await listen<ThinkingDelta>("thinking:delta", (event) => {
      const { requestId, delta } = event.payload;
      if (requestId !== refineId || requestId !== activeRefineId) return;
      if (!isCurrent() || get().stopRequested) return;
      const current = get().messages.find((m) => m.id === assistantLocalId);
      if (!current) return;
      updateAssistant({ streamText: (current.streamText ?? "") + delta });
    });
    detachThinking = () => {
      off();
      if (activeRefineId === refineId) activeRefineId = null;
    };
    try {
      const result = await api.refinePrompt(
        userMsg.content,
        lastAssistant?.refined ?? null,
        refineId,
        convId,
      );
      if (!isCurrent()) return;
      if (result.used && !get().stopRequested) {
        updateAssistant({
          refined: result.refined,
          thinkingUsed: true,
          content: result.refined,
          streamText: undefined,
        });
      } else {
        updateAssistant({ streamText: undefined });
      }
    } catch {
      // 思考失败静默降级为原文
      updateAssistant({ streamText: undefined });
    } finally {
      // 只有本次仍是活动思考请求时才退订，避免误杀下一轮已建好的订阅
      if (activeRefineId === refineId) detachThinkingStream();
    }
    if (!isCurrent()) return;
    if (get().stopRequested) {
      updateAssistant({ status: "stopped", pendingImages: 0 });
      finalize();
      return;
    }

    // 2. 生成图片：单次 invoke 透传 count=n，响应按序解析、逐张更新进度。
    //    每次生成分配 jobId，stop() 用它调用后端 cancel_generation 中断在途请求。
    updateAssistant({ status: "generating" });
    const prefs = useAppStore.getState().prefs;
    const count = prefs.count;
    updateAssistant({ pendingImages: count });
    const images: ChatImage[] = [];
    let genError: AdapterError | null = null;
    let cancelled = false;
    const jobId = crypto.randomUUID();
    activeJobId = jobId;
    try {
      const resp = await api.generateImages({
        providerId: defaultProviderId,
        prompt:
          get().messages.find((m) => m.id === assistantLocalId)?.content ??
          userMsg.content,
        model,
        width: prefs.width,
        height: prefs.height,
        style: prefs.style,
        count,
        images: atts.map((a) => a.dataUrl),
        jobId,
      });
      cancelled = Boolean(resp.cancelled);
      if (!isCurrent()) return;
      for (const img of resp.images ?? []) {
        images.push({
          historyId: img.historyId,
          dataUrl: img.dataUrl,
          path: img.filePath,
          prompt: img.prompt,
          seed: img.seed,
        });
        updateAssistant({
          images: [...images],
          pendingImages: Math.max(0, count - images.length),
        });
      }
    } catch (e) {
      if (!isCurrent()) return;
      genError = parseAdapterError(String(e));
    } finally {
      // 任务已结束：清理活动任务 id（仅当仍是本次任务，避免误清新任务）
      if (activeJobId === jobId) activeJobId = null;
    }
    if (!isCurrent()) return;
    // 终态清算占位：服务商可能少于请求数量（模板接口常见只返回单图），
    // 差额不能留成永久骨架。
    updateAssistant({ images: [...images], pendingImages: 0 });
    if (
      !cancelled &&
      !get().stopRequested &&
      !genError &&
      images.length < count
    ) {
      toast(`服务商仅返回 ${images.length} 张（请求 ${count} 张）`);
    }

    // 3. 停止/取消语义：已生成的图片保留并照常持久化，assistant 消息标记 stopped
    if (cancelled || get().stopRequested) {
      updateAssistant({ status: "stopped", error: null, pendingImages: 0 });
      if (images.length > 0) await persistAssistant(images, false);
      finalize();
      return;
    }

    if (genError) {
      updateAssistant({ status: "error", error: genError, pendingImages: 0 });
    } else {
      updateAssistant({ status: "done", error: null, pendingImages: 0 });
    }

    // 4. 持久化助手消息（只存 {historyId, path}）
    const persistedOk = await persistAssistant(images);
    if (!persistedOk || !isCurrent()) {
      finalize();
      return;
    }
    await get().loadConversations();
    finalize();
  };

  return {
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
        convSeq++;
        detachThinkingStream();
        await get().loadConversations();
        set({
          activeId: id,
          messages: [],
          hasMore: false,
          loadingOlder: false,
          attachments: [],
        });
      } catch (e) {
        toast(`新建会话失败：${parseAdapterError(String(e)).message}`, "error");
      }
    },

    selectConversation: async (id) => {
      // 只加载最新一页；更早的消息由 loadOlder() 按需续载
      detachThinkingStream();
      const myConvSeq = ++convSeq;
      try {
        const { messages, hasMore } = await api.listMessages(id, {
          limit: PAGE_SIZE,
        });
        // 切走之后才返回的响应必须丢弃，否则会把别的会话消息写进当前视图
        if (convSeq !== myConvSeq) return;
        set({
          activeId: id,
          messages: messages.map(toDisplay),
          hasMore,
          loadingOlder: false,
          attachments: [],
        });
      } catch (e) {
        if (convSeq === myConvSeq) {
          toast(
            `加载消息失败：${parseAdapterError(String(e)).message}`,
            "error",
          );
        }
      }
    },

    loadOlder: async () => {
      const { activeId, hasMore, loadingOlder, messages } = get();
      if (activeId === null || !hasMore || loadingOlder) return;
      // 游标取当前列表里最小的正数 id（负数 id 是本地占位，不能当游标）
      const oldest = messages.find((m) => m.id > 0);
      if (!oldest) return;
      const myConvSeq = convSeq;
      set({ loadingOlder: true });
      try {
        const page = await api.listMessages(activeId, {
          beforeId: oldest.id,
          limit: PAGE_SIZE,
        });
        if (convSeq !== myConvSeq || get().activeId !== activeId) return;
        // 去重：并发触发或与 send 新消息重叠时，避免同一条消息出现两次
        const existing = new Set(get().messages.map((m) => m.id));
        const older = page.messages
          .map(toDisplay)
          .filter((m) => !existing.has(m.id));
        set({
          messages: [...older, ...get().messages],
          hasMore: page.hasMore,
        });
      } catch (e) {
        toast(
          `加载更早消息失败：${parseAdapterError(String(e)).message}`,
          "error",
        );
      } finally {
        if (convSeq === myConvSeq) set({ loadingOlder: false });
      }
    },

    deleteConvo: async (id) => {
      await api.deleteConversation(id);
      if (get().activeId === id) {
        convSeq++;
        set({
          activeId: null,
          messages: [],
          hasMore: false,
          loadingOlder: false,
        });
      }
      await get().loadConversations();
    },

    addAttachment: (att) => {
      if (get().attachments.length >= MAX_REFERENCE_IMAGES) {
        toast(`最多添加 ${MAX_REFERENCE_IMAGES} 张参考图`, "error");
        return false;
      }
      set((s) => ({ attachments: [...s.attachments, att] }));
      return true;
    },
    removeAttachment: (id) =>
      set((s) => ({ attachments: s.attachments.filter((a) => a.id !== id) })),
    clearAttachments: () => set({ attachments: [] }),

    send: async (text) => {
      const trimmed = text.trim();
      if (!trimmed || get().sending) return;
      const { providers, defaultProviderId } = useProviderStore.getState();
      const provider = providers.find(
        (p) => p.provider.id === defaultProviderId,
      );
      const model = provider?.provider.defaultModel;
      if (!provider || defaultProviderId == null || !model) {
        toast("请先在「设置」中配置绘图服务商与模型", "error");
        return;
      }

      // 校验通过后立即同步上锁再进入 await：后面有 createConversation 与附件落盘两次异步，
      // 若像原来那样等到生成前才置 sending，连点/连按 Enter 会穿透校验造成双发。
      set({ sending: true, stopRequested: false });
      const mySeq = ++sendSeq;
      const isMine = () => sendSeq === mySeq;

      try {
        let convId = get().activeId;
        const createdConversation = convId === null;
        if (convId === null) {
          try {
            convId = await api.createConversation(
              trimmed.slice(0, TITLE_MAX_LEN),
            );
          } catch (e) {
            toast(
              `创建会话失败：${parseAdapterError(String(e)).message}`,
              "error",
            );
            return;
          }
          if (!isMine()) return;
        }
        if (get().stopRequested) return;

        // 附件先落盘，拿到 path 再入库（DB 不再存 dataUrl）。
        // F4：任一张失败即提示并中止发送，不静默降级为「无参考图继续生成」。
        let atts: Attachment[];
        try {
          atts = await Promise.all(
            get().attachments.map(async (a) => {
              if (a.path) return a;
              const { path } = await api.saveChatImage(a.dataUrl, a.name);
              return { ...a, path };
            }),
          );
        } catch (e) {
          toast(
            `参考图保存失败，已中止发送：${parseAdapterError(String(e)).message}`,
            "error",
          );
          return;
        }
        if (!isMine()) return;
        if (get().stopRequested) return;

        let userResp: { id: number; imagesJson: string };
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
          // 刚建的新会话没有历史页可翻
          ...(createdConversation
            ? { hasMore: false, loadingOlder: false }
            : undefined),
        });
        if (get().conversations.find((c) => c.id === convId) === undefined) {
          await get().loadConversations();
        }
        if (!isMine()) return;

        await runGeneration(convId, userMsg, atts, assistantLocalId, mySeq);
      } catch (e) {
        // 兜底：任何未预期异常都要提示并复位 sending，不能让异常把锁死在 true
        if (isMine()) {
          toast(`发送失败：${parseAdapterError(String(e)).message}`, "error");
        }
      } finally {
        // 成功/异常/停止都复位；仅当本次仍是当前发送时复位，
        // 避免上一轮收尾把新一轮发送的锁清掉
        if (isMine()) set({ sending: false });
      }
    },

    stop: () => {
      // 停止语义：立即回到空闲 UI，并尽力请求后端中断在途生成。
      // jobId / 思考 requestId 均由 runGeneration 生成；取消命令为 fire-and-forget，
      // 后端未落地该命令（invoke 拒绝）时静默忽略，不阻塞停止操作。
      const refineId = activeRefineId;
      if (refineId) {
        detachThinkingStream();
        void api.cancelRefine(refineId).catch(() => undefined);
      }
      const jobId = activeJobId;
      if (jobId) {
        activeJobId = null;
        void api.cancelGeneration(jobId).catch(() => undefined);
      }
      set((s) => ({
        stopRequested: true,
        sending: false,
        // 在途占位立刻标记 stopped：否则停止后马上发新消息时，
        // 旧请求返回会被序号校验丢弃，旧气泡会一直转圈
        messages: s.messages.map((m) =>
          m.role === "assistant" &&
          (m.status === "thinking" || m.status === "generating")
            ? { ...m, status: "stopped" as const, pendingImages: 0 }
            : m,
        ),
      }));
    },

    retryLast: async () => {
      if (get().sending) return;
      const msgs = get().messages;
      let userIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "user") {
          userIdx = i;
          break;
        }
      }
      if (userIdx < 0) return;
      const lastUser = msgs[userIdx];
      const convId = get().activeId;
      if (convId === null) return;

      // 重试不重复 user 气泡：移除「最后一条 user 之后」的 assistant 回复
      // （本地负数 id 的占位，或列表末尾的那条），随后重建一条 assistant 占位。
      const tail = msgs.slice(userIdx + 1);
      const assistantAfter = tail.find((m) => m.role === "assistant");
      const shouldRemove =
        assistantAfter !== undefined &&
        (assistantAfter.id < 0 ||
          tail[tail.length - 1]?.id === assistantAfter.id);

      // 恢复参考图：DB 只存 path，dataUrl 由后端 enrich_image_entries 读盘补回
      // （user 消息的 {id,name,path} 条目同样处理），因此重启后通常仍能恢复；
      // 只有磁盘文件已缺失时 dataUrl 为空，过滤后仅用文本重试。
      const restorable = lastUser.attachments.filter((a) => a.dataUrl);
      if (lastUser.attachments.length > restorable.length) {
        toast("参考图无法恢复，将仅用文本重试");
      }

      const assistantLocalId = localAssistantId(lastUser.id);
      const assistantMsg: DisplayMessage = {
        id: assistantLocalId,
        role: "assistant",
        content: lastUser.content,
        refined: "",
        thinkingUsed: false,
        attachments: [],
        images: [],
        pendingImages: 0,
        status: "thinking",
        error: null,
      };

      set({ sending: true, stopRequested: false });
      const mySeq = ++sendSeq;
      const isMine = () => sendSeq === mySeq;
      try {
        // 已入库的旧回复先删库再重试：只在前端移除会让旧行永远留在 messages 表里，
        // 下次打开会话又会冒出来（A3）。图片文件不动，可能仍被画廊引用。
        if (shouldRemove && assistantAfter && assistantAfter.id > 0) {
          try {
            await api.deleteMessage(assistantAfter.id);
          } catch (e) {
            toast(
              `重试失败：无法清理上一条回复（${parseAdapterError(String(e)).message}）`,
              "error",
            );
            return;
          }
          if (!isMine()) return;
        }
        set({
          messages: [
            ...(shouldRemove
              ? get().messages.filter((m) => m.id !== assistantAfter.id)
              : get().messages),
            assistantMsg,
          ],
        });
        await runGeneration(
          convId,
          lastUser,
          restorable,
          assistantLocalId,
          mySeq,
        );
      } catch (e) {
        if (isMine()) {
          toast(`重试失败：${parseAdapterError(String(e)).message}`, "error");
        }
      } finally {
        if (isMine()) set({ sending: false });
      }
    },

    appendImageMessage: async (img, displayPrompt) => {
      const convId = get().activeId;
      if (convId === null) return;
      try {
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
      } catch (e) {
        // 兜底：图片消息入库失败只提示，不把 unhandled rejection 抛给调用方
        toast(
          `保存图片消息失败：${parseAdapterError(String(e)).message}`,
          "error",
        );
      }
    },
  };
});
