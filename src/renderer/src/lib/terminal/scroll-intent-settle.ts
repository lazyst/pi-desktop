/**
 * scroll-intent-settle
 *
 * 延迟采样函数：在多个时间点（microtask + rAF × 2 + setTimeout 80ms）分别采样
 * 视口滚动意图，确保 xterm 异步滚动应用后意图稳定正确。
 *
 * 为什么需要多时间点采样：
 * xterm 的 scroll/scrollToLine/scrollToBottom 是异步的——视口位置在 DOM 操作
 * 完成后才更新，而 buffer 的 viewportY/baseY 可能在微任务、rAF 或更晚的时间点
 * 才反映最终状态。单次采样可能捕获中间态，导致意图误判。
 *
 * 使用场景：
 * - 滚轮事件后：wheel handler 触发后，需要等待 xterm 完成异步滚动再采样意图
 * - 滚动条拖拽后：scrollbar 的 drag 事件结束后，视口位置才稳定
 * - 重建完成后：buffer 重建后，需要等待多个帧确保视口位置正确
 */

import {
  syncTerminalScrollIntentFromViewport,
  type TerminalScrollIntentTarget,
} from './scroll-intent'
import { isTerminalScrollIntentRebuildInFlight } from './scroll-intent-rebuild'

// ─── 公开类型 ──────────────────────────────────────────────────────────────

/** syncTerminalScrollIntentSoon 的选项。 */
export type SyncTerminalScrollIntentSoonOptions = {
  /**
   * 条件控制回调：返回 true 时才执行同步。
   * 可用于在特定条件下跳过同步（如重建期间）。
   * 默认：始终同步。
   */
  shouldSync?: () => boolean
}

// ─── 内部状态 ──────────────────────────────────────────────────────────────

/** 每个终端的 pending settle 定时器 id。 */
const pendingSettleTimers = new WeakMap<
  TerminalScrollIntentTarget,
  {
    rafIds: number[]
    timeoutId: ReturnType<typeof setTimeout> | null
    settled: boolean
  }
>()

// ─── 公开 API ──────────────────────────────────────────────────────────────

/**
 * 在多个时间点分别采样视口滚动意图，确保 xterm 异步滚动应用后意图稳定正确。
 *
 * 采样时间点：
 *   1. microtask（Promise.resolve 微任务）
 *   2. rAF（第一帧）
 *   3. rAF（第二帧——xterm 内部异步滚动通常在此帧完成）
 *   4. setTimeout 80ms（兜底，确保极端延迟场景下最终采样）
 *
 * 当任意时间点检测到 pendingSettle 被取消（如新的 sync 调用）时，放弃后续采样。
 *
 * @param terminal 终端目标
 * @param options 选项
 */
export function syncTerminalScrollIntentSoon(
  terminal: TerminalScrollIntentTarget,
  options: SyncTerminalScrollIntentSoonOptions = {},
): void {
  // 取消之前的 pending settle 定时器
  cancelPendingSettle(terminal)

  const state = {
    rafIds: [] as number[],
    timeoutId: null as ReturnType<typeof setTimeout> | null,
    settled: false,
  }
  pendingSettleTimers.set(terminal, state)

  // 标记为已 settle，执行采样
  const settle = (): void => {
    if (state.settled) return
    state.settled = true

    // 清理所有定时器
    for (const rafId of state.rafIds) {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId)
      }
    }
    state.rafIds = []
    if (state.timeoutId !== null) {
      clearTimeout(state.timeoutId)
      state.timeoutId = null
    }
    pendingSettleTimers.delete(terminal)

    // 执行同步
    doSync(terminal, options)
  }

  // 1. microtask 采样
  Promise.resolve().then(() => {
    if (state.settled) return
    doSync(terminal, options)
  })

  // 2. rAF 第一帧
  if (typeof requestAnimationFrame === 'function') {
    const rafId1 = requestAnimationFrame(() => {
      if (state.settled) return
      doSync(terminal, options)

      // 3. rAF 第二帧
      const rafId2 = requestAnimationFrame(() => {
        if (state.settled) return
        doSync(terminal, options)
      })
      state.rafIds.push(rafId2)
    })
    state.rafIds.push(rafId1)
  }

  // 4. setTimeout 80ms 兜底
  state.timeoutId = setTimeout(() => {
    settle()
  }, 80)
}

/**
 * 取消终端的 pending settle 采样。
 * 所有已安排的定时器被清理，不会执行最终同步。
 *
 * @param terminal 终端目标
 */
export function cancelPendingSettle(
  terminal: TerminalScrollIntentTarget,
): void {
  const pending = pendingSettleTimers.get(terminal)
  if (!pending) return

  pending.settled = true
  for (const rafId of pending.rafIds) {
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(rafId)
    }
  }
  pending.rafIds = []
  if (pending.timeoutId !== null) {
    clearTimeout(pending.timeoutId)
    pending.timeoutId = null
  }
  pendingSettleTimers.delete(terminal)
}

// ─── 内部辅助 ──────────────────────────────────────────────────────────────

/**
 * 执行一次同步，受 shouldSync 和 rebuild 保护。
 */
function doSync(
  terminal: TerminalScrollIntentTarget,
  options: SyncTerminalScrollIntentSoonOptions,
): void {
  // 重建保护：重建期间的采样不写入意图
  if (isTerminalScrollIntentRebuildInFlight(terminal)) {
    return
  }

  // shouldSync 条件控制
  if (options.shouldSync && !options.shouldSync()) {
    return
  }

  syncTerminalScrollIntentFromViewport(terminal)
}