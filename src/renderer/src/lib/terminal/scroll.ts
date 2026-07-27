/**
 * terminal-scroll
 *
 * 使用 xterm IMarker 捕获和恢复终端滚动位置。
 * 支持 deferred restore（通过 rAF/setTimeout 延迟恢复）和
 * pending fit scroll restore（在 fit 后恢复滚动位置）。
 *
 * 移植自 orca 源码的 pane-scroll 模块。
 */

import type { IMarker, Terminal } from '@xterm/xterm'
import {
  captureLogicalLineAnchor,
  resolveLogicalCellOffsetLine,
} from './reflow-scroll-anchor'
import { forceTerminalViewportScrollbarSync } from './scrollbar-sync'
import { safeTerminalScrollCall } from './scroll-buffer-snapshot'

// ===========================================================================
// 公开类型
// ===========================================================================

/**
 * 滚动状态快照。
 * 记录终端在某一时刻的滚动位置和标记，用于后续恢复。
 */
export type ScrollState = {
  /** buffer 类型：'normal'（主 buffer）｜'alternate'（交替 buffer，如 vim/less） */
  bufferType: 'normal' | 'alternate'
  /** 捕获时视口是否在底部 */
  wasAtBottom: boolean
  /** 捕获时的视口行号 */
  viewportY: number
  /** 捕获时的 buffer baseY（总行数） */
  baseY: number
  /** 物理标记：直接标记视口行在 buffer 中的位置，适用于无 reflow 场景 */
  firstVisibleLineMarker?: IMarker
  /** 逻辑标记：锚定在逻辑行的首行，适用于 reflow 场景 */
  firstVisibleLogicalLineMarker?: IMarker
  /** 从逻辑首行到视口行的单元格偏移量 */
  firstVisibleLogicalCellOffset?: number
}

// ===========================================================================
// 内部状态
// ===========================================================================

/** 每个终端的输出纪元计数器。每次记录终端输出时递增。 */
const terminalOutputEpochs = new WeakMap<Terminal, number>()

/** 延迟滚动恢复状态（用于 restoreScrollStateAfterLayout 的 rAF/setTimeout 恢复）。 */
const deferredScrollRestores = new WeakMap<
  object,
  {
    cancelled: boolean
    rafIds: number[]
    state: ScrollState
    timeoutIds: ReturnType<typeof setTimeout>[]
  }
>()

/** 挂起的 fit 滚动恢复状态（用于 restoreScrollStateAfterFit 的重试）。 */
const pendingFitScrollRestores = new WeakMap<
  object,
  {
    cancelled: boolean
    rafId: number | null
    retryAfterFit: () => boolean
    shouldRestore: () => boolean
    state: ScrollState
  }
>()

/** fit 滚动恢复的最大重试帧数。 */
const FIT_SCROLL_RESTORE_MAX_FRAMES = 2

/** 滚动恢复结果类型。 */
type ScrollRestoreResult = 'restored' | 'retry' | 'skipped'

// ===========================================================================
// 输出纪元
// ===========================================================================

/**
 * 记录终端输出事件，递增其纪元计数器。
 * 用于跟踪终端内容是否有新输出。
 *
 * @param terminal - xterm Terminal 实例
 */
export function recordTerminalOutput(terminal: Terminal): void {
  terminalOutputEpochs.set(terminal, getTerminalOutputEpoch(terminal) + 1)
}

/**
 * 获取终端的输出纪元值。
 * 每次 recordTerminalOutput 调用递增 1，初始值为 0。
 *
 * @param terminal - xterm Terminal 实例
 * @returns 当前纪元值
 */
export function getTerminalOutputEpoch(terminal: Terminal): number {
  return terminalOutputEpochs.get(terminal) ?? 0
}

// ===========================================================================
// 取消恢复
// ===========================================================================

/**
 * 取消终端的延迟滚动恢复。
 * 同时取消挂起的 fit 恢复和延迟布局恢复。
 *
 * @param terminal - 终端对象（object 而非 Terminal，以兼容更多场景）
 */
export function cancelDeferredScrollRestore(terminal: object): void {
  cancelPendingFitScrollRestore(terminal)

  const pending = deferredScrollRestores.get(terminal)
  if (!pending) {
    return
  }

  pending.cancelled = true
  if (typeof cancelAnimationFrame === 'function') {
    for (const rafId of pending.rafIds) {
      cancelAnimationFrame(rafId)
    }
  }
  for (const timeoutId of pending.timeoutIds) {
    clearTimeout(timeoutId)
  }
  releaseScrollStateMarker(pending.state)
  deferredScrollRestores.delete(terminal)
}

// ===========================================================================
// 捕获滚动状态
// ===========================================================================

/**
 * 捕获终端的当前滚动状态。
 *
 * 记录 viewportY、baseY、buffer 类型，并创建用于 reflow 后恢复的
 * IMarker。在 normal buffer 且不在底部时，同时创建物理标记和逻辑标记：
 * - 物理标记（firstVisibleLineMarker）：标记当前视口行，适用于无 reflow 场景
 * - 逻辑标记（firstVisibleLogicalLineMarker）：标记逻辑行首行，适用于 reflow 场景
 *
 * @param terminal - xterm Terminal 实例
 * @returns 当前滚动状态快照
 */
export function captureScrollState(terminal: Terminal): ScrollState {
  const buf = terminal.buffer.active
  const viewportY = buf.viewportY
  const wasAtBottom = viewportY >= buf.baseY

  // 仅当不在底部且使用 normal buffer 时捕获逻辑行锚点
  const logicalAnchor =
    !wasAtBottom && buf.type === 'normal'
      ? captureLogicalLineAnchor(terminal, viewportY)
      : undefined

  // 物理标记：直接标记当前视口行在 buffer 中的相对位置
  const firstVisibleLineMarker =
    !wasAtBottom && buf.type === 'normal'
      ? terminal.registerMarker?.(viewportY - (buf.baseY + buf.cursorY))
      : undefined

  return {
    bufferType: buf.type,
    wasAtBottom,
    viewportY,
    baseY: buf.baseY,
    // 物理标记适用于无 reflow 的 ConPTY/光标行场景
    firstVisibleLineMarker,
    // 逻辑标记适用于 reflow 场景，锚定在逻辑行的首行
    firstVisibleLogicalLineMarker:
      logicalAnchor?.lineY === viewportY
        ? firstVisibleLineMarker
        : logicalAnchor
          ? terminal.registerMarker?.(logicalAnchor.lineY - (buf.baseY + buf.cursorY))
          : undefined,
    firstVisibleLogicalCellOffset: logicalAnchor?.cellOffset,
  }
}

// ===========================================================================
// 立即恢复
// ===========================================================================

/**
 * 立即恢复终端的滚动位置。
 *
 * 自动取消任何挂起的延迟恢复，并在恢复完成后释放标记资源。
 *
 * @param terminal - xterm Terminal 实例
 * @param state - 之前捕获的滚动状态
 * @returns true 恢复成功，false 恢复失败或跳过
 */
export function restoreScrollState(terminal: Terminal, state: ScrollState): boolean {
  cancelDeferredScrollRestore(terminal)

  try {
    return restoreScrollStateNow(terminal, state) === 'restored'
  } finally {
    releaseScrollStateMarker(state)
  }
}

// ===========================================================================
// Fit 后恢复
// ===========================================================================

/**
 * 在 fit 操作后恢复终端的滚动位置。
 *
 * 如果初始恢复因终端未就绪（如 WebGL 未完成初始化）而需要重试，
 * 将通过 requestAnimationFrame 循环重试最多 FIT_SCROLL_RESTORE_MAX_FRAMES 次。
 * 若重试帧数耗尽仍未成功，则标记为挂起状态，
 * 可在下次 fit 完成后调用 resumePendingFitScrollRestoreAfterFit 继续恢复。
 *
 * @param terminal - xterm Terminal 实例
 * @param state - 之前捕获的滚动状态
 * @param options.onRestored - 恢复成功后的回调
 * @param options.shouldRestore - 判断是否应该恢复的函数
 */
export function restoreScrollStateAfterFit(
  terminal: Terminal,
  state: ScrollState,
  options: { onRestored: () => void; shouldRestore: () => boolean }
): void {
  cancelDeferredScrollRestore(terminal)

  if (!options.shouldRestore()) {
    releaseScrollStateMarker(state)
    return
  }

  let initialResult: ScrollRestoreResult
  try {
    initialResult = restoreScrollStateNow(terminal, state)
  } catch (error) {
    releaseScrollStateMarker(state)
    throw error
  }

  if (initialResult !== 'retry' || typeof requestAnimationFrame !== 'function') {
    releaseScrollStateMarker(state)
    if (initialResult === 'restored') {
      options.onRestored()
    }
    return
  }

  const pending = {
    cancelled: false,
    rafId: null as number | null,
    retryAfterFit: (): boolean => false,
    shouldRestore: options.shouldRestore,
    state,
  }

  let remainingFrames = FIT_SCROLL_RESTORE_MAX_FRAMES

  const finish = (restored: boolean): void => {
    if (pending.cancelled) {
      return
    }
    pending.cancelled = true
    pendingFitScrollRestores.delete(terminal)
    releaseScrollStateMarker(state)
    if (restored && options.shouldRestore()) {
      options.onRestored()
    }
  }

  const retry = (): boolean => {
    pending.rafId = null

    if (pending.cancelled || !options.shouldRestore()) {
      finish(false)
      return false
    }

    let result: ScrollRestoreResult
    try {
      result = restoreScrollStateNow(terminal, state)
    } catch (error) {
      finish(false)
      throw error
    }

    if (result === 'restored') {
      finish(true)
      return true
    }

    remainingFrames -= 1

    if (result !== 'retry') {
      finish(false)
      return false
    }

    if (remainingFrames <= 0) {
      // 背景标签页/WebGL 关闭可能超出有限帧重试范围。
      // 保留标记以用于后续的 fit/reveal。
      return true
    }

    pending.rafId = requestAnimationFrame(retry)
    return true
  }

  pending.retryAfterFit = (): boolean => {
    if (pending.rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(pending.rafId)
      pending.rafId = null
    }
    remainingFrames = FIT_SCROLL_RESTORE_MAX_FRAMES + 1
    return retry()
  }

  pendingFitScrollRestores.set(terminal, pending)
  pending.rafId = requestAnimationFrame(retry)
}

// ===========================================================================
// 恢复挂起的 fit 滚动恢复
// ===========================================================================

/**
 * 在 fit 后恢复之前挂起的滚动恢复。
 *
 * 当 restoreScrollStateAfterFit 因重试帧数耗尽而暂停后，
 * 可以在下一次 fit 完成后调用此函数继续恢复。
 *
 * @param terminal - xterm Terminal 实例
 * @returns true 恢复成功，false 无需恢复或已取消
 */
export function resumePendingFitScrollRestoreAfterFit(terminal: Terminal): boolean {
  const pending = pendingFitScrollRestores.get(terminal)
  if (!pending) {
    return false
  }

  if (!pending.shouldRestore()) {
    cancelPendingFitScrollRestore(terminal)
    return false
  }

  return pending.retryAfterFit()
}

// ===========================================================================
// 释放标记
// ===========================================================================

/**
 * 释放滚动状态中的 IMarker 资源。
 *
 * 标记被 dispose 后，xterm 会在 buffer 行被回收时自动清理。
 * 同时将 firstVisibleLineMarker 和 firstVisibleLogicalLineMarker 置为 undefined，
 * 防止后续误用。
 *
 * @param state - 滚动状态
 */
export function releaseScrollStateMarker(state: ScrollState): void {
  state.firstVisibleLineMarker?.dispose()
  if (state.firstVisibleLogicalLineMarker !== state.firstVisibleLineMarker) {
    state.firstVisibleLogicalLineMarker?.dispose()
  }
  state.firstVisibleLineMarker = state.firstVisibleLogicalLineMarker = undefined
}

// ===========================================================================
// 内部函数
// ===========================================================================

/**
 * 核心滚动恢复逻辑。
 *
 * 根据滚动状态执行实际的滚动操作：
 * - 如果捕获时在底部，调用 scrollToBottom
 * - 否则根据标记或行号调用 scrollToLine
 * - 优先使用逻辑标记（reflow 兼容），其次物理标记，最后原始行号
 */
function restoreScrollStateNow(terminal: Terminal, state: ScrollState): ScrollRestoreResult {
  if (!terminal.element) {
    return 'retry'
  }

  const buf = terminal.buffer.active

  // 如果 buffer 类型不匹配（如捕获时为 alternate 但当前为 normal），跳过恢复
  if (state.bufferType === 'alternate' || buf.type !== state.bufferType) {
    return 'skipped'
  }

  // WebGL suspend 会释放 xterm 的 render service，但保留 terminal.element，
  // 此时 scrollToBottom/scrollToLine 都会抛出 "cannot read dimensions" 错误。
  // 静默处理，等待下一次 visibility 切换后重新恢复。
  if (state.wasAtBottom) {
    if (safeTerminalScrollCall(() => terminal.scrollToBottom())) {
      forceTerminalViewportScrollbarSync(terminal)
      return 'restored'
    }
    return 'retry'
  }

  // 优先使用逻辑标记行（适用于 reflow 场景，标记在 reflow 后自动更新）
  const logicalMarkerLine =
    state.firstVisibleLogicalLineMarker && !state.firstVisibleLogicalLineMarker.isDisposed
      ? state.firstVisibleLogicalLineMarker.line
      : -1
  // 其次使用物理标记行
  const markerLine =
    state.firstVisibleLineMarker && !state.firstVisibleLineMarker.isDisposed
      ? state.firstVisibleLineMarker.line
      : -1
  // 如果有逻辑标记和单元格偏移，解析目标行（处理 reflow 后的行偏移）
  const logicalTargetLine =
    logicalMarkerLine >= 0 && state.firstVisibleLogicalCellOffset !== undefined
      ? resolveLogicalCellOffsetLine(
          terminal,
          logicalMarkerLine,
          state.firstVisibleLogicalCellOffset
        )
      : null

  // 目标行：逻辑行 > 物理标记行 > 原始行号，并裁剪到当前 buffer 范围内
  const targetLine = Math.min(
    logicalTargetLine ?? (markerLine >= 0 ? markerLine : state.viewportY),
    buf.baseY
  )

  state.viewportY = targetLine

  if (safeTerminalScrollCall(() => terminal.scrollToLine(targetLine))) {
    forceTerminalViewportScrollbarSync(terminal)
    return 'restored'
  }

  return 'retry'
}

/**
 * 取消挂起的 fit 滚动恢复。
 * 清理 pendingFitScrollRestores 中的条目并释放标记。
 */
function cancelPendingFitScrollRestore(terminal: object): void {
  const pending = pendingFitScrollRestores.get(terminal)
  if (!pending) {
    return
  }

  pending.cancelled = true
  if (pending.rafId !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(pending.rafId)
  }
  releaseScrollStateMarker(pending.state)
  pendingFitScrollRestores.delete(terminal)
}
