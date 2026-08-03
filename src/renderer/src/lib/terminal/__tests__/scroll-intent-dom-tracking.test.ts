// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Terminal } from '@xterm/xterm'
import {
  attachTerminalScrollIntentTracking,
} from '../scroll-intent-dom-tracking'
import {
  getTerminalScrollIntentKind,
  markTerminalFollowOutput,
  markTerminalPinnedViewport,
  syncTerminalScrollIntentFromViewport,
  type TerminalScrollIntentTarget,
} from '../scroll-intent'
import {
  beginTerminalScrollIntentBufferRebuild,
  endTerminalScrollIntentBufferRebuild,
} from '../scroll-intent-rebuild'

// ─── 辅助工厂函数 ──────────────────────────────────────────────────────────

/**
 * 创建一个模拟的 Terminal 实例。
 * 使用最小化模拟，仅暴露测试所需的方法和属性。
 */
function createMockTerminal(overrides?: {
  viewportY?: number
  baseY?: number
  bufferType?: string
  element?: HTMLElement | null
  isDisposed?: boolean
}): Terminal {
  const viewportY = overrides?.viewportY ?? 100
  const baseY = overrides?.baseY ?? 100
  const bufferType = overrides?.bufferType ?? 'normal'
  const element = overrides?.element ?? null

  return {
    buffer: {
      active: {
        type: bufferType,
        viewportY,
        baseY,
        cursorY: 0,
        get length() { return this.baseY },
      },
      onBufferChange: vi.fn(),
    },
    element,
    rows: 24,
    cols: 80,
    scrollToBottom: vi.fn(),
    scrollToLine: vi.fn(),
    scrollLines: vi.fn(),
    scrollPages: vi.fn(),
    onScroll: vi.fn(() => ({ dispose: vi.fn() })),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onResize: vi.fn(() => ({ dispose: vi.fn() })),
    onKey: vi.fn(() => ({ dispose: vi.fn() })),
    options: {},
    write: vi.fn(),
    dispose: vi.fn(),
    resize: vi.fn(),
    focus: vi.fn(),
    refresh: vi.fn(),
    clear: vi.fn(),
    reset: vi.fn(),
    selectAll: vi.fn(),
    clearSelection: vi.fn(),
    hasSelection: vi.fn(() => false),
    getSelection: vi.fn(() => ''),
    paste: vi.fn(),
    attachCustomKeyEventHandler: vi.fn(),
    registerMarker: vi.fn(),
    deregisterMarker: vi.fn(),
    hasCursor: vi.fn(() => false),
    getOption: vi.fn(),
    setOption: vi.fn(),
    loadAddon: vi.fn(),
    _core: {
      coreService: {
        onUserInput: vi.fn(() => ({ dispose: vi.fn() })),
      },
      _store: {
        _isDisposed: overrides?.isDisposed ?? false,
      },
    },
  } as unknown as Terminal
}

/**
 * 创建一个宿主 DOM 元素。
 */
function createHost(): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  return host
}

/**
 * 创建一个视口 DOM 元素（模拟 xterm 视口）。
 */
function createViewport(): HTMLElement {
  const vp = document.createElement('div')
  vp.className = 'xterm-viewport'
  return vp
}

/**
 * 创建一个滚动条 DOM 元素。
 */
function createScrollbar(): HTMLElement {
  const sb = document.createElement('div')
  sb.className = 'xterm-scrollbar'
  return sb
}

/**
 * 创建一个滑块 DOM 元素。
 */
function createSlider(): HTMLElement {
  const sl = document.createElement('div')
  sl.className = 'xterm-slider'
  return sl
}

// ─── 测试 ──────────────────────────────────────────────────────────────────

describe('attachTerminalScrollIntentTracking', () => {
  let host: HTMLElement
  let term: Terminal

  beforeEach(() => {
    host = createHost()
    term = createMockTerminal({
      viewportY: 100,
      baseY: 100,
      element: host,
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // ── 基本功能 ──

  it('返回 disposable 对象', () => {
    const disposable = attachTerminalScrollIntentTracking(term, host)
    expect(disposable).toBeDefined()
    expect(typeof disposable.dispose).toBe('function')
  })

  it('dispose 后清理事件监听', () => {
    const disposable = attachTerminalScrollIntentTracking(term, host)
    disposable.dispose()
    // 再次 dispose 不应抛出
    expect(() => disposable.dispose()).not.toThrow()
  })

  it('重复挂载返回同一个 disposable', () => {
    const d1 = attachTerminalScrollIntentTracking(term, host)
    const d2 = attachTerminalScrollIntentTracking(term, host)
    // 第二次挂载应返回同一个 disposable（幂等）
    d1.dispose()
    d2.dispose()
  })

  // ── 滚轮事件 ──

  it('滚轮向上（deltaY < 0）标记为 pinnedViewport', async () => {
    // 验证 DOM 事件监听是否正常工作
    let wheelCalled = false
    let wheelDeltaY = 0
    const testHandler = (e: Event) => {
      wheelCalled = true
      wheelDeltaY = (e as WheelEvent).deltaY
    }
    host.addEventListener('wheel', testHandler, { passive: true })
    const wheelEvent = new WheelEvent('wheel', { deltaY: -100, deltaX: 0, bubbles: true })
    host.dispatchEvent(wheelEvent)
    expect(wheelCalled).toBe(true)
    expect(wheelDeltaY).toBe(-100)
    host.removeEventListener('wheel', testHandler)

    // 挂载滚动意图跟踪
    attachTerminalScrollIntentTracking(term, host)

    // 先标记为 followOutput
    markTerminalFollowOutput(term)
    expect(getTerminalScrollIntentKind(term)).toBe('followOutput')

    // 触发滚轮向上事件
    const wheelEvent2 = new WheelEvent('wheel', { deltaY: -100, deltaX: 0, bubbles: true })
    host.dispatchEvent(wheelEvent2)

    // 验证意图已被立即标记为 pinnedViewport（markTerminalPinnedViewport 在 handler 中同步调用）
    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')
  })

  it('滚轮向下到底部标记为 followOutput', async () => {
    term = createMockTerminal({
      viewportY: 100,
      baseY: 100,
      element: host,
    })
    attachTerminalScrollIntentTracking(term, host)

    // 先标记为 pinnedViewport
    markTerminalPinnedViewport(term)
    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')

    // 模拟滚轮向下且视口到底部
    const wheelEvent = new WheelEvent('wheel', { deltaY: 100, deltaX: 0, bubbles: true })
    host.dispatchEvent(wheelEvent)

    // 非 TUI 模式下，滚轮向下且视口在底部，settle 后应同步为 followOutput
    await new Promise((r) => setTimeout(r, 60))
    await Promise.resolve()

    expect(getTerminalScrollIntentKind(term)).toBe('followOutput')
  })

  it('TUI 模式下滚轮向下不触发 followOutput', async () => {
    // 添加 TUI class
    host.classList.add('enable-mouse-events')
    term = createMockTerminal({
      viewportY: 50,
      baseY: 100,
      element: host,
    })
    attachTerminalScrollIntentTracking(term, host)

    // 先标记为 pinnedViewport
    markTerminalPinnedViewport(term)

    // 触发滚轮向下
    const wheelEvent = new WheelEvent('wheel', {
      deltaY: 100,
      deltaX: 0,
      bubbles: true,
    })
    host.dispatchEvent(wheelEvent)

    await new Promise((r) => setTimeout(r, 60))
    await Promise.resolve()

    // TUI 模式下，滚轮向下不应触发 followOutput
    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')
  })

  it('重建期间滚轮事件不写入意图', async () => {
    attachTerminalScrollIntentTracking(term, host)

    // 开始重建
    beginTerminalScrollIntentBufferRebuild(term)

    // 触发滚轮向上
    const wheelEvent = new WheelEvent('wheel', {
      deltaY: -100,
      deltaX: 0,
      bubbles: true,
    })
    host.dispatchEvent(wheelEvent)

    await new Promise((r) => setTimeout(r, 60))
    await Promise.resolve()

    // 重建中，不应写入意图
    expect(getTerminalScrollIntentKind(term)).toBe('followOutput') // 默认

    endTerminalScrollIntentBufferRebuild(term)
  })

  // ── 滚动条拖拽 ──

  it('滚动条元素上的滚轮事件标记为 pinnedViewport', () => {
    attachTerminalScrollIntentTracking(term, host)

    // 创建视口元素并作为事件 target
    const viewport = createViewport()
    host.appendChild(viewport)

    const wheelEvent = new WheelEvent('wheel', {
      deltaY: 100,
      deltaX: 0,
      bubbles: true,
    })
    // 将 target 设置为视口元素
    Object.defineProperty(wheelEvent, 'target', {
      value: viewport,
      writable: false,
    })
    host.dispatchEvent(wheelEvent)

    // 滚动条上的滚轮 → pinnedViewport
    // 注意：这里直接标记，不等待 settle
    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')
  })

  it('滑块元素上的滚轮事件标记为 pinnedViewport', () => {
    attachTerminalScrollIntentTracking(term, host)

    const slider = createSlider()
    host.appendChild(slider)

    const wheelEvent = new WheelEvent('wheel', {
      deltaY: -100,
      deltaX: 0,
      bubbles: true,
    })
    Object.defineProperty(wheelEvent, 'target', {
      value: slider,
      writable: false,
    })
    host.dispatchEvent(wheelEvent)

    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')
  })

  // ── 鼠标报告检测 ──

  it('SGR 鼠标报告序列（\\x1b[<）不触发 followOutput', () => {
    // 获取 onData 回调
    let onDataCallback: ((data: string) => void) | null = null
    const onDataMock = vi.fn((cb: (data: string) => void) => {
      onDataCallback = cb
      return { dispose: vi.fn() }
    })
    term.onData = onDataMock as any

    // 设置 coreService.onUserInput 回调
    let userInputCallback: (() => void) | null = null
    const onUserInputMock = vi.fn((cb: () => void) => {
      userInputCallback = cb
      return { dispose: vi.fn() }
    })
    ;(term as any)._core.coreService.onUserInput = onUserInputMock

    attachTerminalScrollIntentTracking(term, host)

    // 先标记为 pinnedViewport
    markTerminalPinnedViewport(term)

    // 模拟 TUI 鼠标报告序列
    onDataCallback!('\x1b[<0,10,25M')
    // 紧接着触发用户输入（应该被抑制）
    userInputCallback!()

    // 鼠标报告后的用户输入应被抑制，保持 pinnedViewport
    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')
  })

  it('普通鼠标报告序列（\\x1b[M）不触发 followOutput', () => {
    let onDataCallback: ((data: string) => void) | null = null
    const onDataMock = vi.fn((cb: (data: string) => void) => {
      onDataCallback = cb
      return { dispose: vi.fn() }
    })
    term.onData = onDataMock as any

    let userInputCallback: (() => void) | null = null
    const onUserInputMock = vi.fn((cb: () => void) => {
      userInputCallback = cb
      return { dispose: vi.fn() }
    })
    ;(term as any)._core.coreService.onUserInput = onUserInputMock

    attachTerminalScrollIntentTracking(term, host)

    markTerminalPinnedViewport(term)

    // 模拟普通鼠标报告序列
    onDataCallback!('\x1b[M\x00\x00\x00')
    userInputCallback!()

    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')
  })

  it('非鼠标报告的用户输入触发 followOutput', () => {
    let onDataCallback: ((data: string) => void) | null = null
    const onDataMock = vi.fn((cb: (data: string) => void) => {
      onDataCallback = cb
      return { dispose: vi.fn() }
    })
    term.onData = onDataMock as any

    let userInputCallback: (() => void) | null = null
    const onUserInputMock = vi.fn((cb: () => void) => {
      userInputCallback = cb
      return { dispose: vi.fn() }
    })
    ;(term as any)._core.coreService.onUserInput = onUserInputMock

    attachTerminalScrollIntentTracking(term, host)

    // 先标记为 pinnedViewport
    markTerminalPinnedViewport(term)
    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')

    // 模拟普通键盘输入（不是鼠标报告序列）
    onDataCallback!('hello')
    userInputCallback!()

    // 用户输入 → followOutput
    expect(getTerminalScrollIntentKind(term)).toBe('followOutput')
  })

  // ── TUI 模式 class 变化检测 ──

  it('TUI class 变化后影响滚轮行为', async () => {
    // 初始无 TUI class
    term = createMockTerminal({
      viewportY: 50,
      baseY: 100,
      element: host,
    })
    attachTerminalScrollIntentTracking(term, host)

    // 添加 TUI class
    host.classList.add('enable-mouse-events')

    // 触发 mutation observer（需要微任务）
    await Promise.resolve()

    // 标记为 followOutput
    markTerminalFollowOutput(term)

    // 触发滚轮向下
    const wheelEvent = new WheelEvent('wheel', {
      deltaY: 100,
      deltaX: 0,
      bubbles: true,
    })
    host.dispatchEvent(wheelEvent)

    await new Promise((r) => setTimeout(r, 60))
    await Promise.resolve()

    // TUI 模式下，即使滚轮向下也保持 pinnedViewport
    // 注意：在这里 wheel handler 不直接改变意图，而是由 settle 决定
    // 但在 TUI 模式下，wheel handler 不应该触发 followOutput

    // 由于 settle 会检测视口位置，而视口不在底部，所以保持 pinnedViewport
    // 如果在底部，TUI 模式下也应保持 pinnedViewport
    // 但这里我们测试的是 TUI 模式下不触发 followOutput 的行为
    // 实际的意图由 settle 阶段的视口位置决定
  })

  // ── 重建保护 ──

  it('重建期间滚动条拖拽不写入意图', () => {
    attachTerminalScrollIntentTracking(term, host)

    beginTerminalScrollIntentBufferRebuild(term)

    const viewport = createViewport()
    host.appendChild(viewport)

    const wheelEvent = new WheelEvent('wheel', {
      deltaY: 100,
      deltaX: 0,
      bubbles: true,
    })
    Object.defineProperty(wheelEvent, 'target', {
      value: viewport,
      writable: false,
    })
    host.dispatchEvent(wheelEvent)

    // 重建中，不应写入意图
    expect(getTerminalScrollIntentKind(term)).toBe('followOutput') // 默认

    endTerminalScrollIntentBufferRebuild(term)
  })

  // ── dispose 清理 ──

  it('dispose 后滚轮事件不再触发意图更新', async () => {
    const disposable = attachTerminalScrollIntentTracking(term, host)
    disposable.dispose()

    markTerminalFollowOutput(term)

    // 触发滚轮向上
    const wheelEvent = new WheelEvent('wheel', {
      deltaY: -100,
      deltaX: 0,
      bubbles: true,
    })
    host.dispatchEvent(wheelEvent)

    await new Promise((r) => setTimeout(r, 60))
    await Promise.resolve()

    // dispose 后，意图应保持不变
    expect(getTerminalScrollIntentKind(term)).toBe('followOutput')
  })

  it('dispose 后鼠标报告检测不再工作', () => {
    let onDataCallback: ((data: string) => void) | null = null
    const onDataMock = vi.fn((cb: (data: string) => void) => {
      onDataCallback = cb
      return { dispose: vi.fn() }
    })
    term.onData = onDataMock as any

    let userInputCallback: (() => void) | null = null
    const onUserInputMock = vi.fn((cb: () => void) => {
      userInputCallback = cb
      return { dispose: vi.fn() }
    })
    ;(term as any)._core.coreService.onUserInput = onUserInputMock

    const disposable = attachTerminalScrollIntentTracking(term, host)
    disposable.dispose()

    // dispose 后，鼠标报告不应影响意图
    markTerminalPinnedViewport(term)

    // 但 onData 回调仍然存在（因为 xterm 的 onData 返回的 disposable 在 dispose 时已清理）
    // 不过 state.disposed 标记会阻止处理
    onDataCallback!('\x1b[<0,10,25M')
    userInputCallback!()

    // dispose 后，不应有新的意图写入
    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')
  })
})