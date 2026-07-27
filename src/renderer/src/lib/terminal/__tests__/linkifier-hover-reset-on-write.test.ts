// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import * as hoverReset from '../linkifier-hover-reset'
import { installTerminalLinkifierHoverResetOnWrite } from '../linkifier-hover-reset-on-write'

// 在 reset 原语上设置 spy，同时保留其真实的字段清除行为，
// 以便测试可以统计调用次数——节流/合并属性在其他情况下不可见
// （reset 写入的是幂等缓存状态）。
vi.mock('../linkifier-hover-reset', async (importOriginal) => {
  const actual = await importOriginal<typeof hoverReset>()
  return {
    ...actual,
    resetTerminalLinkifierHoverState: vi.fn(actual.resetTerminalLinkifierHoverState)
  }
})

type LinkifierCache = { _lastBufferCell?: unknown; _activeLine?: number; _currentLink?: unknown }

function createFakeTerminal(): {
  terminal: Terminal
  emitWriteParsed: () => void
  linkifier: LinkifierCache
  listenerDisposed: () => boolean
} {
  const listeners = new Set<() => void>()
  let disposed = false
  const linkifier: LinkifierCache = {
    _lastBufferCell: { x: 3, y: 4 },
    _activeLine: 4,
    _currentLink: undefined
  }
  const terminal = {
    onWriteParsed: (handler: () => void) => {
      listeners.add(handler)
      return {
        dispose: () => {
          disposed = true
          listeners.delete(handler)
        }
      }
    },
    _core: { linkifier }
  } as unknown as Terminal
  return {
    terminal,
    emitWriteParsed: () => listeners.forEach((handler) => handler()),
    linkifier,
    listenerDisposed: () => disposed
  }
}

const resetSpy = vi.mocked(hoverReset.resetTerminalLinkifierHoverState)

describe('installTerminalLinkifierHoverResetOnWrite', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetSpy.mockClear()
  })
  afterEach(() => vi.useRealTimers())

  it('在输出落地后的节流窗口内清除 linkifier 悬停缓存', () => {
    const fake = createFakeTerminal()
    installTerminalLinkifierHoverResetOnWrite(fake.terminal)

    fake.emitWriteParsed()
    // 不同步重置——节流以避免流式输出时每个块都重新查询。
    expect(resetSpy).not.toHaveBeenCalled()
    expect(fake.linkifier._lastBufferCell).toBeDefined()

    vi.advanceTimersByTime(150)
    expect(resetSpy).toHaveBeenCalledTimes(1)
    expect(fake.linkifier._lastBufferCell).toBeUndefined()
    expect(fake.linkifier._activeLine).toBe(-1)
  })

  it('将突发写入合并为每个窗口恰好一次重置', () => {
    const fake = createFakeTerminal()
    installTerminalLinkifierHoverResetOnWrite(fake.terminal)

    // 一个窗口内的 20 个块必须只调度一次重置——而不是 20 次。
    // 如果移除前导边缘节流守卫，此测试将失败。
    for (let i = 0; i < 20; i += 1) {
      fake.emitWriteParsed()
      vi.advanceTimersByTime(5)
    }
    vi.advanceTimersByTime(150)
    expect(resetSpy).toHaveBeenCalledTimes(1)
  })

  it('在持续流式输出期间保持重置而不是饥饿', () => {
    const fake = createFakeTerminal()
    installTerminalLinkifierHoverResetOnWrite(fake.terminal)

    // 每 50ms 一个块，持续 500ms。节流约每 150ms 触发一次；
    // 防抖（clearTimeout + 每个块重新调度）在流持续期间永远不会触发——
    // 这就是此测试要防止的回归。
    for (let i = 0; i < 10; i += 1) {
      fake.emitWriteParsed()
      vi.advanceTimersByTime(50)
    }
    expect(resetSpy.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('不会打扰悬停中的链接，并在链接清除后恢复', () => {
    const fake = createFakeTerminal()
    installTerminalLinkifierHoverResetOnWrite(fake.terminal)

    fake.linkifier._currentLink = { link: 'https://example.com' }
    fake.emitWriteParsed()
    vi.advanceTimersByTime(150)
    // 悬停中：缓存保留不动，这样下划线/工具提示不会闪烁。
    expect(resetSpy).not.toHaveBeenCalled()
    expect(fake.linkifier._lastBufferCell).toBeDefined()

    fake.linkifier._currentLink = undefined
    fake.emitWriteParsed()
    vi.advanceTimersByTime(150)
    expect(resetSpy).toHaveBeenCalledTimes(1)
    expect(fake.linkifier._lastBufferCell).toBeUndefined()
  })

  it('在悬停期间流式输出静默时不会丢弃重置', () => {
    const fake = createFakeTerminal()
    installTerminalLinkifierHoverResetOnWrite(fake.terminal)

    // 突发中的最后一个块在链接悬停时落地，然后输出停止。
    fake.linkifier._currentLink = { link: 'https://example.com' }
    fake.emitWriteParsed()
    // 多个窗口过去，没有进一步的写入——挂起的重置必须存活。
    vi.advanceTimersByTime(600)
    expect(resetSpy).not.toHaveBeenCalled()

    // 一旦指针离开链接，重试最终会重置——无需任何新的输出重新安排。
    fake.linkifier._currentLink = undefined
    vi.advanceTimersByTime(150)
    expect(resetSpy).toHaveBeenCalledTimes(1)
    expect(fake.linkifier._lastBufferCell).toBeUndefined()
  })

  it('在 dispose 时取消挂起的重置并分离监听器', () => {
    const fake = createFakeTerminal()
    const disposable = installTerminalLinkifierHoverResetOnWrite(fake.terminal)

    fake.emitWriteParsed()
    disposable.dispose()
    expect(fake.listenerDisposed()).toBe(true)

    vi.advanceTimersByTime(500)
    // 在定时器触发前已 dispose：无重置，缓存不变。
    expect(resetSpy).not.toHaveBeenCalled()
    expect(fake.linkifier._lastBufferCell).toEqual({ x: 3, y: 4 })
  })

  it('当终端缺少 onWriteParsed 时降级为无操作', () => {
    const terminal = { _core: { linkifier: {} } } as unknown as Terminal
    expect(() => installTerminalLinkifierHoverResetOnWrite(terminal).dispose()).not.toThrow()
  })
})