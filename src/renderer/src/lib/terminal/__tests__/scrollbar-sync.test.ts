// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { forceTerminalViewportScrollbarSync } from '../scrollbar-sync'

// ─── 辅助类型 ─────────────────────────────────────────────────────────────

/** 模拟的 xterm buffer.active 对象。 */
interface MockBufferActive {
  viewportY: number
  baseY: number
}

/** 模拟的 xterm Terminal 对象（仅包含 forceTerminalViewportScrollbarSync 所需的属性）。 */
interface MockTerminal {
  buffer: {
    active: MockBufferActive
  }
  scrollLines: ReturnType<typeof vi.fn>
}

// ─── 辅助工厂函数 ──────────────────────────────────────────────────────────

/**
 * 创建一个模拟的 xterm Terminal 对象。
 *
 * @param overrides 可选覆盖项
 * @param overrides.viewportY - 视口垂直偏移（默认 0）
 * @param overrides.baseY - buffer 底部行号（默认 0）
 * @param overrides.scrollLinesShouldThrow - scrollLines 是否抛出 dimensions TypeError（默认 false）
 */
function createMockTerminal(overrides?: {
  viewportY?: number
  baseY?: number
  scrollLinesShouldThrow?: boolean
}): MockTerminal {
  const viewportY = overrides?.viewportY ?? 0
  const baseY = overrides?.baseY ?? 0

  const scrollLines = vi.fn<(delta: number) => void>()
  if (overrides?.scrollLinesShouldThrow) {
    scrollLines.mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'dimensions')")
    })
  }

  return {
    buffer: {
      active: { viewportY, baseY },
    },
    scrollLines,
  }
}

// ─── forceTerminalViewportScrollbarSync ────────────────────────────────────

describe('forceTerminalViewportScrollbarSync', () => {
  it('视口在底部（viewportY === baseY）时不做任何操作', () => {
    const term = createMockTerminal({ viewportY: 100, baseY: 100 })
    forceTerminalViewportScrollbarSync(term as unknown as Terminal)
    expect(term.scrollLines).not.toHaveBeenCalled()
  })

  it('视口超过底部（viewportY > baseY）时不做任何操作', () => {
    const term = createMockTerminal({ viewportY: 150, baseY: 100 })
    forceTerminalViewportScrollbarSync(term as unknown as Terminal)
    expect(term.scrollLines).not.toHaveBeenCalled()
  })

  it('viewportY 在 (0, baseY) 区间时执行「先上滚后下滚」', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    forceTerminalViewportScrollbarSync(term as unknown as Terminal)
    expect(term.scrollLines).toHaveBeenCalledTimes(2)
    expect(term.scrollLines.mock.calls[0]).toEqual([-1])
    expect(term.scrollLines.mock.calls[1]).toEqual([1])
  })

  it('viewportY 为 0 且 baseY > 0 时执行「先下滚后上滚」', () => {
    const term = createMockTerminal({ viewportY: 0, baseY: 100 })
    forceTerminalViewportScrollbarSync(term as unknown as Terminal)
    expect(term.scrollLines).toHaveBeenCalledTimes(2)
    expect(term.scrollLines.mock.calls[0]).toEqual([1])
    expect(term.scrollLines.mock.calls[1]).toEqual([-1])
  })

  it('viewportY 和 baseY 均为 0 时不执行滚动（已在底部）', () => {
    const term = createMockTerminal({ viewportY: 0, baseY: 0 })
    forceTerminalViewportScrollbarSync(term as unknown as Terminal)
    expect(term.scrollLines).not.toHaveBeenCalled()
  })

  it('scrollLines 抛出 dimensions 相关的 TypeError 时静默忽略', () => {
    const term = createMockTerminal({
      viewportY: 50,
      baseY: 100,
      scrollLinesShouldThrow: true,
    })
    expect(() => {
      forceTerminalViewportScrollbarSync(term as unknown as Terminal)
    }).not.toThrow()
    // 两个调用都被捕获，scrollLines 仍被调用了两次
    expect(term.scrollLines).toHaveBeenCalledTimes(2)
  })

  it('scrollLines 抛出非 dimensions 的 TypeError 时继续抛出', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    term.scrollLines.mockImplementation(() => {
      throw new TypeError('some other error')
    })
    expect(() => {
      forceTerminalViewportScrollbarSync(term as unknown as Terminal)
    }).toThrow(TypeError)
    expect(() => {
      forceTerminalViewportScrollbarSync(term as unknown as Terminal)
    }).toThrow('some other error')
  })

  it('scrollLines 抛出非 TypeError 异常时继续抛出', () => {
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    term.scrollLines.mockImplementation(() => {
      throw new Error('generic error')
    })
    expect(() => {
      forceTerminalViewportScrollbarSync(term as unknown as Terminal)
    }).toThrow('generic error')
  })

  it('第一次 scrollLines 正常、第二次抛出 dimensions 错误时，第一次仍生效', () => {
    let callCount = 0
    const term = createMockTerminal({ viewportY: 50, baseY: 100 })
    term.scrollLines.mockImplementation(() => {
      callCount++
      if (callCount === 2) {
        throw new TypeError("Cannot read properties of undefined (reading 'dimensions')")
      }
    })
    expect(() => {
      forceTerminalViewportScrollbarSync(term as unknown as Terminal)
    }).not.toThrow()
    expect(callCount).toBe(2)
  })
})
