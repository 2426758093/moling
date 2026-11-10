/// 全局快捷键的唯一清单：UI 一览与键盘处理共用，避免两处写法漂移。
export interface ShortcutDef {
  /// 展示用组合键（Windows 习惯写法）
  keys: string;
  label: string;
  group: "全局" | "画布" | "列表";
}

export const SHORTCUTS: ShortcutDef[] = [
  { keys: "Ctrl K", label: "打开命令面板", group: "全局" },
  { keys: "Ctrl B", label: "折叠 / 展开侧栏", group: "全局" },
  { keys: "Ctrl N", label: "新建对话", group: "全局" },
  {
    keys: "Ctrl 1–6",
    label: "切换聊天 / 画廊 / 画布 / 队列 / 修图 / 设置",
    group: "全局",
  },
  { keys: "Ctrl ,", label: "打开设置", group: "全局" },
  { keys: "Ctrl F", label: "搜索对话", group: "全局" },
  { keys: "F1", label: "快捷键一览", group: "全局" },
  { keys: "Esc", label: "关闭浮层 / 退出连线", group: "全局" },
  { keys: "Ctrl S", label: "立即保存画布", group: "画布" },
  { keys: "Ctrl L", label: "打开 / 关闭图层面板", group: "画布" },
  { keys: "Alt ↑ / ↓", label: "图层上移 / 下移", group: "画布" },
  { keys: "Ctrl 0", label: "适应画布视图", group: "画布" },
  { keys: "Ctrl + / −", label: "放大 / 缩小画布", group: "画布" },
  { keys: "Ctrl V", label: "把剪贴板图片粘贴到画布", group: "画布" },
  { keys: "Delete", label: "删除选中的节点或连线", group: "画布" },
  { keys: "Space", label: "播放 / 暂停动图", group: "画布" },
  { keys: "← / →", label: "切换动图帧", group: "画布" },
  { keys: "Shift 点击", label: "画廊连续多选", group: "列表" },
  { keys: "Ctrl A", label: "画廊全选已加载作品", group: "列表" },
];

/// 输入控件里只允许"带修饰键"的组合触发全局命令；F1 例外。
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable === true
  );
}

/// 中文输入法组合期 keydown 的 key 不可信，统一拦截。
export function isComposingEvent(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
}

/// 判断事件是否命中 "Ctrl+K" 这类组合。Ctrl 与 Cmd 视为同一修饰键，
/// 键名比较忽略大小写，"+" / "=" 等价。
export function matchesShortcut(e: KeyboardEvent, combo: string): boolean {
  const parts = combo.split("+").map((p) => p.trim().toLowerCase());
  const key = parts[parts.length - 1];
  const wantCtrl = parts.includes("ctrl") || parts.includes("cmd");
  const wantShift = parts.includes("shift");
  const wantAlt = parts.includes("alt");
  const mod = e.ctrlKey || e.metaKey;
  if (wantCtrl !== mod || wantShift !== e.shiftKey || wantAlt !== e.altKey) {
    return false;
  }
  const pressed = e.key.toLowerCase();
  return pressed === key || (key === "=" && pressed === "+");
}
