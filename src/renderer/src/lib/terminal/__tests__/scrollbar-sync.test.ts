// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { forceTerminalViewportScrollbarSync } from '../scrollbar-sync'

// ─── 辅助类型 ─────────────────────────────────────────────────────────────

interface MockBufferActive {
  viewportY: number
  baseY: number
}

/** 模拟的 xterm Terminal 对象（仅包含 forceTerminalViewportScrollbarSync 所需的属性）。 */
interface MockTerminal {
  buffer: {
    active: MockBufferActive
  }
  scrollToLine: ReturnType<typeof vi.fn>
}

function createMockTerminal(config: {
  viewportY: number
  baseY: number
  scrollToLineShouldThrow?: boolean | 'dimensions-error'
}): MockTerminal {
  const scrollToLine = vi.fn().mockImplementation(() => {
    if (config.scrollToLineShouldThrow === 'dimensions-error') {
      throw new TypeError("Cannot read properties of undefined (reading 'dimensions')")
    }
    if (config.scrollToLineShouldThrow) {
      throw new Error('generic error')
    }
  })
  return {
    buffer: {
      active: {
        viewportY: config.viewportY,
        baseY: config.baseY,
      },
    },
    scrollToLine,
  }
}

// ─── forceTerminalViewportScrollbarSync ────────────────────────────────────

describe('forceTerminalViewportScrollbarSync', () => {
  it('视口在底部（viewportY === baseY）时不做任何操作', () => {
    const term = createMockTerminal({ viewportY: 100, baseY: 100 })
    forceTerminalViewportScrollbarSync(term as unknown as Terminal)
    expect(term.scrollToLine).not.toHaveBeenCalled()
  })

  it('视口超过底部（viewportY > baseY）时不做任何操作', () => {
    const term = createMockTerminal({ viewportY: 150, baseY: 100 })
    forceTerminalViewportScrollbarSync(term as unknown as Terminal)
    expect(term.scrollToLine).not.toHaveBeenCalled()
  })

  it('viewportY 在 (0, baseY) 区间时调用 scrollToLine 同步滚动条', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    forceTerminalViewportScrollbarSync(term as unknown as Terminal)
    expect(term.scrollToLine).toHaveBeenCalledTimes(1)
    expect(term.scrollToLine).toHaveBeenCalledWith(50)
  })

  it('viewportY 为 0 且 baseY > 0 时调用 scrollToLine(0)', () => {
    const term = createMockTerminal({ viewportY: 0, baseY: 100 })
    forceTerminalViewportScrollbarSync(term as unknown as Terminal)
    expect(term.scrollToLine).toHaveBeenCalledTimes(1)
    expect(term.scrollToLine).toHaveBeenCalledWith(0)
  })

  it('viewportY 和 baseY 均为 0 时不执行滚动（已在底部）', () => {
    const term = createMockTerminal({ viewportY: 0, baseY: 0 })
    forceTerminalViewportScrollbarSync(term as unknown as Terminal)
    expect(term.scrollToLine).not.toHaveBeenCalled()
  })

  it('scrollToLine 抛出 dimensions TypeError 时静默忽略', () => {
    const term = createMockTerminal({
      viewportY: 50,
      baseY: 100,
      scrollToLineShouldThrow: 'dimensions-error',
    })
    expect(() => {
      forceTerminalViewportScrollbarSync(term as unknown as Terminal)
    }).not.toThrow()
    expect(term.scrollToLine).toHaveBeenCalledTimes(1)
  })

  it('scrollToLine 抛出非 dimensions 的 TypeError 时继续抛出', () => {
    const term = createMockTerminal({
      viewportY: 50,
      baseY: 100,
      scrollToLineShouldThrow: true,
    })
    expect(() => {
      forceTerminalViewportScrollbarSync(term as unknown as Terminal)
    }).toThrow('generic error')
  })

  it('scrollToLine 抛出非 Error 类型时继续抛出', () => {
    const term = {
      buffer: { active: { viewportY: 50, baseY: 100 } },
      scrollToLine: vi.fn().mockImplementation(() => {
        // 非标准异常值——不是 TypeError，不满足 dimensions 检查，继续抛出
        throw undefined
      }),
    }
    expect(() => {
      forceTerminalViewportScrollbarSync(term as unknown as Terminal)
    }).toThrow()
    expect(term.scrollToLine).toHaveBeenCalledTimes(1)
  })
})