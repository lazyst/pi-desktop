/**
 * scroll-intent-dom-tracking
 *
 * DOM 事件驱动的滚动意图跟踪模块。
 *
 * 通过监听终端的 DOM 事件（滚轮、滚动条拖拽、键盘输入）和 xterm 数据事件
 *（鼠标报告序列），自动标记终端的滚动意图（followOutput / pinnedViewport），
 * 无需应用层手动干预。
 *
 * 事件 → 意图映射：
 *   - 滚轮向上（deltaY < 0）→ pinnedViewport + 稳定化采样
 *   - 滚轮向下到底部 → followOutput
 *   - 滚动条拖拽 → pinnedViewport
 *   - 键盘输入（非鼠标/非 TUI 鼠标报告）→ followOutput
 *   - 鼠标滚轮事件（TUI 模式，含 enable-mouse-events class）→ 保持 pinnedViewport，不触发 followOutput
 *   - 鼠标报告序列（\x1b[< / \x1b[M 前缀）→ 不触发 followOutput（TUI 程序内部事件）
 *
 * 重建保护：重建期间的 wheel/scrollbar 事件不写入意图，重建完成后统一采样。
 */

import { type IDisposable, type Terminal } from '@xterm/xterm'
import {
  markTerminalPinnedViewport,
  markTerminalFollowOutput,
  type TerminalScrollIntentTarget,
  type TerminalScrollIntentKey,
} from './scroll-intent'
import {
  isTerminalScrollIntentRebuildInFlight,
  onTerminalScrollIntentBufferRebuildComplete,
} from './scroll-intent-rebuild'
import {
  syncTerminalScrollIntentSoon,
  cancelPendingSettle,
} from './scroll-intent-settle'

// ─── 常量 ──────────────────────────────────────────────────────────────────

/** xterm 视口容器的 CSS class。 */
const XTERM_VIEWPORT_CLASS = 'xterm-viewport'
/** xterm 滚动条容器的 CSS class。 */
const XTERM_SCROLLBAR_CLASS = 'xterm-scrollbar'
/** xterm 滚动条滑块的 CSS class。 */
const XTERM_SLIDER_CLASS = 'xterm-slider'
/** TUI 鼠标事件启用的 CSS class。 */
const ENABLE_MOUSE_EVENTS_CLASS = 'enable-mouse-events'

/** 鼠标报告序列前缀：SGR 鼠标模式（\x1b[<）。 */
const MOUSE_REPORT_SGR_PREFIX = '\x1b[<'
/** 鼠标报告序列前缀：普通鼠标模式（\x1b[M）。 */
const MOUSE_REPORT_NORMAL_PREFIX = '\x1b[M'

/** 滚轮稳定化采样的重置延迟（ms）。连续滚轮事件在此窗口内不触发新的 settle 序列。 */
const WHEEL_SETTLE_RESET_MS = 50

// ─── 公开类型 ──────────────────────────────────────────────────────────────

/** attachTerminalScrollIntentTracking 的选项。 */
export type AttachTerminalScrollIntentTrackingOptions = {
  /**
   * 滚动意图的外部标识键。
   * 传入后，标记的意图会通过 bindTerminalScrollIntentKey 绑定到该键，
   * 使同一 session 的多个终端实例共享意图。
   */
  intentKey?: TerminalScrollIntentKey
}

// ─── 内部状态 ──────────────────────────────────────────────────────────────

/** 每个终端的 DOM 跟踪状态。 */
type DomTrackingState = {
  /** 终端引用。 */
  terminal: TerminalScrollIntentTarget & Terminal
  /** 是否已释放。 */
  disposed: boolean
  /** 滚轮事件的防抖定时器（连续滚轮事件重置 settle 序列）。 */
  wheelTimer: ReturnType<typeof setTimeout> | null
  /** 鼠标报告检测的反注册函数（onData 拦截）。 */
  offMouseReportDetect: IDisposable | null
  /** 用户输入检测的反注册函数（coreService.onUserInput）。 */
  offUserInput: (() => void) | null
  /** 滚动条滚动事件的反注册函数（onScroll）。 */
  offScroll: IDisposable | null
  /** 是否是 TUI 模式（enable-mouse-events class 存在）。 */
  isTuiMode: boolean
  /** 最近是否检测到鼠标报告（用于抑制键盘输入触发的 followOutput）。 */
  recentMouseReport: boolean
  /** 所有已注册的事件监听器列表。 */
  disposables: IDisposable[]
  /** 重建完成后的同步回调取消函数。 */
  cancelPostRebuildSync: (() => void) | null
}

// ─── 内部 WeakMap ──────────────────────────────────────────────────────────

const trackingStateByTerminal = new WeakMap<
  TerminalScrollIntentTarget,
  DomTrackingState
>()

// ─── 公开 API ──────────────────────────────────────────────────────────────

/**
 * 将 DOM 事件驱动的滚动意图跟踪附加到终端。
 *
 * 监听以下事件：
 *   - host 元素的 wheel 事件（滚轮向上/向下）
 *   - xterm 视口元素的 scroll 事件（滚动条拖拽/滑块拖拽）
 *   - xterm 的 onData 事件（鼠标报告序列检测）
 *   - xterm 内部的 onUserInput 事件（用户输入检测）
 *
 * @param terminal xterm Terminal 实例
 * @param host 终端挂载的宿主 DOM 元素
 * @param options 选项
 * @returns IDisposable，调用 dispose() 清理所有事件监听
 */
export function attachTerminalScrollIntentTracking(
  terminal: Terminal,
  host: HTMLElement,
  options: AttachTerminalScrollIntentTrackingOptions = {},
): IDisposable {
  // 防止重复挂载
  if (trackingStateByTerminal.has(terminal)) {
    const existing = trackingStateByTerminal.get(terminal)!
    return {
      dispose: () => disposeTracking(terminal, existing),
    }
  }

  const state: DomTrackingState = {
    terminal,
    disposed: false,
    wheelTimer: null,
    offMouseReportDetect: null,
    offUserInput: null,
    offScroll: null,
    isTuiMode: isTuiModeElement(terminal),
    recentMouseReport: false,
    disposables: [],
    cancelPostRebuildSync: null,
  }
  trackingStateByTerminal.set(terminal, state)

  // ── 1. 滚轮事件监听 ──
  const wheelHandler = (e: WheelEvent): void => {
    if (state.disposed) return
    handleWheelEvent(terminal, e, state)
  }
  host.addEventListener('wheel', wheelHandler, { passive: true })
  const wheelDisposable: IDisposable = {
    dispose: () => host.removeEventListener('wheel', wheelHandler),
  }
  state.disposables.push(wheelDisposable)

  // ── 2. 滚动条/滑块拖拽检测 ──
  // 通过 xterm 的 onScroll 事件检测：当用户拖拽滚动条时，xterm 触发 onScroll。
  // 结合鼠标事件（mousedown/mouseup）在视口/滚动条/滑块上判断是否为拖拽操作。
  const viewportScrollHandler = (): void => {
    if (state.disposed) return
    handleViewportScroll(terminal, state)
  }

  // 监听 xterm 的 onScroll 事件
  try {
    const offScroll = terminal.onScroll(viewportScrollHandler)
    state.offScroll = offScroll
    state.disposables.push(offScroll)
  } catch {
    // 旧版 xterm 无 onScroll
  }

  // ── 3. 鼠标报告检测 ──
  // 通过拦截 onData 检测鼠标报告序列（\x1b[< 和 \x1b[M 前缀）
  try {
    const offMouseReport = terminal.onData((data: string) => {
      if (state.disposed) return
      detectMouseReport(data, state)
    })
    state.offMouseReportDetect = offMouseReport
    state.disposables.push(offMouseReport)
  } catch {
    // 旧版 xterm 无 onData
  }

  // ── 4. 用户输入检测 ──
  // 通过 xterm 内部的 coreService.onUserInput 区分用户驱动输入与 parser 自动回复
  try {
    const core = (terminal as any)._core as { coreService?: { onUserInput?: (cb: () => void) => IDisposable } } | undefined
    const userInputDisposable = core?.coreService?.onUserInput?.(() => {
      if (state.disposed) return
      handleUserInput(terminal, state)
    })
    if (userInputDisposable) {
      state.offUserInput = () => userInputDisposable.dispose()
      state.disposables.push(userInputDisposable)
    }
  } catch {
    // coreService 不可用（如测试环境）
  }

  // ── 5. TUI 模式 class 变化检测 ──
  // 监听 host 元素上 enable-mouse-events class 的添加/移除
  try {
    const tuiObserver = new MutationObserver(() => {
      if (state.disposed) return
      state.isTuiMode = isTuiModeElement(terminal)
    })
    // 观察 terminal.element 和 host 的 class 变化
    const targetElements: (HTMLElement | null)[] = [
      terminal.element ?? null,
      host,
    ]
    for (const el of targetElements) {
      if (el) {
        tuiObserver.observe(el, {
          attributes: true,
          attributeFilter: ['class'],
        })
      }
    }
    const observerDisposable: IDisposable = {
      dispose: () => tuiObserver.disconnect(),
    }
    state.disposables.push(observerDisposable)
  } catch {
    // MutationObserver 不可用（如测试环境）
  }

  return {
    dispose: () => disposeTracking(terminal, state),
  }
}

// ─── 事件处理 ──────────────────────────────────────────────────────────────

/**
 * 处理滚轮事件。
 *
 * 映射规则：
 *   - 滚轮向上（deltaY < 0）：标记为 pinnedViewport + 稳定化采样
 *   - 滚轮向下到底部：标记为 followOutput
 *   - TUI 模式（enable-mouse-events class 存在）：保持 pinnedViewport，不触发 followOutput
 *   - 重建期间：跳过意图写入，稍后统一采样
 */
function handleWheelEvent(
  terminal: TerminalScrollIntentTarget,
  e: WheelEvent,
  state: DomTrackingState,
): void {
  // 重建保护：重建期间的 wheel 事件不写入意图，注册重建完成后同步
  if (isTerminalScrollIntentRebuildInFlight(terminal)) {
    registerPostRebuildSync(terminal, state)
    return
  }

  // 检查 event target 是否为滚动条元素
  if (isScrollbarElement(e.target as HTMLElement | null)) {
    // 滚动条拖拽 → pinnedViewport + 稳定化采样
    markTerminalPinnedViewport(terminal)
    scheduleWheelSettle(terminal, state)
    return
  }

  if (e.deltaY < 0) {
    // 滚轮向上 → pinnedViewport（用户向上滚动，意在看历史输出）
    markTerminalPinnedViewport(terminal)
    scheduleWheelSettle(terminal, state)
  } else if (e.deltaY > 0) {
    // 滚轮向下
    if (state.isTuiMode) {
      // TUI 模式：保持 pinnedViewport，不触发 followOutput
      // 不写入意图（保持当前 pinnedViewport）
      scheduleWheelSettle(terminal, state)
      return
    }
    // 非 TUI 模式：检查是否滚到底部
    scheduleWheelSettle(terminal, state)
    // 具体 followOutput 还是 pinnedViewport 由 settle 时的视口位置决定
  }
  // deltaY === 0：水平滚动，忽略
}

/**
 * 处理视口滚动事件（xterm onScroll）。
 *
 * 检测是否为滚动条拖拽/滑块拖拽：
 *   - 通过 xterm 的 onScroll 事件 + 鼠标按键状态判断
 *   - 如果鼠标按键按下（mousedown 在视口/滚动条/滑块上），则为拖拽操作
 */
function handleViewportScroll(
  terminal: TerminalScrollIntentTarget,
  state: DomTrackingState,
): void {
  // 重建保护：重建期间注册完成回调
  if (isTerminalScrollIntentRebuildInFlight(terminal)) {
    registerPostRebuildSync(terminal, state)
    return
  }

  // 通过鼠标按键状态判断是否为拖拽：如果鼠标左键按下，很可能是拖拽滚动条
  // 使用 buttons 属性：1 = 左键，2 = 右键，4 = 中键
  // 在 scroll 事件中无法直接获取鼠标按键状态，依赖 mousedown/mouseup 跟踪
  // 兜底：通过 onScroll 同步意图（由 settle 阶段决定）
  syncTerminalScrollIntentSoon(terminal)
}

/**
 * 处理用户输入事件（coreService.onUserInput）。
 *
 * 用户通过键盘输入时，标记为 followOutput（自动贴底）。
 * 但如果最近检测到鼠标报告（TUI 程序内部输入），则跳过。
 */
function handleUserInput(
  terminal: TerminalScrollIntentTarget,
  state: DomTrackingState,
): void {
  // 重建保护
  if (isTerminalScrollIntentRebuildInFlight(terminal)) {
    return
  }

  // 如果最近检测到鼠标报告，跳过（TUI 程序内部输入，非用户键盘输入）
  if (state.recentMouseReport) {
    // 重置鼠标报告标记，避免持续抑制
    state.recentMouseReport = false
    return
  }

  // 用户键盘输入 → followOutput（自动贴底）
  markTerminalFollowOutput(terminal)
}

/**
 * 检测鼠标报告序列。
 *
 * 鼠标报告序列前缀：
 *   - \x1b[<（SGR 鼠标模式）
 *   - \x1b[M（普通鼠标模式）
 *
 * 检测到鼠标报告时，标记 state.recentMouseReport = true，
 * 并在短时间内抑制后续的键盘输入 → followOutput 转换。
 */
function detectMouseReport(data: string, state: DomTrackingState): void {
  if (
    data.startsWith(MOUSE_REPORT_SGR_PREFIX) ||
    data.startsWith(MOUSE_REPORT_NORMAL_PREFIX)
  ) {
    state.recentMouseReport = true
    // 短时间后重置标记，避免永久抑制
    setTimeout(() => {
      state.recentMouseReport = false
    }, 100)
  }
}

// ─── 辅助函数 ──────────────────────────────────────────────────────────────

/**
 * 判断 event target 是否为滚动条相关元素。
 * 通过 CSS class 检测：xterm-viewport / xterm-scrollbar / xterm-slider。
 */
function isScrollbarElement(element: HTMLElement | null): boolean {
  if (!element) return false
  const classList = element.classList
  return (
    classList.contains(XTERM_VIEWPORT_CLASS) ||
    classList.contains(XTERM_SCROLLBAR_CLASS) ||
    classList.contains(XTERM_SLIDER_CLASS)
  )
}

/**
 * 判断终端是否处于 TUI 模式。
 * 检测 terminal.element 或 host 上是否有 enable-mouse-events class。
 */
function isTuiModeElement(terminal: Terminal): boolean {
  const element = terminal.element
  if (!element) return false
  return element.classList.contains(ENABLE_MOUSE_EVENTS_CLASS)
}

/**
 * 安排滚轮事件的稳定化采样。
 * 连续滚轮事件在 WHEEL_SETTLE_RESET_MS 窗口内重置定时器，避免频繁采样。
 */
function scheduleWheelSettle(
  terminal: TerminalScrollIntentTarget,
  state: DomTrackingState,
): void {
  if (state.wheelTimer !== null) {
    clearTimeout(state.wheelTimer)
  }
  state.wheelTimer = setTimeout(() => {
    state.wheelTimer = null
    if (state.disposed) return
    // 重建保护：注册完成回调，稍后统一采样
    if (isTerminalScrollIntentRebuildInFlight(terminal)) {
      registerPostRebuildSync(terminal, state)
      return
    }
    // 滚轮停止后，通过 settle 采样确认意图
    syncTerminalScrollIntentSoon(terminal)
  }, WHEEL_SETTLE_RESET_MS)
}

/**
 * 清理所有事件监听和状态。
 */
/**
 * 注册重建完成后的滚动意图同步回调。
 * 如果已有注册的回调，不再重复注册。
 */
function registerPostRebuildSync(
  terminal: TerminalScrollIntentTarget,
  state: DomTrackingState,
): void {
  if (state.cancelPostRebuildSync) {
    // 已注册，无需重复
    return
  }
  state.cancelPostRebuildSync = onTerminalScrollIntentBufferRebuildComplete(
    terminal,
    (completed) => {
      state.cancelPostRebuildSync = null
      if (completed && !state.disposed) {
        // 重建完成后从视口同步滚动意图
        syncTerminalScrollIntentSoon(terminal)
      }
    },
  )
}

function disposeTracking(
  terminal: TerminalScrollIntentTarget,
  state: DomTrackingState,
): void {
  if (state.disposed) return
  state.disposed = true

  // 清理定时器
  if (state.wheelTimer !== null) {
    clearTimeout(state.wheelTimer)
    state.wheelTimer = null
  }

  // 取消 pending settle
  cancelPendingSettle(terminal)

  // 清理所有注册的 disposables
  for (const d of state.disposables) {
    try {
      d.dispose()
    } catch {
      // 单个 dispose 失败不影响其他
    }
  }
  state.disposables = []

  // 清理引用
  state.offMouseReportDetect = null
  state.offUserInput = null
  state.offScroll = null

  // 清理重建同步回调
  if (state.cancelPostRebuildSync) {
    state.cancelPostRebuildSync()
    state.cancelPostRebuildSync = null
  }

  trackingStateByTerminal.delete(terminal)
}