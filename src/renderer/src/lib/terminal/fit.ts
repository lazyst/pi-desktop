/**
 * terminal-fit
 *
 * 提供在 fit 操作前后捕获和恢复滚动位置的 safe fit 函数，
 * 确保 resize 不丢失视口位置。
 *
 * 移植自 orca 源码的 pane-fit 模块，简化版本：
 * - 去掉 mobile-fit-overrides 依赖
 * - 去掉 terminal-scroll-intent-rebuild 依赖
 */

import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import {
  captureTerminalStructuralScrollIntent,
  isTerminalStructuralScrollIntentCurrent,
  markTerminalPinnedViewport,
  restoreTerminalStructuralScrollIntent,
} from './scroll-intent'
import {
  captureScrollState,
  releaseScrollStateMarker,
  restoreScrollStateAfterFit,
  resumePendingFitScrollRestoreAfterFit,
  type ScrollState,
} from './scroll'

// ─── 公开类型 ──────────────────────────────────────────────────────────────

/** ManagedPane 的最小接口。只需要 fit、scroll 所需的三个属性。 */
export interface ManagedPane {
  terminal: Terminal
  fitAddon: FitAddon
  container: HTMLElement
}

/** 延续操作句柄，用于 safeFitAndThen 的调用者控制。 */
export type SafeFitContinuationHandle = {
  /** 延续操作的完成状态 Promise。true 表示成功执行，false 表示取消或失败。 */
  completion: Promise<boolean>
  /** 取消挂起的延续操作。 */
  cancel: () => void
}

// ─── 内部常量 ──────────────────────────────────────────────────────────────

/** 最小可测量的 pane 宽度（px）。低于此值跳过 fit。 */
const MIN_PANE_FIT_WIDTH_PX = 48
/** 最小可测量的 pane 高度（px）。低于此值跳过 fit。 */
const MIN_PANE_FIT_HEIGHT_PX = 24
/** fit 的最小列数。低于此值跳过 fit。 */
const MIN_PANE_FIT_COLS = 8
/** fit 的最小行数。低于此值跳过 fit。 */
const MIN_PANE_FIT_ROWS = 4

// ─── 内部类型 ──────────────────────────────────────────────────────────────

type PendingSafeFitContinuation = {
  continuation: () => void
  shouldContinue: () => boolean
  resolve: (completed: boolean) => void
}

// ─── 内部状态 ──────────────────────────────────────────────────────────────

const pendingSafeFitContinuations = new WeakMap<
  ManagedPane,
  Map<string, PendingSafeFitContinuation>
>()

// ─── 内部辅助函数 ──────────────────────────────────────────────────────────

/**
 * 获取 fitAddon 提议的尺寸。
 */
function getProposedDimensions(
  pane: ManagedPane,
): { cols: number; rows: number } | null {
  try {
    return pane.fitAddon.proposeDimensions() ?? null
  } catch {
    return null
  }
}

/**
 * 检查 pane 是否满足 fit 的测量条件。
 */
function canMeasurePaneForFit(pane: ManagedPane): boolean {
  const measure = pane.container?.getBoundingClientRect
  if (typeof measure === 'function') {
    const rect = measure.call(pane.container)
    if (rect.width < MIN_PANE_FIT_WIDTH_PX || rect.height < MIN_PANE_FIT_HEIGHT_PX) {
      return false
    }
  }

  const dims = getProposedDimensions(pane)
  if (!dims) {
    return false
  }

  // 工作区切换可能短暂测量到近零的覆盖层，此时 fit 会将 PTY 锁定在极小尺寸
  return dims.cols >= MIN_PANE_FIT_COLS && dims.rows >= MIN_PANE_FIT_ROWS
}

/**
 * 执行带滚动位置捕获和恢复的 fit。
 *
 * @param pane - ManagedPane 实例
 * @param preserveScroll - 是否在 fit 前后捕获和恢复滚动位置
 * @returns true fit 成功执行，false 因尺寸不足或异常跳过
 */
function performSafeFit(pane: ManagedPane, preserveScroll: boolean): boolean {
  if (!canMeasurePaneForFit(pane)) {
    return false
  }

  let scrollIntent: ReturnType<
    typeof captureTerminalStructuralScrollIntent
  > = null
  let pinnedScrollState: ScrollState | null = null
  let shouldRestoreScroll = false

  const captureScrollForFit = (): void => {
    scrollIntent = captureTerminalStructuralScrollIntent(pane.terminal)
    pinnedScrollState =
      scrollIntent?.kind === 'pinnedViewport'
        ? captureScrollState(pane.terminal)
        : null
    shouldRestoreScroll = true
  }

  try {
    const dims = getProposedDimensions(pane)
    if (
      dims &&
      dims.cols === pane.terminal.cols &&
      dims.rows === pane.terminal.rows
    ) {
      // 尺寸未变化：恢复挂起的 fit 滚动恢复，避免不必要的 clear/refresh 抖动
      resumePendingFitScrollRestoreAfterFit(pane.terminal)
      return true
    }

    if (preserveScroll) {
      captureScrollForFit()
    }

    pane.fitAddon.fit()
    return true
  } catch {
    // 容器可能还没有尺寸
    return false
  } finally {
    if (shouldRestoreScroll) {
      try {
        if (resumePendingFitScrollRestoreAfterFit(pane.terminal)) {
          // 已由挂起的恢复处理，无需额外操作
        } else if (pinnedScrollState) {
          const state: ScrollState = pinnedScrollState
          pinnedScrollState = null
          restoreScrollStateAfterFit(pane.terminal, state, {
            onRestored: () => {
              if (!state.wasAtBottom) {
                markTerminalPinnedViewport(pane.terminal)
              }
            },
            shouldRestore: () =>
              isTerminalStructuralScrollIntentCurrent(
                pane.terminal,
                scrollIntent,
              ),
          })
        } else {
          restoreTerminalStructuralScrollIntent(pane.terminal, scrollIntent)
        }
      } catch {
        // SSH 重连可能短暂暴露无渲染器尺寸的 xterm
      } finally {
        if (pinnedScrollState) {
          releaseScrollStateMarker(pinnedScrollState)
        }
      }
    }
  }
}

// ─── 延续操作管理 ──────────────────────────────────────────────────────────

/**
 * 结算（完成/取消）一个挂起的延续操作。
 */
function settlePendingSafeFitContinuation(
  pane: ManagedPane,
  operationKey: string,
  pending: PendingSafeFitContinuation,
  completed: boolean,
): void {
  const operations = pendingSafeFitContinuations.get(pane)
  if (operations?.get(operationKey) !== pending) {
    return
  }

  operations.delete(operationKey)
  if (operations.size === 0) {
    pendingSafeFitContinuations.delete(pane)
  }
  pending.resolve(completed)
}

/**
 * 刷新 pane 的所有挂起延续操作。
 * 在每个操作检查 shouldContinue 后执行 continuation。
 */
function flushPendingSafeFitContinuations(pane: ManagedPane): void {
  const operations = pendingSafeFitContinuations.get(pane)
  if (!operations) {
    return
  }

  for (const [operationKey, pending] of operations) {
    if (!pending.shouldContinue()) {
      settlePendingSafeFitContinuation(pane, operationKey, pending, false)
      continue
    }

    try {
      pending.continuation()
      settlePendingSafeFitContinuation(pane, operationKey, pending, true)
    } catch {
      settlePendingSafeFitContinuation(pane, operationKey, pending, false)
    }
  }
}

// ─── 公开 API ──────────────────────────────────────────────────────────────

/**
 * 安全地执行 terminal fit，在 fit 前后捕获和恢复滚动位置。
 *
 * @param pane - ManagedPane 实例
 * @param options.preserveScroll - 是否保留滚动位置（默认 true）
 * @returns true fit 成功执行，false 因尺寸不足或异常跳过
 */
export function safeFit(
  pane: ManagedPane,
  options?: { preserveScroll?: boolean },
): boolean {
  const preserveScroll = options?.preserveScroll ?? true
  const completed = performSafeFit(pane, preserveScroll)

  if (completed) {
    // replay 事务可能正在等待渲染器尺寸；任何成功的普通 fit
    // 都是让 PTY grid 变得权威的事件
    flushPendingSafeFitContinuations(pane)
  }

  return completed
}

/**
 * 取消 pane 的所有挂起延续操作。
 * 每个操作的 completion Promise 将以 false 决议。
 *
 * @param pane - ManagedPane 实例
 */
export function cancelPendingSafeFitContinuations(pane: ManagedPane): void {
  const operations = pendingSafeFitContinuations.get(pane)
  if (!operations) {
    return
  }

  pendingSafeFitContinuations.delete(pane)
  for (const pending of operations.values()) {
    pending.resolve(false)
  }
}

/**
 * 注册一个在可测量 fit 后执行的延续操作。
 *
 * 当调用者需要将 xterm 的 grid 转发给 PTY 时，
 * 必须等待可测量的 fit 或显式的生命周期取消。
 *
 * @param pane - ManagedPane 实例
 * @param operationKey - 操作键，用于去重和取消
 * @param continuation - fit 后执行的延续函数
 * @returns 包含完成状态和取消函数的句柄
 */
export function safeFitAndThen(
  pane: ManagedPane,
  operationKey: string,
  continuation: () => void,
): SafeFitContinuationHandle {
  const operations = pendingSafeFitContinuations.get(pane) ?? new Map()
  const replaced = operations.get(operationKey)
  if (replaced) {
    settlePendingSafeFitContinuation(pane, operationKey, replaced, false)
  }

  let resolveCompletion = (_completed: boolean): void => {}
  const completion = new Promise<boolean>((resolve) => {
    resolveCompletion = resolve
  })

  const pending: PendingSafeFitContinuation = {
    continuation,
    shouldContinue: () => true,
    resolve: resolveCompletion,
  }

  const currentOperations =
    pendingSafeFitContinuations.get(pane) ?? operations
  currentOperations.set(operationKey, pending)
  pendingSafeFitContinuations.set(pane, currentOperations)

  const cancel = (): void => {
    settlePendingSafeFitContinuation(pane, operationKey, pending, false)
  }

  if (!pending.shouldContinue()) {
    cancel()
    return { completion, cancel }
  }

  // 立即执行一次 safeFit 以触发延续
  safeFit(pane)
  return { completion, cancel }
}
