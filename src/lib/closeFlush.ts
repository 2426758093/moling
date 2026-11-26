import { getCurrentWindow } from "@tauri-apps/api/window";

export interface CloseFlushOptions {
  /** 关闭前执行的落盘动作（如画布 debounce 保存的 flush）；缺省则只接管关闭流程。 */
  flush?: () => Promise<void>;
  /** 关闭前确认；返回 false 时取消本次关闭（窗口保持打开）。 */
  confirm?: () => Promise<boolean>;
  /** 等待落盘的上限；超时后照常关闭，避免窗口关不掉。 */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3000;

/**
 * 接管窗口关闭（F-010）：画布 store 有 600ms debounce 保存，进程直接退出会丢最后一次编辑。
 *
 * Tauri 2 的语义：JS 侧注册 onCloseRequested 后，Rust 会先 prevent_close，再由这里调用
 * destroy() 真正关闭。因此 handler 里必须先 preventDefault()，且 finally 里必须 destroy，
 * 否则用户点关闭会毫无反应。
 *
 * 返回卸载函数；StrictMode/HMR 会重复执行 effect，调用方用 cancelled 标记丢弃迟到的安装结果。
 */
export async function installCloseFlush(
  options: CloseFlushOptions = {},
): Promise<() => void> {
  const { flush, confirm, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const appWindow = getCurrentWindow();
  // 重入保护：落盘未完成时用户再次点关闭，不应并发 flush/destroy
  let closing = false;

  return appWindow.onCloseRequested(async (event) => {
    event.preventDefault();
    if (closing) return;
    closing = true;
    // 用户取消关闭时只复位状态，不能 destroy
    let cancelled = false;
    try {
      if (confirm) {
        // 确认框自身出错不能把窗口锁死：按「允许关闭」处理
        cancelled = !(await confirm().catch(() => true));
      }
      if (!cancelled && flush) {
        // flush 自身吞掉失败（canvasStore.flush 已 toast），这里再做一层兜底：
        // 落盘永远不能阻止窗口关闭，只能最多等 timeoutMs。
        let timer: number | undefined;
        try {
          await Promise.race([
            flush().catch(() => undefined),
            new Promise<void>((resolve) => {
              timer = window.setTimeout(resolve, timeoutMs);
            }),
          ]);
        } finally {
          if (timer !== undefined) window.clearTimeout(timer);
        }
      }
    } finally {
      // 失败/超时/重复关闭都会走到这里：真正关闭窗口；用户取消则跳过
      if (!cancelled) await appWindow.destroy().catch(() => undefined);
      closing = false;
    }
  });
}
