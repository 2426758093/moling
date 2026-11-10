// 未确认计费的挂起标记：模块级单例，生命周期等于应用进程。
//
// 为什么不能只放组件 state：修图台关掉再打开（含画布内嵌实例）会重建组件，
// 标记跟着消失，用户就能直接重发一次可能已经扣费的请求 —— 这和「点掉提示条
// 继续提交」是同一个逃逸口。标记必须活得比任何一次挂载都长。
//
// 只存一份「最新」标记，不按图片分键：没对账之前，任何新的可能扣费动作都先
// 让用户确认。这是刻意的 fail-safe —— 多问一次只是麻烦，漏问一次就是重复扣费；
// 对账（或任意可能扣费动作的成功）之后标记自然解除。

/** 最近一次「可能已计费」且尚未对账的请求；模块级，关掉修图台再打开仍要拦截 */
export interface PendingBilling {
  requestId: string | null;
}

let pending: PendingBilling | null = null;

/** 只读返回：调用方拿到的是当前快照，改它不会影响标记 */
export function pendingBilling(): PendingBilling | null {
  return pending;
}

export function rememberPendingBilling(value: PendingBilling): void {
  pending = { requestId: value.requestId };
}

export function forgetPendingBilling(): void {
  pending = null;
}

/** 仅测试用：清空模块级状态，避免用例之间串味 */
export function resetPendingBilling(): void {
  pending = null;
}
