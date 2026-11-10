/** 新记录落库后的广播：画廊等常驻列表据此重载，避免停留在旧快照。 */
export const HISTORY_CHANGED_EVENT = "moling:history-changed";

export function emitHistoryChanged() {
  window.dispatchEvent(new CustomEvent(HISTORY_CHANGED_EVENT));
}
