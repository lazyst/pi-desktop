/**
 * foreground-render-settle —— 前台终端写入后渲染 settle
 *
 * 移植自 Orca 的 pane-terminal-foreground-render-settle.ts。
 *
 * ## 为什么需要
 *
 * 当终端输出写入后，xterm 可能更新视口（滚动到新行）。此时如果只刷新一次，
 * Chromium 可能在 "freshly scrolled top row" 上落后一帧，导致用户看到未完全
 * 渲染的行。本模块在写后做一次额外 settle，确保视口完全稳定。
 *
 * ## 机制
 *
 * 1. 写前捕获视口快照（baseY/viewportY）
 * 2. 写后刷新可见行
 * 3. 如果视口在写期间发生变化（baseY 或 viewportY 变化），调度一次
 *    requestAnimationFrame settle refresh，确保滚动后的首行正确渲染
 * 4. 使用 runGuardedWriteCompletionStep 保护回调，防止异常卡死 xterm WriteBuffer
 */

import { runGuardedWriteCompletionStep } from './write-callback-guard'

/** 前台终端输出目标（xterm Terminal 的子集，便于测试 mock）。 */
export type ForegroundTerminalOutputTarget = {
  buffer?: {
    active?: {
      cursorY?: number
      baseY?: number
      viewportY?: number
    }
  }
  rows?: number
  _core?: {
    refresh?(start: number, end: number, sync?: boolean): void
  }
  refresh?(start: number, end: number): void
  write(data: string, callback?: () => void): void
}

/** 前台终端写入选项。 */
export type ForegroundTerminalWriteOptions = {
  /** 是否强制写后刷新视口（捕获快照 → 比较 → settle）。默认 true（前台写入时启用）。 */
  forceViewportRefresh?: boolean
  /** 是否始终调度 followup viewport settle（即使视口未变化）。默认 false。 */
  followupViewportRefresh?: boolean
  /** 同步刷新视口的条件判断函数。默认始终同步。 */
  shouldRefreshViewportSynchronously?: () => boolean
  /** 写入被 xterm 解析后的回调。 */
  onParsed?: () => void
  /** 写入失败时的回调。 */
  onWriteFailure?: () => void
}

// ─── 模块级状态 ───────────────────────────────────────────────────────────────

/** 每终端挂起的视口 settle 刷新。 */
const pendingViewportSettleRefreshByTerminal = new WeakMap<
  ForegroundTerminalOutputTarget,
  { kind: 'raf'; id: number } | { kind: 'timeout'; id: ReturnType<typeof setTimeout> }
>()

// ─── 视口快照 ─────────────────────────────────────────────────────────────────

type ViewportSnapshot = {
  baseY: number | null
  viewportY: number | null
}

function captureViewportSnapshot(terminal: ForegroundTerminalOutputTarget): ViewportSnapshot {
  return {
    baseY:
      typeof terminal.buffer?.active?.baseY === 'number' ? terminal.buffer.active.baseY : null,
    viewportY:
      typeof terminal.buffer?.active?.viewportY === 'number'
        ? terminal.buffer.active.viewportY
        : null,
  }
}

function viewportChangedDuringWrite(
  terminal: ForegroundTerminalOutputTarget,
  beforeWrite: ViewportSnapshot,
): boolean {
  const afterWrite = captureViewportSnapshot(terminal)
  return (
    afterWrite.baseY !== null &&
    afterWrite.viewportY !== null &&
    (afterWrite.baseY !== beforeWrite.baseY || afterWrite.viewportY !== beforeWrite.viewportY)
  )
}

// ─── 刷新 ─────────────────────────────────────────────────────────────────────

function refreshVisibleRows(
  terminal: ForegroundTerminalOutputTarget,
  synchronously: boolean,
): void {
  if (typeof terminal.rows !== 'number' || terminal.rows < 1) {
    return
  }

  const start = 0
  const end = Math.max(0, terminal.rows - 1)

  try {
    // 同步刷新：通过 _core.refresh(0, rows-1, sync=true) 直接驱动 WebGL/DOM 渲染
    if (synchronously && typeof terminal._core?.refresh === 'function') {
      terminal._core.refresh(start, end, true)
      return
    }
    // 异步刷新：标准 refresh API
    if (typeof terminal.refresh === 'function') {
      terminal.refresh(start, end)
      return
    }
    // 兜底：通过 _core 异步刷新
    terminal._core?.refresh?.(start, end, false)
  } catch {
    // 已销毁的终端忽略错误
  }
}

// ─── Settle 调度 ──────────────────────────────────────────────────────────────

function cancelScheduledViewportSettleRefresh(
  terminal: ForegroundTerminalOutputTarget,
): void {
  const pending = pendingViewportSettleRefreshByTerminal.get(terminal)
  if (!pending) {
    return
  }
  pendingViewportSettleRefreshByTerminal.delete(terminal)
  if (pending.kind === 'raf') {
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(pending.id)
    }
    return
  }
  clearTimeout(pending.id)
}

function scheduleViewportSettleRefresh(
  terminal: ForegroundTerminalOutputTarget,
  shouldRefreshSynchronously?: () => boolean,
): void {
  cancelScheduledViewportSettleRefresh(terminal)

  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(() => {
      pendingViewportSettleRefreshByTerminal.delete(terminal)
      refreshVisibleRows(terminal, shouldRefreshSynchronously?.() ?? true)
    })
    pendingViewportSettleRefreshByTerminal.set(terminal, { kind: 'raf', id })
    return
  }

  // 无 rAF 环境（如测试）回退到 setTimeout(16ms)
  const id = setTimeout(() => {
    pendingViewportSettleRefreshByTerminal.delete(terminal)
    refreshVisibleRows(terminal, shouldRefreshSynchronously?.() ?? true)
  }, 16)
  pendingViewportSettleRefreshByTerminal.set(terminal, { kind: 'timeout', id })
}

// ─── Settle 执行 ──────────────────────────────────────────────────────────────

function settleForegroundRender(
  terminal: ForegroundTerminalOutputTarget,
  beforeWriteViewport: ViewportSnapshot,
  options: ForegroundTerminalWriteOptions,
): void {
  // 写后立即刷新可见行
  refreshVisibleRows(terminal, options.shouldRefreshViewportSynchronously?.() ?? true)

  // 如果视口在写期间滚动，调度一次 rAF settle 刷新
  // 这确保 Chromium 在渲染"freshly scrolled top row"时不会落后一帧
  if (
    options.followupViewportRefresh ||
    viewportChangedDuringWrite(terminal, beforeWriteViewport)
  ) {
    scheduleViewportSettleRefresh(terminal, options.shouldRefreshViewportSynchronously)
  }
}

// ─── 公开 API ─────────────────────────────────────────────────────────────────

/**
 * 写入一段前台终端数据，并确保写后渲染 settle。
 *
 * 流程：
 * 1. 写前捕获视口快照
 * 2. 执行 terminal.write(data, callback)
 * 3. 在回调中：刷新可见行，检测视口变化，必要时调度 rAF settle
 *
 * 返回 true 表示写入被接受，false 表示同步写入失败。
 * 注意：即使写入被接受，解析回调中的渲染错误不会导致返回 false。
 */
export function writeForegroundTerminalChunk(
  terminal: ForegroundTerminalOutputTarget,
  data: string,
  options: ForegroundTerminalWriteOptions = {},
): boolean {
  const beforeWriteViewport = options.forceViewportRefresh
    ? captureViewportSnapshot(terminal)
    : null

  // 解析完成后的处理步骤：先 settle 渲染，再调 onParsed
  const runParsedSteps = (): void => {
    if (beforeWriteViewport) {
      runGuardedWriteCompletionStep('foreground-render-settle', () =>
        settleForegroundRender(terminal, beforeWriteViewport, options),
      )
    }
    if (options.onParsed) {
      runGuardedWriteCompletionStep('foreground-on-parsed', options.onParsed)
    }
  }

  try {
    terminal.write(data, runParsedSteps)
    return true
  } catch {
    // 同步写入失败：触发 onWriteFailure（不调用 runParsedSteps）
    if (options.onWriteFailure) {
      runGuardedWriteCompletionStep('foreground-on-write-failure', options.onWriteFailure)
    }
    return false
  }
}

/**
 * 丢弃指定终端的 pending settle 刷新。
 * 在终端销毁或 active 切换时调用，避免内存泄漏。
 */
export function discardForegroundRenderSettle(
  terminal: ForegroundTerminalOutputTarget,
): void {
  cancelScheduledViewportSettleRefresh(terminal)
}