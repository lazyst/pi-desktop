// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  syncTerminalScrollIntentSoon,
  cancelPendingSettle,
} from '../scroll-intent-settle'
import {
  markTerminalPinnedViewport,
  markTerminalFollowOutput,
  getTerminalScrollIntentKind,
  syncTerminalScrollIntentFromViewport,
  type TerminalScrollIntentTarget,
} from '../scroll-intent'
import {
  beginTerminalScrollIntentBufferRebuild,
  endTerminalScrollIntentBufferRebuild,
} from '../scroll-intent-rebuild'

// ─── 辅助工厂函数 ──────────────────────────────────────────────────────────

function createMockTerminal(overrides?: {
  viewportY?: number
  baseY?: number
  bufferType?: string
}): TerminalScrollIntentTarget {
  const viewportY = overrides?.viewportY ?? 0
  const baseY = overrides?.baseY ?? 0
  const bufferType = overrides?.bufferType ?? 'normal'

  return {
    buffer: {
      active: {
        type: bufferType,
        viewportY,
        baseY,
      },
    },
    scrollToBottom: vi.fn<() => void>(),
    scrollToLine: vi.fn<(line: number) => void>(),
  }
}

// ─── 测试 ──────────────────────────────────────────────────────────────────

describe('syncTerminalScrollIntentSoon', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('在 microtask 中采样（视口在底部 → followOutput）', async () => {
    const term = createMockTerminal({ viewportY: 100, baseY: 100 })
    syncTerminalScrollIntentSoon(term)
    // 等待 microtask 执行
    await Promise.resolve()
    expect(getTerminalScrollIntentKind(term)).toBe('followOutput')
  })

  it('在 microtask 中采样（视口不在底部 → pinnedViewport）', async () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    syncTerminalScrollIntentSoon(term)
    await Promise.resolve()
    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')
  })

  it('在 rAF 中采样', async () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    syncTerminalScrollIntentSoon(term)
    // 第一个 rAF
    await Promise.resolve()
    vi.advanceTimersByTime(16)
    // 第二个 rAF
    vi.advanceTimersByTime(16)
    // 确保意图已被设置
    await Promise.resolve()
    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')
  })

  it('在 setTimeout 80ms 兜底采样', async () => {
    const term = createMockTerminal({ viewportY: 100, baseY: 100 })
    syncTerminalScrollIntentSoon(term)

    // 重置 rAF 实现，模拟 rAF 不触发的情况
    const originalRAF = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = vi.fn() as any

    // 推进 80ms，触发兜底
    vi.advanceTimersByTime(80)
    await Promise.resolve()

    globalThis.requestAnimationFrame = originalRAF
    expect(getTerminalScrollIntentKind(term)).toBe('followOutput')
  })

  it('shouldSync 返回 false 时跳过同步', async () => {
    const term = createMockTerminal({ viewportY: 100, baseY: 100 })
    const shouldSync = vi.fn(() => false)
    syncTerminalScrollIntentSoon(term, { shouldSync })
    await Promise.resolve()
    // 无意图应该被写入——默认推断为 followOutput（视口在底部）
    expect(getTerminalScrollIntentKind(term)).toBe('followOutput')
    expect(shouldSync).toHaveBeenCalled()
  })

  it('重建期间跳过同步', async () => {
    const term = createMockTerminal({ viewportY: 100, baseY: 100 })
    beginTerminalScrollIntentBufferRebuild(term)
    syncTerminalScrollIntentSoon(term)
    await Promise.resolve()
    // 重建中，不应写入意图——默认推断为 followOutput（视口在底部）
    expect(getTerminalScrollIntentKind(term)).toBe('followOutput')
    endTerminalScrollIntentBufferRebuild(term)
  })

  it('取消 pending settle 后不再同步', async () => {
    const term = createMockTerminal({ viewportY: 100, baseY: 100 })
    syncTerminalScrollIntentSoon(term)
    cancelPendingSettle(term)
    await Promise.resolve()
    // 已被取消，不应写入意图——默认推断为 followOutput（视口在底部）
    expect(getTerminalScrollIntentKind(term)).toBe('followOutput')
  })

  it('多次调用只保留最后一次的采样', async () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    // 第一次调用
    syncTerminalScrollIntentSoon(term)
    // 立即取消并重新调用（模拟连续滚动）
    syncTerminalScrollIntentSoon(term)
    await Promise.resolve()
    // 视口不在底部 → pinnedViewport
    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')
  })
})

describe('cancelPendingSettle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('取消后不再执行同步', async () => {
    const term = createMockTerminal({ viewportY: 100, baseY: 100 })
    syncTerminalScrollIntentSoon(term)
    cancelPendingSettle(term)
    // 推进所有定时器
    vi.advanceTimersByTime(100)
    await Promise.resolve()
    // 不应有意图变化——默认推断为 followOutput（视口在底部）
    expect(getTerminalScrollIntentKind(term)).toBe('followOutput')
  })

  it('未调用 syncTerminalScrollIntentSoon 时无操作', () => {
    const term = createMockTerminal()
    expect(() => cancelPendingSettle(term)).not.toThrow()
  })
})