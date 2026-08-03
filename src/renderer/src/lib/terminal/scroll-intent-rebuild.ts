/**
 * scroll-intent-rebuild
 *
 * 终端 buffer 重建期间的滚动意图保护机制。
 * 使用计数器模式支持嵌套 begin/end：每次 begin 递增计数器，end 递减计数器，
 * 归零时自动触发滚动意图恢复。
 *
 * 在 buffer 重建（snapshot replay、remount、clear）期间，xterm 的 buffer 被清空
 * 并重新填充，此时视口位置会丢失。本模块在重建期间临时保护意图不被覆盖，
 * 并在重建完成后按存储的意图自动恢复视口位置。
 */

import {
  forceRestoreTerminalScrollIntent,
  captureTerminalStructuralScrollIntent,
  type TerminalScrollIntentTarget,
  type TerminalStructuralScrollIntentSnapshot,
} from './scroll-intent'

// ─── 内部状态 ──────────────────────────────────────────────────────────────

/** 每个终端的重建嵌套计数器。 */
const rebuildCounters = new WeakMap<TerminalScrollIntentTarget, number>()

/** 每个终端在 begin 时捕获的意图快照，用于 end 时恢复。 */
const rebuildSnapshots = new WeakMap<
  TerminalScrollIntentTarget,
  TerminalStructuralScrollIntentSnapshot
>()

// ─── 公开 API ──────────────────────────────────────────────────────────────

/**
 * 开始 buffer 重建，递增计数器。
 * 首次调用时捕获当前滚动意图快照，用于后续恢复。
 * 后续嵌套调用仅递增计数器，不重复捕获。
 *
 * @param terminal 终端目标
 */
export function beginTerminalScrollIntentBufferRebuild(
  terminal: TerminalScrollIntentTarget,
): void {
  const current = rebuildCounters.get(terminal) ?? 0
  if (current === 0) {
    // 首次 begin：捕获意图快照
    const snapshot = captureTerminalStructuralScrollIntent(terminal)
    if (snapshot) {
      rebuildSnapshots.set(terminal, snapshot)
    }
  }
  rebuildCounters.set(terminal, current + 1)
}

/**
 * 结束 buffer 重建，递减计数器。
 * 计数器归零时触发滚动意图恢复（使用 begin 时捕获的快照）。
 * 无匹配的 begin 调用时静默无操作。
 *
 * @param terminal 终端目标
 */
export function endTerminalScrollIntentBufferRebuild(
  terminal: TerminalScrollIntentTarget,
): void {
  const current = rebuildCounters.get(terminal)
  if (current === undefined || current <= 0) {
    // 无匹配的 begin 调用，静默返回
    return
  }

  const next = current - 1
  if (next === 0) {
    // 计数器归零：清除计数器并触发恢复
    rebuildCounters.delete(terminal)
    const snapshot = rebuildSnapshots.get(terminal)
    rebuildSnapshots.delete(terminal)
    if (snapshot) {
      // 使用 begin 时捕获的快照恢复滚动意图
      // 采用 forceRestoreTerminalScrollIntent 跳过 revision 检查，
      // 确保重建期间意图被覆盖时也能正确恢复
      forceRestoreTerminalScrollIntent(terminal, snapshot)
    }
  } else {
    rebuildCounters.set(terminal, next)
  }
}

/**
 * 查询终端是否正在 buffer 重建中。
 *
 * @param terminal 终端目标
 * @returns true 表示有正在进行的重建（计数器 > 0）
 */
export function isTerminalScrollIntentRebuildInFlight(
  terminal: TerminalScrollIntentTarget,
): boolean {
  return (rebuildCounters.get(terminal) ?? 0) > 0
}