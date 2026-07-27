// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import {
  markTerminalFollowOutput,
  markTerminalPinnedViewport,
  syncTerminalScrollIntentFromViewport,
  captureTerminalStructuralScrollIntent,
  isTerminalStructuralScrollIntentCurrent,
  restoreTerminalStructuralScrollIntent,
  enforceTerminalCurrentScrollIntent,
  bindTerminalScrollIntentKey,
  getTerminalScrollIntentKind,
  isTerminalScrollIntentKeyBindingCurrent,
  type TerminalScrollIntentTarget,
  type TerminalStructuralScrollIntentSnapshot,
  type TerminalScrollIntentKind,
} from '../scroll-intent'

// ─── 辅助工厂函数 ──────────────────────────────────────────────────────────

/**
 * 创建一个模拟的终端对象。
 *
 * @param overrides.viewportY - 视口垂直偏移（默认 0）
 * @param overrides.baseY - buffer 底部行号（默认 0）
 * @param overrides.bufferType - buffer 类型（默认 'normal'）
 * @param overrides.scrollToBottomShouldThrow - scrollToBottom 是否抛出 dimensions TypeError（默认 false）
 * @param overrides.scrollToLineShouldThrow - scrollToLine 是否抛出 dimensions TypeError（默认 false）
 */
function createMockTerminal(overrides?: {
  viewportY?: number
  baseY?: number
  bufferType?: string
  scrollToBottomShouldThrow?: boolean
  scrollToLineShouldThrow?: boolean
}): TerminalScrollIntentTarget {
  const viewportY = overrides?.viewportY ?? 0
  const baseY = overrides?.baseY ?? 0
  const bufferType = overrides?.bufferType ?? 'normal'

  const scrollToBottom = vi.fn<() => void>()
  if (overrides?.scrollToBottomShouldThrow) {
    scrollToBottom.mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'dimensions')")
    })
  }

  const scrollToLine = vi.fn<(line: number) => void>()
  if (overrides?.scrollToLineShouldThrow) {
    scrollToLine.mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'dimensions')")
    })
  }

  return {
    buffer: {
      active: {
        type: bufferType,
        viewportY,
        baseY,
      },
    },
    scrollToBottom,
    scrollToLine,
  }
}

// ─── markTerminalFollowOutput / markTerminalPinnedViewport ─────────────────

describe('markTerminalFollowOutput', () => {
  it('标记终端为 followOutput 模式', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    markTerminalFollowOutput(term)
    // 通过 getTerminalScrollIntentKind 验证
    expect(getTerminalScrollIntentKind(term)).toBe('followOutput')
  })

  it('覆盖已有的 pinnedViewport 意图', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    markTerminalPinnedViewport(term)
    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')
    markTerminalFollowOutput(term)
    expect(getTerminalScrollIntentKind(term)).toBe('followOutput')
  })

  it('buffer 不可用时静默无操作', () => {
    const term = {} as TerminalScrollIntentTarget
    expect(() => markTerminalFollowOutput(term)).not.toThrow()
  })
})

describe('markTerminalPinnedViewport', () => {
  it('标记终端为 pinnedViewport 模式', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    markTerminalPinnedViewport(term)
    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')
  })

  it('覆盖已有的 followOutput 意图', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    markTerminalFollowOutput(term)
    expect(getTerminalScrollIntentKind(term)).toBe('followOutput')
    markTerminalPinnedViewport(term)
    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')
  })

  it('buffer 不可用时静默无操作', () => {
    const term = {} as TerminalScrollIntentTarget
    expect(() => markTerminalPinnedViewport(term)).not.toThrow()
  })
})

// ─── syncTerminalScrollIntentFromViewport ─────────────────────────────────

describe('syncTerminalScrollIntentFromViewport', () => {
  it('视口在底部时同步为 followOutput', () => {
    const term = createMockTerminal({ viewportY: 100, baseY: 100 })
    syncTerminalScrollIntentFromViewport(term)
    expect(getTerminalScrollIntentKind(term)).toBe('followOutput')
  })

  it('视口不在底部时同步为 pinnedViewport', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    syncTerminalScrollIntentFromViewport(term)
    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')
  })

  it('buffer 不可用时静默返回', () => {
    const term = {} as TerminalScrollIntentTarget
    expect(() => syncTerminalScrollIntentFromViewport(term)).not.toThrow()
  })

  it('allowBufferShrink 为 false 时保留已有的 pinnedViewport（buffer 收缩时）', () => {
    const term = createMockTerminal({ viewportY: 80, baseY: 200 })
    markTerminalPinnedViewport(term)
    // 模拟 buffer 收缩（更短的 baseY）
    term.buffer!.active!.baseY = 50
    term.buffer!.active!.viewportY = 30
    syncTerminalScrollIntentFromViewport(term, { allowBufferShrink: false })
    // 意图应保留为 pinnedViewport，因为 buffer 收缩了
    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')
  })

  it('allowBufferShrink 为 true 时覆盖已有的 pinnedViewport（buffer 收缩时）', () => {
    const term = createMockTerminal({ viewportY: 80, baseY: 200 })
    markTerminalPinnedViewport(term)
    // 模拟 buffer 收缩且视口在底部
    term.buffer!.active!.baseY = 30
    term.buffer!.active!.viewportY = 30
    syncTerminalScrollIntentFromViewport(term, { allowBufferShrink: true })
    expect(getTerminalScrollIntentKind(term)).toBe('followOutput')
  })

  it('preservePinnedAtBottom 为 true 时保留底部的 pinnedViewport', () => {
    const term = createMockTerminal({ viewportY: 100, baseY: 100 })
    markTerminalPinnedViewport(term)
    // 视口已在底部，但已标记为 pinnedViewport
    syncTerminalScrollIntentFromViewport(term, { preservePinnedAtBottom: true })
    // 应该保留 pinnedViewport（preservePinnedAtBottom 生效）
    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')
  })

  it('preservePinnedAtBottom 为 false 时将底部的 pinnedViewport 转为 followOutput', () => {
    const term = createMockTerminal({ viewportY: 100, baseY: 100 })
    markTerminalPinnedViewport(term)
    syncTerminalScrollIntentFromViewport(term, { preservePinnedAtBottom: false })
    expect(getTerminalScrollIntentKind(term)).toBe('followOutput')
  })

  it('无意图变化时避免创建新修订号', () => {
    const term = createMockTerminal({ viewportY: 100, baseY: 100 })
    syncTerminalScrollIntentFromViewport(term)
    const kind1 = getTerminalScrollIntentKind(term)
    // 再次同步，no-op 优化触发
    syncTerminalScrollIntentFromViewport(term)
    expect(getTerminalScrollIntentKind(term)).toBe(kind1)
  })

  it('pinned 时 baseY 增长但 viewportY 不变时刷新几何数据', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    markTerminalPinnedViewport(term)
    // baseY 增长
    term.buffer!.active!.baseY = 150
    term.buffer!.active!.viewportY = 50
    syncTerminalScrollIntentFromViewport(term)
    // 仍然应该是 pinnedViewport
    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')
  })
})

// ─── bindTerminalScrollIntentKey / isTerminalScrollIntentKeyBindingCurrent ─

describe('bindTerminalScrollIntentKey', () => {
  it('将 key 绑定到终端并返回已存在的意图', () => {
    const term1 = createMockTerminal({ viewportY: 50, baseY: 100 })
    const term2 = createMockTerminal({ viewportY: 0, baseY: 0 })

    // 先绑定 key，再写入意图（这样意图会传播到 key 存储）
    bindTerminalScrollIntentKey(term1, 'test-key')
    markTerminalPinnedViewport(term1)

    // term2 绑定同一 key，继承 term1 的意图
    const result = bindTerminalScrollIntentKey(term2, 'test-key')
    expect(result).toBeDefined()
    expect(result!.kind).toBe('pinnedViewport')
    expect(getTerminalScrollIntentKind(term2)).toBe('pinnedViewport')
  })

  it('key 为 undefined 时返回当前终端的意图（如有）', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    markTerminalPinnedViewport(term)
    const result = bindTerminalScrollIntentKey(term, undefined)
    expect(result).toBeDefined()
    expect(result!.kind).toBe('pinnedViewport')
  })

  it('key 为 undefined 且无现有意图时返回 undefined', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    const result = bindTerminalScrollIntentKey(term, undefined)
    expect(result).toBeUndefined()
  })
})

describe('isTerminalScrollIntentKeyBindingCurrent', () => {
  it('无 key 时始终返回 true', () => {
    const term = createMockTerminal()
    expect(isTerminalScrollIntentKeyBindingCurrent(term)).toBe(true)
  })

  it('绑定 key 后返回 true', () => {
    const term = createMockTerminal()
    bindTerminalScrollIntentKey(term, 'my-key')
    expect(isTerminalScrollIntentKeyBindingCurrent(term)).toBe(true)
  })

  it('key 被重新绑定到另一终端后旧终端返回 false', () => {
    const term1 = createMockTerminal()
    const term2 = createMockTerminal()
    bindTerminalScrollIntentKey(term1, 'shared-key')
    bindTerminalScrollIntentKey(term2, 'shared-key')
    // term1 的绑定已失效（被 term2 的绑定覆盖）
    expect(isTerminalScrollIntentKeyBindingCurrent(term1)).toBe(false)
    expect(isTerminalScrollIntentKeyBindingCurrent(term2)).toBe(true)
  })
})

// ─── getTerminalScrollIntentKind ──────────────────────────────────────────

describe('getTerminalScrollIntentKind', () => {
  it('无存储意图且视口在底部时返回 followOutput', () => {
    const term = createMockTerminal({ viewportY: 100, baseY: 100 })
    expect(getTerminalScrollIntentKind(term)).toBe('followOutput')
  })

  it('无存储意图且视口不在底部时返回 pinnedViewport', () => {
    const term = createMockTerminal({ viewportY: 30, baseY: 100 })
    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')
  })

  it('buffer 不可用时返回 followOutput', () => {
    const term = {} as TerminalScrollIntentTarget
    expect(getTerminalScrollIntentKind(term)).toBe('followOutput')
  })

  it('有存储意图时返回存储的 kind', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    markTerminalPinnedViewport(term)
    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')
    markTerminalFollowOutput(term)
    expect(getTerminalScrollIntentKind(term)).toBe('followOutput')
  })
})

// ─── captureTerminalStructuralScrollIntent ────────────────────────────────

describe('captureTerminalStructuralScrollIntent', () => {
  it('捕获当前滚动意图快照', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    markTerminalPinnedViewport(term)
    const snapshot = captureTerminalStructuralScrollIntent(term)
    expect(snapshot).not.toBeNull()
    expect(snapshot!.kind).toBe('pinnedViewport')
    expect(snapshot!.viewportY).toBe(50)
    expect(snapshot!.baseY).toBe(100)
    expect(snapshot!.bufferType).toBe('normal')
    expect(snapshot!.revision).toBeGreaterThan(0)
  })

  it('buffer 不可用时返回 null', () => {
    const term = {} as TerminalScrollIntentTarget
    expect(captureTerminalStructuralScrollIntent(term)).toBeNull()
  })

  it('无存储意图时根据视口位置推断 kind', () => {
    const term = createMockTerminal({ viewportY: 100, baseY: 100 })
    const snapshot = captureTerminalStructuralScrollIntent(term)
    expect(snapshot).not.toBeNull()
    expect(snapshot!.kind).toBe('followOutput')
  })

  it('pinned 但视口在底部且 buffer 足够长时将 kind 转为 followOutput', () => {
    const term = createMockTerminal({ viewportY: 100, baseY: 100 })
    markTerminalPinnedViewport(term)
    // 视口在底部，buffer 长度未缩小
    const snapshot = captureTerminalStructuralScrollIntent(term)
    expect(snapshot).not.toBeNull()
    expect(snapshot!.kind).toBe('followOutput')
  })

  it('pinned 且 buffer 收缩时使用现有坐标而非快照坐标', () => {
    const term = createMockTerminal({ viewportY: 80, baseY: 200 })
    markTerminalPinnedViewport(term)
    // 模拟 buffer 收缩
    term.buffer!.active!.baseY = 30
    term.buffer!.active!.viewportY = 10
    const snapshot = captureTerminalStructuralScrollIntent(term)
    expect(snapshot).not.toBeNull()
    // 应使用 existing 的坐标（80, 200 而非 10, 30）
    expect(snapshot!.viewportY).toBe(80)
    expect(snapshot!.baseY).toBe(200)
  })
})

// ─── isTerminalStructuralScrollIntentCurrent ──────────────────────────────

describe('isTerminalStructuralScrollIntentCurrent', () => {
  it('快照与当前修订号匹配时返回 true', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    markTerminalPinnedViewport(term)
    const snapshot = captureTerminalStructuralScrollIntent(term)
    expect(isTerminalStructuralScrollIntentCurrent(term, snapshot)).toBe(true)
  })

  it('快照为 null 时返回 false', () => {
    const term = createMockTerminal()
    expect(isTerminalStructuralScrollIntentCurrent(term, null)).toBe(false)
  })

  it('意图被更新后返回 false', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    markTerminalPinnedViewport(term)
    const snapshot = captureTerminalStructuralScrollIntent(term)
    // 写一个新意图
    markTerminalFollowOutput(term)
    expect(isTerminalStructuralScrollIntentCurrent(term, snapshot)).toBe(false)
  })
})

// ─── restoreTerminalStructuralScrollIntent ────────────────────────────────

describe('restoreTerminalStructuralScrollIntent', () => {
  it('followOutput 快照时调用 scrollToBottom', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    markTerminalFollowOutput(term)
    const snapshot = captureTerminalStructuralScrollIntent(term)
    // 修改视口位置以确保恢复可见
    term.buffer!.active!.viewportY = 30
    restoreTerminalStructuralScrollIntent(term, snapshot)
    expect(term.scrollToBottom).toHaveBeenCalledOnce()
    expect(getTerminalScrollIntentKind(term)).toBe('followOutput')
  })

  it('pinnedViewport 快照时调用 scrollToLine', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    markTerminalPinnedViewport(term)
    const snapshot = captureTerminalStructuralScrollIntent(term)
    // 修改视口位置
    term.buffer!.active!.viewportY = 30
    restoreTerminalStructuralScrollIntent(term, snapshot)
    expect(term.scrollToLine).toHaveBeenCalledWith(50)
    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')
  })

  it('快照为 null 时静默返回', () => {
    const term = createMockTerminal()
    expect(() => restoreTerminalStructuralScrollIntent(term, null)).not.toThrow()
  })

  it('快照不是当前时静默返回', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    markTerminalPinnedViewport(term)
    const snapshot = captureTerminalStructuralScrollIntent(term)
    // 更新意图使快照失效
    markTerminalFollowOutput(term)
    restoreTerminalStructuralScrollIntent(term, snapshot)
    // 不应该调用 scrollToLine
    expect(term.scrollToLine).not.toHaveBeenCalled()
  })

  it('bufferType 不匹配时静默返回', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    markTerminalPinnedViewport(term)
    const snapshot = captureTerminalStructuralScrollIntent(term)
    // 切换 buffer 类型
    term.buffer!.active!.type = 'alternate'
    restoreTerminalStructuralScrollIntent(term, snapshot)
    expect(term.scrollToLine).not.toHaveBeenCalled()
  })

  it('restoreBy bottomOffset 时计算正确的目标行', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    markTerminalPinnedViewport(term)
    const snapshot = captureTerminalStructuralScrollIntent(term)
    // buffer 增长
    term.buffer!.active!.baseY = 200
    term.buffer!.active!.viewportY = 80
    restoreTerminalStructuralScrollIntent(term, snapshot, { restoreBy: 'bottomOffset' })
    // bottomOffset = 100 - 50 = 50; targetY = 200 - 50 = 150
    expect(term.scrollToLine).toHaveBeenCalledWith(150)
  })

  it('scrollToLine 抛出 dimensions TypeError 时保留意图', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100, scrollToLineShouldThrow: true })
    markTerminalPinnedViewport(term)
    const snapshot = captureTerminalStructuralScrollIntent(term)
    restoreTerminalStructuralScrollIntent(term, snapshot)
    // 即使 scrollToLine 失败，意图仍应为 pinnedViewport
    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')
  })

  it('pinned 恢复时 buffer 比存储的意图短则跳过重新写入', () => {
    const term = createMockTerminal({ viewportY: 80, baseY: 200 })
    markTerminalPinnedViewport(term)
    const snapshot = captureTerminalStructuralScrollIntent(term)
    // buffer 收缩，视口已自动在目标位置
    term.buffer!.active!.baseY = 50
    term.buffer!.active!.viewportY = 50
    // current.viewportY (50) === targetY (50)，不执行 scrollToLine
    // 但 current.baseY (50) < existing.baseY (200)，应跳过最终 writeIntent
    // 先手动改意图为已收缩状态，模拟恢复场景
    restoreTerminalStructuralScrollIntent(term, snapshot)
    // scrollToLine 应该被调用，因为 viewportY 50 !== targetY 80
    // 但 clampTerminalViewportY(80, 50) = 50
    // 所以 current.viewportY (50) === targetY (50)，不调用 scrollToLine
    expect(term.scrollToLine).not.toHaveBeenCalled()
  })

  it('scrollToLine 已到达目标位置时不重复调用', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    markTerminalPinnedViewport(term)
    const snapshot = captureTerminalStructuralScrollIntent(term)
    // 视口已在目标位置
    restoreTerminalStructuralScrollIntent(term, snapshot)
    expect(term.scrollToLine).not.toHaveBeenCalled()
    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')
  })
})

// ─── enforceTerminalCurrentScrollIntent ───────────────────────────────────

describe('enforceTerminalCurrentScrollIntent', () => {
  it('无存储意图时捕获并恢复（不调用 scrollToLine，因为目标与当前位置一致）', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    enforceTerminalCurrentScrollIntent(term)
    // 视口已在目标位置，scrollToLine 不应被调用
    expect(term.scrollToLine).not.toHaveBeenCalled()
    // 意图应被存储为 pinnedViewport（视口不在底部）
    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')
  })

  it('有存储的 followOutput 意图时调用 scrollToBottom', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    markTerminalFollowOutput(term)
    enforceTerminalCurrentScrollIntent(term)
    expect(term.scrollToBottom).toHaveBeenCalled()
  })

  it('有存储的 pinnedViewport 意图时调用 scrollToLine', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    markTerminalPinnedViewport(term)
    // 修改视口位置，确保恢复被执行
    term.buffer!.active!.viewportY = 30
    enforceTerminalCurrentScrollIntent(term)
    expect(term.scrollToLine).toHaveBeenCalledWith(50)
  })

  it('pinned 意图在底部时转为 followOutput（幽灵钉）', () => {
    const term = createMockTerminal({ viewportY: 100, baseY: 100 })
    markTerminalPinnedViewport(term)
    // 视口在底部，但意图是 pinnedViewport
    enforceTerminalCurrentScrollIntent(term)
    // 应该转为 followOutput，调用 scrollToBottom
    expect(term.scrollToBottom).toHaveBeenCalled()
    expect(term.scrollToLine).not.toHaveBeenCalled()
  })

  it('buffer 收缩时使用 bottomOffset 恢复', () => {
    const term = createMockTerminal({ viewportY: 80, baseY: 200 })
    markTerminalPinnedViewport(term)
    // buffer 收缩
    term.buffer!.active!.baseY = 50
    term.buffer!.active!.viewportY = 30
    enforceTerminalCurrentScrollIntent(term)
    // bottomOffset = 200 - 80 = 120; targetY = 50 - 120 = -70 -> clamped to 0
    // 或另一种计算：targetY = clampTerminalViewportY(80, 50) = 50
    // 实际上 restoreBy bottomOffset 计算：current.baseY - (snapshot.baseY - snapshot.viewportY)
    // = 50 - (200 - 80) = 50 - 120 = -70 -> clamped to 0
    expect(term.scrollToLine).toHaveBeenCalledWith(0)
  })
})

// ─── 跨终端交互 ───────────────────────────────────────────────────────────

describe('跨终端交互', () => {
  it('两个独立终端各自维护自己的意图', () => {
    const term1 = createMockTerminal({ viewportY: 30, baseY: 100 })
    const term2 = createMockTerminal({ viewportY: 80, baseY: 100 })

    markTerminalPinnedViewport(term1)
    markTerminalFollowOutput(term2)

    expect(getTerminalScrollIntentKind(term1)).toBe('pinnedViewport')
    expect(getTerminalScrollIntentKind(term2)).toBe('followOutput')
  })

  it('通过 key 共享意图', () => {
    // 先在一个源终端上设置意图并通过 key 传播
    const source = createMockTerminal({ viewportY: 50, baseY: 100 })
    bindTerminalScrollIntentKey(source, 'shared-key')
    markTerminalPinnedViewport(source)

    // 两个新终端绑定同一 key，继承意图
    const term1 = createMockTerminal({ viewportY: 0, baseY: 0 })
    const term2 = createMockTerminal({ viewportY: 0, baseY: 0 })
    bindTerminalScrollIntentKey(term1, 'shared-key')
    bindTerminalScrollIntentKey(term2, 'shared-key')

    // 两个终端都应继承 pinnedViewport
    expect(getTerminalScrollIntentKind(term1)).toBe('pinnedViewport')
    expect(getTerminalScrollIntentKind(term2)).toBe('pinnedViewport')

    // 更新 term1 的意图——因为 term1 有 key，写入会同步到 key 存储
    markTerminalFollowOutput(term1)
    expect(getTerminalScrollIntentKind(term1)).toBe('followOutput')
    // term2 在 bindTerminalScrollIntentKey 时从 key 存储复制了意图到自己的
    // 直接映射，因此仍持有最初的 pinnedViewport（key 的更新不会反向同步）
    expect(getTerminalScrollIntentKind(term2)).toBe('pinnedViewport')
  })
})

// ─── 修订号增长 ───────────────────────────────────────────────────────────

describe('修订号机制', () => {
  it('每次写入意图修订号递增', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })

    markTerminalFollowOutput(term)
    const snap1 = captureTerminalStructuralScrollIntent(term)!
    const rev1 = snap1.revision

    markTerminalPinnedViewport(term)
    const snap2 = captureTerminalStructuralScrollIntent(term)!
    const rev2 = snap2.revision

    expect(rev2).toBeGreaterThan(rev1)
  })

  it('syncTerminalScrollIntentFromViewport 无变化时修订号不变', () => {
    const term = createMockTerminal({ viewportY: 100, baseY: 100 })
    syncTerminalScrollIntentFromViewport(term)
    const snap1 = captureTerminalStructuralScrollIntent(term)!
    const rev1 = snap1.revision

    syncTerminalScrollIntentFromViewport(term)
    const snap2 = captureTerminalStructuralScrollIntent(term)!
    const rev2 = snap2.revision

    expect(rev2).toBe(rev1)
  })

  it('syncTerminalScrollIntentFromViewport 状态变化时修订号递增', () => {
    const term = createMockTerminal({ viewportY: 100, baseY: 100 })
    syncTerminalScrollIntentFromViewport(term)
    const snap1 = captureTerminalStructuralScrollIntent(term)!
    const rev1 = snap1.revision

    // 滚动到非底部位置然后同步
    term.buffer!.active!.viewportY = 50
    syncTerminalScrollIntentFromViewport(term)
    const snap2 = captureTerminalStructuralScrollIntent(term)!
    const rev2 = snap2.revision

    expect(rev2).toBeGreaterThan(rev1)
  })
})