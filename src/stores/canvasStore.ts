import { create } from "zustand";
import { api, CanvasBoardMeta } from "../lib/api";
import i18n from "../i18n";
import { toast } from "../lib/notify";

/** 画布节点：只记 historyId 与布局，绝不存 dataUrl */
export interface CanvasNode {
  id: string;
  historyId: number;
  x: number;
  y: number;
  /** 节点宽度（世界坐标）；缩略图为正方形 */
  width: number;
}

export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
}

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface CanvasData {
  version: 1;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: CanvasViewport;
}

export const NODE_WIDTH = 220;
export const NODE_MIN_WIDTH = 120;
export const NODE_MAX_WIDTH = 480;
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 3;
const SAVE_DEBOUNCE_MS = 600;
const THUMB_BATCH = 200;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

const DEFAULT_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 };

/** 宽进严出：坏节点 / 悬空边一律丢弃，绝不因为一条脏数据让画布打不开 */
export function parseCanvasData(json: string): CanvasData {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {
      version: 1,
      nodes: [],
      edges: [],
      viewport: { ...DEFAULT_VIEWPORT },
    };
  }
  const root = (raw ?? {}) as Record<string, unknown>;
  const nodes: CanvasNode[] = [];
  const ids = new Set<string>();
  if (Array.isArray(root.nodes)) {
    for (const item of root.nodes) {
      if (!item || typeof item !== "object") continue;
      const n = item as Record<string, unknown>;
      const id = typeof n.id === "string" ? n.id : "";
      const historyId = Number(n.historyId);
      const x = Number(n.x);
      const y = Number(n.y);
      const width = Number(n.width);
      if (!id || ids.has(id)) continue;
      if (!Number.isInteger(historyId) || historyId <= 0) continue;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      ids.add(id);
      nodes.push({
        id,
        historyId,
        x,
        y,
        width: Number.isFinite(width)
          ? Math.min(NODE_MAX_WIDTH, Math.max(NODE_MIN_WIDTH, width))
          : NODE_WIDTH,
      });
    }
  }
  const edges: CanvasEdge[] = [];
  const edgeIds = new Set<string>();
  if (Array.isArray(root.edges)) {
    for (const item of root.edges) {
      if (!item || typeof item !== "object") continue;
      const e = item as Record<string, unknown>;
      const id = typeof e.id === "string" ? e.id : "";
      const from = typeof e.from === "string" ? e.from : "";
      const to = typeof e.to === "string" ? e.to : "";
      if (!id || edgeIds.has(id) || from === to) continue;
      if (!ids.has(from) || !ids.has(to)) continue;
      edgeIds.add(id);
      edges.push({ id, from, to });
    }
  }
  const vp = (root.viewport ?? {}) as Record<string, unknown>;
  const vx = Number(vp.x);
  const vy = Number(vp.y);
  return {
    version: 1,
    nodes,
    edges,
    viewport: {
      x: Number.isFinite(vx) ? vx : 0,
      y: Number.isFinite(vy) ? vy : 0,
      zoom: Number.isFinite(Number(vp.zoom)) ? clampZoom(Number(vp.zoom)) : 1,
    },
  };
}

function serialize(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  viewport: CanvasViewport,
): string {
  return JSON.stringify({ version: 1, nodes, edges, viewport });
}

function snapshotKey(
  name: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  viewport: CanvasViewport,
): string {
  return `${name}\n${serialize(nodes, edges, viewport)}`;
}

function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function metaOf(board: CanvasBoardMeta): CanvasBoardMeta {
  return {
    id: board.id,
    name: board.name,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
  };
}

// 保存是全局串行的：切换画布 / 卸载时都等同一个在途请求，避免旧数据覆盖新数据
let saveTimer: number | null = null;
let savedKey: string | null = null;
let inflight: Promise<void> | null = null;
// 切板序号：快速连续点开多个画布时，只有最后一次请求的结果允许落到界面上
let boardSeq = 0;
const requestedThumbs = new Set<number>();

interface CanvasState {
  boards: CanvasBoardMeta[];
  activeId: number | null;
  activeName: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: CanvasViewport;
  thumbs: Record<number, string>;
  loaded: boolean;
  loading: boolean;
  dirty: boolean;
  saving: boolean;
  savedAt: string | null;
  ensureLoaded: () => Promise<void>;
  createBoard: (name: string) => Promise<number | null>;
  selectBoard: (id: number) => Promise<void>;
  renameBoard: (name: string) => void;
  deleteBoard: (id: number) => Promise<void>;
  /** 加入节点；没有画布时自动建一个，重复图片返回已有节点 id */
  addHistoryNode: (historyId: number) => Promise<string | null>;
  updateNode: (id: string, patch: Partial<Pick<CanvasNode, "x" | "y">>) => void;
  removeNode: (id: string) => void;
  addEdge: (from: string, to: string) => void;
  removeEdge: (id: string) => void;
  setViewport: (viewport: CanvasViewport) => void;
  saveSoon: () => void;
  /** 立即落库；切换画布 / 离开页面前调用 */
  flush: () => Promise<void>;
  loadThumbs: (ids: number[]) => Promise<void>;
}

export const useCanvasStore = create<CanvasState>((set, get) => {
  const scheduleSave = () => {
    set({ dirty: true });
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      void get().flush();
    }, SAVE_DEBOUNCE_MS);
  };

  const resetToEmpty = (boards: CanvasBoardMeta[]) =>
    set({
      boards,
      activeId: null,
      activeName: "",
      nodes: [],
      edges: [],
      viewport: { ...DEFAULT_VIEWPORT },
      dirty: false,
      saving: false,
      savedAt: null,
    });

  return {
    boards: [],
    activeId: null,
    activeName: "",
    nodes: [],
    edges: [],
    viewport: { ...DEFAULT_VIEWPORT },
    thumbs: {},
    loaded: false,
    loading: false,
    dirty: false,
    saving: false,
    savedAt: null,

    ensureLoaded: async () => {
      if (get().loaded || get().loading) return;
      set({ loading: true });
      try {
        const boards = await api.listCanvasBoards();
        set({ boards, loaded: true });
        const first = boards[0];
        if (!first) return;
        if (get().activeId == null) await get().selectBoard(first.id);
      } catch (e) {
        toast(
          i18n.t("加载画布列表失败：{{error}}", { error: String(e) }),
          "error",
        );
      } finally {
        set({ loading: false });
      }
    },

    createBoard: async (name) => {
      const trimmed = name.trim();
      if (!trimmed) {
        toast(i18n.t("画布名称不能为空"), "error");
        return null;
      }
      await get().ensureLoaded();
      await get().flush();
      // 新建会改变当前画布：让之前发出、还没返回的切板请求全部作废
      boardSeq += 1;
      try {
        const board = await api.createCanvasBoard(trimmed);
        const data = parseCanvasData(board.dataJson);
        savedKey = snapshotKey(
          board.name,
          data.nodes,
          data.edges,
          data.viewport,
        );
        set((s) => ({
          boards: [metaOf(board), ...s.boards],
          activeId: board.id,
          activeName: board.name,
          nodes: data.nodes,
          edges: data.edges,
          viewport: data.viewport,
          dirty: false,
          saving: false,
          savedAt: board.updatedAt,
        }));
        return board.id;
      } catch (e) {
        toast(i18n.t("新建画布失败：{{error}}", { error: String(e) }), "error");
        return null;
      }
    },

    selectBoard: async (id) => {
      if (get().activeId === id) return;
      const seq = ++boardSeq;
      await get().flush();
      try {
        const board = await api.getCanvasBoard(id);
        // 期间用户已经点了别的画布：丢弃这次过期响应，避免旧板内容覆盖新板
        if (seq !== boardSeq) return;
        if (!board) {
          set((s) => ({ boards: s.boards.filter((b) => b.id !== id) }));
          if (get().activeId === id) resetToEmpty(get().boards);
          return;
        }
        const data = parseCanvasData(board.dataJson);
        savedKey = snapshotKey(
          board.name,
          data.nodes,
          data.edges,
          data.viewport,
        );
        set({
          activeId: board.id,
          activeName: board.name,
          nodes: data.nodes,
          edges: data.edges,
          viewport: data.viewport,
          dirty: false,
          saving: false,
          savedAt: board.updatedAt,
        });
        void get().loadThumbs(data.nodes.map((n) => n.historyId));
      } catch (e) {
        if (seq === boardSeq) {
          toast(
            i18n.t("打开画布失败：{{error}}", { error: String(e) }),
            "error",
          );
        }
      }
    },

    renameBoard: (name) => {
      const trimmed = name.trim();
      if (!trimmed || get().activeId == null || trimmed === get().activeName)
        return;
      set({ activeName: trimmed });
      scheduleSave();
    },

    deleteBoard: async (id) => {
      await get().flush();
      boardSeq += 1;
      try {
        await api.deleteCanvasBoard(id);
      } catch (e) {
        toast(i18n.t("删除画布失败：{{error}}", { error: String(e) }), "error");
        return;
      }
      const rest = get().boards.filter((b) => b.id !== id);
      set({ boards: rest });
      if (get().activeId !== id) return;
      set({
        activeId: null,
        activeName: "",
        nodes: [],
        edges: [],
        viewport: { ...DEFAULT_VIEWPORT },
        dirty: false,
        savedAt: null,
      });
      savedKey = null;
      const next = rest[0];
      if (next) await get().selectBoard(next.id);
    },

    addHistoryNode: async (historyId) => {
      await get().ensureLoaded();
      if (get().activeId == null) {
        const created = await get().createBoard("我的画布");
        if (created == null) return null;
      }
      const existing = get().nodes.find((n) => n.historyId === historyId);
      if (existing) return existing.id;
      const { nodes, viewport } = get();
      const col = nodes.length % 4;
      const row = Math.floor(nodes.length / 4);
      const gap = 32;
      const x = Math.round(
        (-viewport.x + 48) / viewport.zoom + col * (NODE_WIDTH + gap),
      );
      const y = Math.round(
        (-viewport.y + 48) / viewport.zoom + row * (NODE_WIDTH + gap),
      );
      const node: CanvasNode = {
        id: newId("n"),
        historyId,
        x,
        y,
        width: NODE_WIDTH,
      };
      set((s) => ({ nodes: [...s.nodes, node] }));
      scheduleSave();
      void get().loadThumbs([historyId]);
      return node.id;
    },

    updateNode: (id, patch) => {
      if (!get().nodes.some((n) => n.id === id)) return;
      set((s) => ({
        nodes: s.nodes.map((n) => {
          if (n.id !== id) return n;
          const x =
            patch.x !== undefined && Number.isFinite(patch.x) ? patch.x : n.x;
          const y =
            patch.y !== undefined && Number.isFinite(patch.y) ? patch.y : n.y;
          if (x === n.x && y === n.y) return n;
          return { ...n, x, y };
        }),
      }));
      scheduleSave();
    },

    removeNode: (id) => {
      const s = get();
      if (!s.nodes.some((n) => n.id === id)) return;
      set({
        nodes: s.nodes.filter((n) => n.id !== id),
        edges: s.edges.filter((e) => e.from !== id && e.to !== id),
      });
      scheduleSave();
    },

    addEdge: (from, to) => {
      const { nodes, edges } = get();
      if (from === to) return;
      if (
        !nodes.some((n) => n.id === from) ||
        !nodes.some((n) => n.id === to)
      ) {
        return;
      }
      if (edges.some((e) => e.from === from && e.to === to)) return;
      set({ edges: [...edges, { id: newId("e"), from, to }] });
      scheduleSave();
    },

    removeEdge: (id) => {
      if (!get().edges.some((e) => e.id === id)) return;
      set((s) => ({ edges: s.edges.filter((e) => e.id !== id) }));
      scheduleSave();
    },

    setViewport: (viewport) => {
      set({
        viewport: {
          x: Number.isFinite(viewport.x) ? viewport.x : 0,
          y: Number.isFinite(viewport.y) ? viewport.y : 0,
          zoom: clampZoom(viewport.zoom),
        },
      });
      scheduleSave();
    },

    saveSoon: scheduleSave,

    flush: async () => {
      if (saveTimer !== null) {
        window.clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (inflight) await inflight;
      const s = get();
      if (s.activeId == null) return;
      const dataJson = serialize(s.nodes, s.edges, s.viewport);
      const key = `${s.activeName}\n${dataJson}`;
      if (key === savedKey) {
        if (s.dirty) set({ dirty: false });
        return;
      }
      const id = s.activeId;
      const name = s.activeName;
      set({ saving: true });
      inflight = (async () => {
        try {
          const saved = await api.saveCanvasBoard(id, name, dataJson);
          set((cur) => {
            // 保存期间已切到别的画布：只更新元数据，不把 savedKey / dirty
            // 套到新板上（否则新板会被误判为「已保存」而丢改动）
            const active = cur.activeId === id;
            if (active) savedKey = key;
            return {
              boards: cur.boards.map((b) =>
                b.id === id
                  ? { ...b, name: saved.name, updatedAt: saved.updatedAt }
                  : b,
              ),
              saving: false,
              ...(active
                ? {
                    savedAt: saved.updatedAt,
                    dirty:
                      snapshotKey(
                        cur.activeName,
                        cur.nodes,
                        cur.edges,
                        cur.viewport,
                      ) !== savedKey,
                  }
                : undefined),
            };
          });
        } catch (e) {
          set({ saving: false });
          toast(
            i18n.t("画布保存失败：{{error}}", { error: String(e) }),
            "error",
          );
        } finally {
          inflight = null;
        }
      })();
      await inflight;
    },

    loadThumbs: async (ids) => {
      const missing = Array.from(
        new Set(ids.filter((id) => !requestedThumbs.has(id))),
      );
      if (missing.length === 0) return;
      for (const id of missing) requestedThumbs.add(id);
      for (let i = 0; i < missing.length; i += THUMB_BATCH) {
        const chunk = missing.slice(i, i + THUMB_BATCH);
        try {
          const rows = await api.batchHistoryThumbs(chunk);
          if (rows.length === 0) continue;
          set((s) => {
            const thumbs = { ...s.thumbs };
            for (const row of rows) thumbs[row.historyId] = row.thumbUrl;
            return { thumbs };
          });
        } catch {
          // 缩略图失败只影响节点显示，SafeImg 会给出占位；不打断画布操作。
          // 但必须回滚本批标记：否则这些 id 会永远留在 requestedThumbs 里被跳过，
          // 再次进入画布也不会重试（F-017）。
          for (const id of chunk) requestedThumbs.delete(id);
        }
      }
    },
  };
});
