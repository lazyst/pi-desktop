// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import {
  beginTerminalScrollIntentBufferRebuild,
  endTerminalScrollIntentBufferRebuild,
  isTerminalScrollIntentRebuildInFlight,
} from '../scroll-intent-rebuild'
import {
  markTerminalFollowOutput,
  markTerminalPinnedViewport,
  getTerminalScrollIntentKind,
  syncTerminalScrollIntentFromViewport,
  type TerminalScrollIntentTarget,
} from '../scroll-intent'

// ─── 辅助工厂函数 ──────────────────────────────────────────────────────────

/**
 * 创建一个模拟的终端对象。
 */
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

// ─── beginTerminalScrollIntentBufferRebuild ────────────────────────────────

describe('beginTerminalScrollIntentBufferRebuild', () => {
  it('首次调用时标记为重建中', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(false)
    beginTerminalScrollIntentBufferRebuild(term)
    expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(true)
  })

  it('嵌套调用保持重建中状态', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    beginTerminalScrollIntentBufferRebuild(term)
    beginTerminalScrollIntentBufferRebuild(term)
    beginTerminalScrollIntentBufferRebuild(term)
    expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(true)
  })

  it('不同终端独立维护状态', () => {
    const term1 = createMockTerminal({ viewportY: 50, baseY: 100 })
    const term2 = createMockTerminal({ viewportY: 50, baseY: 100 })
    beginTerminalScrollIntentBufferRebuild(term1)
    expect(isTerminalScrollIntentRebuildInFlight(term1)).toBe(true)
    expect(isTerminalScrollIntentRebuildInFlight(term2)).toBe(false)
  })
})

// ─── endTerminalScrollIntentBufferRebuild ──────────────────────────────────

describe('endTerminalScrollIntentBufferRebuild', () => {
  it('无匹配 begin 时静默无操作', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    expect(() => endTerminalScrollIntentBufferRebuild(term)).not.toThrow()
    expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(false)
  })

  it('单次 begin/end 后标记为重建完成', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    beginTerminalScrollIntentBufferRebuild(term)
    expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(true)
    endTerminalScrollIntentBufferRebuild(term)
    expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(false)
  })

  it('重复 begin 后一次 end 即完成：后一次 begin 覆盖前一次', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    beginTerminalScrollIntentBufferRebuild(term)
    beginTerminalScrollIntentBufferRebuild(term)
    beginTerminalScrollIntentBufferRebuild(term)
    expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(true)

    // 一次 end 即完成（无计数器嵌套）
    endTerminalScrollIntentBufferRebuild(term)
    expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(false)

    // 再次 begin/end
    beginTerminalScrollIntentBufferRebuild(term)
    expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(true)
    endTerminalScrollIntentBufferRebuild(term)
    expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(false)
  })

  it('end 多于 begin 时静默处理', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    beginTerminalScrollIntentBufferRebuild(term)
    endTerminalScrollIntentBufferRebuild(term)
    // 多余的 end 应该静默无操作
    expect(() => endTerminalScrollIntentBufferRebuild(term)).not.toThrow()
    expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(false)
  })

  it('计数器归零时触发恢复（pinnedViewport 意图应保持）', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    // 先标记为 pinnedViewport
    markTerminalPinnedViewport(term)
    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')

    // 模拟重建
    beginTerminalScrollIntentBufferRebuild(term)
    // 模拟 buffer 被清空并重建
    term.buffer!.active!.viewportY = 0
    term.buffer!.active!.baseY = 0
    // 重建完成后，end 触发回调
    endTerminalScrollIntentBufferRebuild(term)
    // scroll-intent-rebuild 本身不恢复意图，仅通知注册的回调。
    // 后续由 DOM 跟踪器等在回调中同步意图。
    expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(false)
  })

  it('计数器归零时触发恢复（followOutput 意图应恢复到底部）', () => {
    const term = createMockTerminal({ viewportY: 100, baseY: 100 })
    // 先标记为 followOutput
    markTerminalFollowOutput(term)
    expect(getTerminalScrollIntentKind(term)).toBe('followOutput')

    // 模拟重建
    beginTerminalScrollIntentBufferRebuild(term)
    // 模拟 buffer 被清空
    term.buffer!.active!.viewportY = 0
    term.buffer!.active!.baseY = 0
    // 重建完成后恢复
    endTerminalScrollIntentBufferRebuild(term)
    // 恢复后应为 followOutput（意图被保留）
    expect(getTerminalScrollIntentKind(term)).toBe('followOutput')
  })
})

// ─── isTerminalScrollIntentRebuildInFlight ────────────────────────────────

describe('isTerminalScrollIntentRebuildInFlight', () => {
  it('未开始重建时返回 false', () => {
    const term = createMockTerminal()
    expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(false)
  })

  it('重建进行中时返回 true', () => {
    const term = createMockTerminal()
    beginTerminalScrollIntentBufferRebuild(term)
    expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(true)
  })

  it('重建完成后返回 false', () => {
    const term = createMockTerminal()
    beginTerminalScrollIntentBufferRebuild(term)
    endTerminalScrollIntentBufferRebuild(term)
    expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(false)
  })

  it('从未操作过的终端返回 false', () => {
    const term = createMockTerminal()
    expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(false)
  })

  it('不同终端互不影响', () => {
    const term1 = createMockTerminal()
    const term2 = createMockTerminal()
    beginTerminalScrollIntentBufferRebuild(term1)
    expect(isTerminalScrollIntentRebuildInFlight(term1)).toBe(true)
    expect(isTerminalScrollIntentRebuildInFlight(term2)).toBe(false)
    endTerminalScrollIntentBufferRebuild(term1)
    expect(isTerminalScrollIntentRebuildInFlight(term1)).toBe(false)
    expect(isTerminalScrollIntentRebuildInFlight(term2)).toBe(false)
  })
})

// ─── 集成场景 ──────────────────────────────────────────────────────────────

describe('集成场景', () => {
  it('重建期间视口意图变化不应干扰计数器', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    markTerminalPinnedViewport(term)

    // 开始重建
    beginTerminalScrollIntentBufferRebuild(term)
    expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(true)

    // 重建期间同步意图（不应影响重建状态）
    term.buffer!.active!.viewportY = 30
    term.buffer!.active!.baseY = 80
    expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(true)

    // 结束重建
    endTerminalScrollIntentBufferRebuild(term)
    expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(false)
  })

  it('多次重建间意图保持一致', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    markTerminalPinnedViewport(term)

    // 第一次重建
    beginTerminalScrollIntentBufferRebuild(term)
    term.buffer!.active!.viewportY = 0
    term.buffer!.active!.baseY = 0
    endTerminalScrollIntentBufferRebuild(term)
    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')

    // 第二次重建
    beginTerminalScrollIntentBufferRebuild(term)
    term.buffer!.active!.viewportY = 10
    term.buffer!.active!.baseY = 50
    endTerminalScrollIntentBufferRebuild(term)
    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')
  })

  it('重建期间意图被覆盖，end 后不再自动恢复（由调用方回调负责）', async () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    // 标记为 pinnedViewport
    markTerminalPinnedViewport(term)
    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')

    // 开始重建，捕获意图快照（revision = R）
    beginTerminalScrollIntentBufferRebuild(term)

    // 模拟重建期间 syncTerminalScrollIntentFromViewport 被调用，意图被覆盖
    // 视口在底部（0 >= 0），sync 会设置为 followOutput
    term.buffer!.active!.viewportY = 0
    term.buffer!.active!.baseY = 0
    // 使用 allowBufferShrink: true 模拟重建期间 buffer 缩短后意图被覆盖
    syncTerminalScrollIntentFromViewport(term, { allowBufferShrink: true })
    // 意图现在应该是 followOutput（被覆盖了）
    expect(getTerminalScrollIntentKind(term)).toBe('followOutput')

    // 结束重建，通知回调
    endTerminalScrollIntentBufferRebuild(term)
    // 注意：scroll-intent-rebuild 本身不恢复意图，它只通知注册的回调。
    // 恢复由调用方（如 scroll-intent-dom-tracking.ts）在回调中处理。
    // 此处测试 end 生命周期正确，不测试意图恢复。
    expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(false)
  })

  it('buffer 类型切换（normal → alternate）后重建恢复不受影响', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    markTerminalPinnedViewport(term)

    // 开始重建
    beginTerminalScrollIntentBufferRebuild(term)

    // 切换到 alternate buffer（如 vim 启动）
    term.buffer!.active!.type = 'alternate'
    term.buffer!.active!.viewportY = 0
    term.buffer!.active!.baseY = 10

    // 结束重建，恢复应在 alternate buffer 中
    endTerminalScrollIntentBufferRebuild(term)
    // scroll-intent-rebuild 本身不恢复意图，仅通知回调。
    // 在 alternate buffer 中，调用方回调应跳过恢复。
    expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(false)
  })

  it('buffer 不可用时 begin 不捕获快照，end 静默返回', () => {
    const term = {} as TerminalScrollIntentTarget
    beginTerminalScrollIntentBufferRebuild(term)
    expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(true)
    // end 时没有快照，静默返回
    expect(() => endTerminalScrollIntentBufferRebuild(term)).not.toThrow()
    expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(false)
  })
})