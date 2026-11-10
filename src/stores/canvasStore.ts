import { create } from "zustand";
import { api, CanvasBoardMeta } from "../lib/api";
import { clampOpacity, collectThumbIds } from "../lib/canvasLayers";
import i18n from "../i18n";
import { toast } from "../lib/notify";

/** 节点图层：图像层引用 historyId，蒙版层引用媒体根下的 alpha-hole PNG */
export interface CanvasLayer {
  id: string;
  kind: "image" | "mask";
  /** kind=image */
  historyId?: number;
  /** kind=mask：媒体根下的文件路径，绝不 base64 */
  path?: string;
  name?: string;
  visible: boolean;
  /** 0..1 */
  opacity: number;
  locked: boolean;
  /** image 层生效范围引用 mask 层 */
  maskLayerId?: string;
  regionId?: string;
  prompt?: string;
}

export type CanvasLayerDraft = Omit<CanvasLayer, "id">;

/** 分区重绘区域：蒙版落盘为资产，提示词随区域保存 */
export interface CanvasRegion {
  id: string;
  prompt: string;
  maskPath: string;
  /** 0..128，默认 24 */
  feather: number;
  appliedHistoryId?: number;
  appliedLayerId?: string;
}

/** 画布节点：只记 historyId、图层与布局，绝不存 dataUrl */
export interface CanvasNode {
  id: string;
  historyId: number;
  x: number;
  y: number;
  /** 节点宽度（世界坐标）；缩略图为正方形 */
  width: number;
  layers?: CanvasLayer[];
  regions?: CanvasRegion[];
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
  version: typeof CANVAS_VERSION;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: CanvasViewport;
}

/** 画布文档版本：v1 只有节点；v2 增加节点内图层栈与分区】
 *  读入兼容 v1/v2，写出一律 v2（旧版打开会丢图层，首次保存前留 data_json_prev 快照） */
export const CANVAS_VERSION = 2;
export const MAX_LAYERS_PER_NODE = 24;
export const MAX_LAYERS_PER_CANVAS = 3000;
export const MAX_REGIONS_PER_NODE = 8;
export const MAX_REGION_FEATHER = 128;
export const DEFAULT_REGION_FEATHER = 24;
export const MAX_LAYER_NAME_CHARS = 80;
export const MAX_REGION_PROMPT_CHARS = 2000;
export const MAX_LAYER_PATH_CHARS = 1024;

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

function parseLayer(raw: unknown): CanvasLayer | null {
  if (!raw || typeof raw !== "object") return null;
  const l = raw as Record<string, unknown>;
  const id = typeof l.id === "string" ? l.id.trim() : "";
  const kind = l.kind === "mask" ? "mask" : l.kind === "image" ? "image" : null;
  if (!id || !kind) return null;
  const historyId = Number(l.historyId);
  if (kind === "image" && (!Number.isInteger(historyId) || historyId <= 0)) {
    return null;
  }
  const path = typeof l.path === "string" ? l.path.trim() : "";
  if (kind === "mask" && (!path || path.length > MAX_LAYER_PATH_CHARS)) {
    return null;
  }
  const opacity = Number(l.opacity);
  const name =
    typeof l.name === "string"
      ? l.name.trim().slice(0, MAX_LAYER_NAME_CHARS)
      : "";
  const maskLayerId =
    typeof l.maskLayerId === "string" ? l.maskLayerId.trim() : "";
  const regionId = typeof l.regionId === "string" ? l.regionId.trim() : "";
  const prompt =
    typeof l.prompt === "string"
      ? l.prompt.slice(0, MAX_REGION_PROMPT_CHARS)
      : "";
  return {
    id,
    kind,
    ...(kind === "image" ? { historyId } : {}),
    ...(kind === "mask" ? { path } : {}),
    ...(name ? { name } : {}),
    visible: l.visible !== false,
    opacity: Number.isFinite(opacity) ? clampOpacity(opacity) : 1,
    locked: l.locked === true,
    ...(maskLayerId ? { maskLayerId } : {}),
    ...(regionId ? { regionId } : {}),
    ...(prompt ? { prompt } : {}),
  };
}

function parseRegion(raw: unknown): CanvasRegion | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim() : "";
  const maskPath = typeof r.maskPath === "string" ? r.maskPath.trim() : "";
  if (!id || !maskPath || maskPath.length > MAX_LAYER_PATH_CHARS) return null;
  const feather = Number(r.feather);
  const applied = Number(r.appliedHistoryId);
  const appliedLayerId =
    typeof r.appliedLayerId === "string" ? r.appliedLayerId.trim() : "";
  return {
    id,
    prompt:
      typeof r.prompt === "string"
        ? r.prompt.slice(0, MAX_REGION_PROMPT_CHARS)
        : "",
    maskPath,
    feather: Number.isFinite(feather)
      ? Math.min(MAX_REGION_FEATHER, Math.max(0, Math.round(feather)))
      : DEFAULT_REGION_FEATHER,
    ...(Number.isInteger(applied) && applied > 0
      ? { appliedHistoryId: applied }
      : {}),
    ...(appliedLayerId ? { appliedLayerId } : {}),
  };
}

function parseLayers(raw: unknown): CanvasLayer[] {
  if (!Array.isArray(raw)) return [];
  const out: CanvasLayer[] = [];
  const ids = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_LAYERS_PER_NODE) break;
    const layer = parseLayer(item);
    if (!layer || ids.has(layer.id)) continue;
    ids.add(layer.id);
    out.push(layer);
  }
  return out;
}

function parseRegions(raw: unknown): CanvasRegion[] {
  if (!Array.isArray(raw)) return [];
  const out: CanvasRegion[] = [];
  const ids = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_REGIONS_PER_NODE) break;
    const region = parseRegion(item);
    if (!region || ids.has(region.id)) continue;
    ids.add(region.id);
    out.push(region);
  }
  return out;
}

/** 宽进严出：坏节点 / 悬空边一律丢弃，绝不因为一条脏数据让画布打不开 */
export function parseCanvasData(json: string): CanvasData {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {
      version: CANVAS_VERSION,
      nodes: [],
      edges: [],
      viewport: { ...DEFAULT_VIEWPORT },
    };
  }
  const root = (raw ?? {}) as Record<string, unknown>;
  const nodes: CanvasNode[] = [];
  const ids = new Set<string>();
  let totalLayers = 0;
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
      let layers = parseLayers(n.layers);
      if (totalLayers + layers.length > MAX_LAYERS_PER_CANVAS) {
        layers = layers.slice(
          0,
          Math.max(0, MAX_LAYERS_PER_CANVAS - totalLayers),
        );
      }
      totalLayers += layers.length;
      const regions = parseRegions(n.regions);
      nodes.push({
        id,
        historyId,
        x,
        y,
        width: Number.isFinite(width)
          ? Math.min(NODE_MAX_WIDTH, Math.max(NODE_MIN_WIDTH, width))
          : NODE_WIDTH,
        ...(layers.length > 0 ? { layers } : {}),
        ...(regions.length > 0 ? { regions } : {}),
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
    version: CANVAS_VERSION,
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
  return JSON.stringify({
    version: CANVAS_VERSION,
    nodes: nodes.map((n) => {
      const out: Record<string, unknown> = {
        id: n.id,
        historyId: n.historyId,
        x: n.x,
        y: n.y,
        width: n.width,
      };
      if (n.layers && n.layers.length > 0) out.layers = n.layers;
      if (n.regions && n.regions.length > 0) out.regions = n.regions;
      return out;
    }),
    edges,
    viewport,
  });
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
  /** 源文件是 GIF 的 historyId（缩略图仍是首帧，角标与编辑守卫用） */
  gifIds: Record<number, boolean>;
  /** 当前选中节点（纯界面状态，不落盘） */
  selectedNodeId: string | null;
  layerPanelOpen: boolean;
  selectNode: (id: string | null) => void;
  setLayerPanelOpen: (open: boolean) => void;
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
  /** 追加图层；v1 节点首次追加时自动物化基准层，返回新图层 id */
  appendLayer: (nodeId: string, layer: CanvasLayerDraft) => string | null;
  updateLayer: (
    nodeId: string,
    layerId: string,
    patch: Partial<
      Pick<CanvasLayer, "visible" | "opacity" | "locked" | "name">
    >,
  ) => void;
  removeLayer: (nodeId: string, layerId: string) => void;
  /** direction=-1 向下（更靠近底层），1 向上 */
  moveLayer: (nodeId: string, layerId: string, direction: -1 | 1) => void;
  /** 合并/拆分后整栈替换；historyId 变更时节点基准图随之更新 */
  replaceNodeLayers: (
    nodeId: string,
    layers: CanvasLayer[],
    historyId?: number,
    clearRegions?: boolean,
  ) => void;
  addRegion: (
    nodeId: string,
    region: Omit<CanvasRegion, "id">,
  ) => string | null;
  updateRegion: (
    nodeId: string,
    regionId: string,
    patch: Partial<Pick<CanvasRegion, "prompt" | "feather">>,
  ) => void;
  removeRegion: (nodeId: string, regionId: string) => void;
  markRegionApplied: (
    nodeId: string,
    regionId: string,
    appliedHistoryId: number,
    appliedLayerId: string,
  ) => void;
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
      selectedNodeId: null,
      layerPanelOpen: false,
    });

  /** 首次加图层时物化基准层：锁定在最底层，指向节点基准图 */
  const withBaseLayer = (node: CanvasNode): CanvasLayer[] =>
    node.layers && node.layers.length > 0
      ? node.layers
      : [
          {
            id: `${node.id}-base`,
            kind: "image",
            historyId: node.historyId,
            visible: true,
            opacity: 1,
            locked: true,
          },
        ];

  const totalLayers = (nodes: CanvasNode[]) =>
    nodes.reduce((sum, n) => sum + (n.layers?.length ?? 0), 0);

  return {
    boards: [],
    activeId: null,
    activeName: "",
    nodes: [],
    edges: [],
    viewport: { ...DEFAULT_VIEWPORT },
    thumbs: {},
    gifIds: {},
    selectedNodeId: null,
    layerPanelOpen: false,
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
          selectedNodeId: null,
          layerPanelOpen: false,
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
          selectedNodeId: null,
          layerPanelOpen: false,
        });
        void get().loadThumbs(collectThumbIds(data.nodes));
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
        selectedNodeId: null,
        layerPanelOpen: false,
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
      const existing = get().nodes.find(
        (n) =>
          n.historyId === historyId ||
          n.layers?.some(
            (l) => l.kind === "image" && l.historyId === historyId,
          ),
      );
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
        ...(s.selectedNodeId === id
          ? { selectedNodeId: null, layerPanelOpen: false }
          : {}),
      });
      scheduleSave();
    },

    selectNode: (id) => {
      if (get().selectedNodeId === id) return;
      set({
        selectedNodeId: id,
        ...(id == null ? { layerPanelOpen: false } : {}),
      });
    },

    setLayerPanelOpen: (open) => {
      if (get().layerPanelOpen === open) return;
      set({ layerPanelOpen: open });
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

    appendLayer: (nodeId, layer) => {
      const s = get();
      const node = s.nodes.find((n) => n.id === nodeId);
      if (!node) return null;
      const layers = withBaseLayer(node);
      if (layers.length >= MAX_LAYERS_PER_NODE) {
        toast(
          i18n.t("每个节点最多 {{max}} 层，可合并后继续", {
            max: MAX_LAYERS_PER_NODE,
          }),
          "error",
        );
        return null;
      }
      if (totalLayers(s.nodes) >= MAX_LAYERS_PER_CANVAS) {
        toast(
          i18n.t("画布图层总数已达上限 {{max}}", {
            max: MAX_LAYERS_PER_CANVAS,
          }),
          "error",
        );
        return null;
      }
      const id = newId("l");
      const next = [...layers, { ...layer, id }];
      set({
        nodes: s.nodes.map((n) =>
          n.id === nodeId ? { ...n, layers: next } : n,
        ),
      });
      scheduleSave();
      if (layer.kind === "image" && layer.historyId) {
        void get().loadThumbs([layer.historyId]);
      }
      return id;
    },

    updateLayer: (nodeId, layerId, patch) => {
      const s = get();
      const node = s.nodes.find((n) => n.id === nodeId);
      if (!node?.layers) return;
      let changed = false;
      const layers = node.layers.map((l) => {
        if (l.id !== layerId) return l;
        changed = true;
        const next: CanvasLayer = { ...l };
        if (patch.visible !== undefined) next.visible = patch.visible;
        if (patch.locked !== undefined) next.locked = patch.locked;
        if (patch.opacity !== undefined) {
          next.opacity = clampOpacity(patch.opacity);
        }
        if (patch.name !== undefined) {
          const name = patch.name.trim().slice(0, MAX_LAYER_NAME_CHARS);
          if (name) next.name = name;
          else delete next.name;
        }
        return next;
      });
      if (!changed) return;
      set({
        nodes: s.nodes.map((n) => (n.id === nodeId ? { ...n, layers } : n)),
      });
      scheduleSave();
    },

    removeLayer: (nodeId, layerId) => {
      const s = get();
      const node = s.nodes.find((n) => n.id === nodeId);
      if (!node?.layers) return;
      const target = node.layers.find((l) => l.id === layerId);
      if (!target || target.locked) return;
      const layers = node.layers.filter((l) => l.id !== layerId);
      set({
        nodes: s.nodes.map((n) => (n.id === nodeId ? { ...n, layers } : n)),
      });
      scheduleSave();
    },

    moveLayer: (nodeId, layerId, direction) => {
      const s = get();
      const node = s.nodes.find((n) => n.id === nodeId);
      if (!node?.layers) return;
      const index = node.layers.findIndex((l) => l.id === layerId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= node.layers.length) return;
      if (node.layers[index].locked || node.layers[target].locked) return;
      const layers = [...node.layers];
      [layers[index], layers[target]] = [layers[target], layers[index]];
      set({
        nodes: s.nodes.map((n) => (n.id === nodeId ? { ...n, layers } : n)),
      });
      scheduleSave();
    },

    replaceNodeLayers: (nodeId, layers, historyId, clearRegions) => {
      const s = get();
      if (!s.nodes.some((n) => n.id === nodeId)) return;
      const limited = layers.slice(0, MAX_LAYERS_PER_NODE);
      const base =
        historyId !== undefined && historyId > 0 ? historyId : undefined;
      set({
        nodes: s.nodes.map((n) => {
          if (n.id !== nodeId) return n;
          const next: CanvasNode = {
            ...n,
            layers: limited,
            ...(base ? { historyId: base } : {}),
          };
          if (clearRegions) delete next.regions;
          return next;
        }),
      });
      scheduleSave();
      const ids = limited.flatMap((l) =>
        l.kind === "image" && l.historyId ? [l.historyId] : [],
      );
      if (base) ids.push(base);
      if (ids.length > 0) void get().loadThumbs(ids);
    },

    addRegion: (nodeId, region) => {
      const s = get();
      const node = s.nodes.find((n) => n.id === nodeId);
      if (!node) return null;
      const regions = node.regions ?? [];
      if (regions.length >= MAX_REGIONS_PER_NODE) {
        toast(
          i18n.t("每个节点最多 {{max}} 个区域", {
            max: MAX_REGIONS_PER_NODE,
          }),
          "error",
        );
        return null;
      }
      const id = newId("r");
      const next = [
        ...regions,
        {
          ...region,
          id,
          prompt: region.prompt.slice(0, MAX_REGION_PROMPT_CHARS),
          feather: Math.min(
            MAX_REGION_FEATHER,
            Math.max(0, Math.round(region.feather)),
          ),
        },
      ];
      set({
        nodes: s.nodes.map((n) =>
          n.id === nodeId ? { ...n, regions: next } : n,
        ),
      });
      scheduleSave();
      return id;
    },

    updateRegion: (nodeId, regionId, patch) => {
      const s = get();
      const node = s.nodes.find((n) => n.id === nodeId);
      if (!node?.regions) return;
      const regions = node.regions.map((r) => {
        if (r.id !== regionId) return r;
        const next = { ...r };
        if (patch.prompt !== undefined) {
          next.prompt = patch.prompt.slice(0, MAX_REGION_PROMPT_CHARS);
        }
        if (patch.feather !== undefined && Number.isFinite(patch.feather)) {
          next.feather = Math.min(
            MAX_REGION_FEATHER,
            Math.max(0, Math.round(patch.feather)),
          );
        }
        return next;
      });
      set({
        nodes: s.nodes.map((n) => (n.id === nodeId ? { ...n, regions } : n)),
      });
      scheduleSave();
    },

    removeRegion: (nodeId, regionId) => {
      const s = get();
      const node = s.nodes.find((n) => n.id === nodeId);
      if (!node?.regions) return;
      const regions = node.regions.filter((r) => r.id !== regionId);
      set({
        nodes: s.nodes.map((n) => {
          if (n.id !== nodeId) return n;
          const next: CanvasNode = { ...n };
          if (regions.length > 0) next.regions = regions;
          else delete next.regions;
          return next;
        }),
      });
      scheduleSave();
    },

    markRegionApplied: (nodeId, regionId, appliedHistoryId, appliedLayerId) => {
      const s = get();
      const node = s.nodes.find((n) => n.id === nodeId);
      if (!node?.regions) return;
      const regions = node.regions.map((r) =>
        r.id === regionId ? { ...r, appliedHistoryId, appliedLayerId } : r,
      );
      set({
        nodes: s.nodes.map((n) => (n.id === nodeId ? { ...n, regions } : n)),
      });
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
            const gifIds = { ...s.gifIds };
            for (const row of rows) {
              thumbs[row.historyId] = row.thumbUrl;
              if (row.gif) gifIds[row.historyId] = true;
            }
            return { thumbs, gifIds };
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
