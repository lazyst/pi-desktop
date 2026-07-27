// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import {
  readTerminalScrollBufferSnapshot,
  isTerminalViewportAtBottom,
  clampTerminalViewportY,
  safeTerminalScrollCall,
  type TerminalScrollBufferSnapshot,
} from '../scroll-buffer-snapshot'

// ─── 辅助：构建模拟 xterm buffer 对象 ───────────────────────────────────────

/** 创建一个模拟的 xterm buffer.active 对象。
 * 默认填充有效值；当需要测试缺失属性时，传入 undefined 即可保留 undefined。 */
function mockActiveBuffer(overrides?: {
  type?: string
  viewportY?: number
  baseY?: number
}): { type?: string; viewportY?: number; baseY?: number } {
  return {
    type: 'normal',
    viewportY: 0,
    baseY: 0,
    ...(overrides ?? {}),
  }
}

/** 创建一个模拟的 xterm Terminal 对象（含 buffer）。 */
function mockTerminal(buffer?: ReturnType<typeof mockActiveBuffer>) {
  return { buffer: { active: buffer } }
}

// ─── readTerminalScrollBufferSnapshot ───────────────────────────────────────

describe('readTerminalScrollBufferSnapshot', () => {
  it('从完整的 buffer 读取快照', () => {
    const term = mockTerminal(mockActiveBuffer({ viewportY: 10, baseY: 100 }))
    const snap = readTerminalScrollBufferSnapshot(term)
    expect(snap).toEqual<TerminalScrollBufferSnapshot>({
      bufferType: 'normal',
      viewportY: 10,
      baseY: 100,
    })
  })

  it('bufferType 为 "alternate" 时正确识别', () => {
    const term = mockTerminal(mockActiveBuffer({ type: 'alternate', viewportY: 0, baseY: 50 }))
    const snap = readTerminalScrollBufferSnapshot(term)
    expect(snap?.bufferType).toBe('alternate')
  })

  it('bufferType 非 "alternate" 时回退为 "normal"', () => {
    const term = mockTerminal(mockActiveBuffer({ type: 'other', viewportY: 0, baseY: 50 }))
    const snap = readTerminalScrollBufferSnapshot(term)
    expect(snap?.bufferType).toBe('normal')
  })

  it('bufferType 为 undefined 时回退为 "normal"', () => {
    const term = mockTerminal(mockActiveBuffer({ type: undefined, viewportY: 0, baseY: 50 }))
    const snap = readTerminalScrollBufferSnapshot(term)
    expect(snap?.bufferType).toBe('normal')
  })

  it('buffer 不存在时返回 null', () => {
    const term = mockTerminal(undefined)
    expect(readTerminalScrollBufferSnapshot(term)).toBeNull()
  })

  it('buffer.active 为 undefined 时返回 null', () => {
    const term = { buffer: { active: undefined } }
    expect(readTerminalScrollBufferSnapshot(term)).toBeNull()
  })

  it('viewportY 不是 number 时返回 null', () => {
    const term = mockTerminal(mockActiveBuffer({ viewportY: undefined as any, baseY: 100 }))
    expect(readTerminalScrollBufferSnapshot(term)).toBeNull()
  })

  it('baseY 不是 number 时返回 null', () => {
    const term = mockTerminal(mockActiveBuffer({ viewportY: 10, baseY: undefined as any }))
    expect(readTerminalScrollBufferSnapshot(term)).toBeNull()
  })

  it('viewportY 为 0 时正常返回', () => {
    const term = mockTerminal(mockActiveBuffer({ viewportY: 0, baseY: 200 }))
    const snap = readTerminalScrollBufferSnapshot(term)
    expect(snap).not.toBeNull()
    expect(snap!.viewportY).toBe(0)
  })

  it('viewportY 和 baseY 均为 0 时正常返回', () => {
    const term = mockTerminal(mockActiveBuffer({ viewportY: 0, baseY: 0 }))
    const snap = readTerminalScrollBufferSnapshot(term)
    expect(snap).toEqual<TerminalScrollBufferSnapshot>({
      bufferType: 'normal',
      viewportY: 0,
      baseY: 0,
    })
  })
})

// ─── isTerminalViewportAtBottom ─────────────────────────────────────────────

describe('isTerminalViewportAtBottom', () => {
  it('viewportY === baseY 时返回 true', () => {
    expect(isTerminalViewportAtBottom(100, 100)).toBe(true)
  })

  it('viewportY > baseY 时返回 true（理论上不会发生，但防御性处理）', () => {
    expect(isTerminalViewportAtBottom(150, 100)).toBe(true)
  })

  it('viewportY < baseY 时返回 false（用户已向上滚动）', () => {
    expect(isTerminalViewportAtBottom(50, 100)).toBe(false)
  })

  it('viewportY 为 0, baseY 为 0 时返回 true', () => {
    expect(isTerminalViewportAtBottom(0, 0)).toBe(true)
  })
})

// ─── clampTerminalViewportY ─────────────────────────────────────────────────

describe('clampTerminalViewportY', () => {
  it('viewportY 在 [0, baseY] 内时保持不变', () => {
    expect(clampTerminalViewportY(50, 100)).toBe(50)
  })

  it('viewportY 为 0 时返回 0', () => {
    expect(clampTerminalViewportY(0, 100)).toBe(0)
  })

  it('viewportY 等于 baseY 时返回 baseY', () => {
    expect(clampTerminalViewportY(100, 100)).toBe(100)
  })

  it('viewportY 为负数时裁剪为 0', () => {
    expect(clampTerminalViewportY(-10, 100)).toBe(0)
  })

  it('viewportY 超过 baseY 时裁剪为 baseY', () => {
    expect(clampTerminalViewportY(200, 100)).toBe(100)
  })

  it('baseY 为 0 时 viewportY 被裁剪为 0', () => {
    expect(clampTerminalViewportY(50, 0)).toBe(0)
  })

  it('viewportY 和 baseY 均为 0 时返回 0', () => {
    expect(clampTerminalViewportY(0, 0)).toBe(0)
  })
})

// ─── safeTerminalScrollCall ─────────────────────────────────────────────────

describe('safeTerminalScrollCall', () => {
  it('scroll 函数正常执行时返回 true', () => {
    const scroll = vi.fn()
    expect(safeTerminalScrollCall(scroll)).toBe(true)
    expect(scroll).toHaveBeenCalledOnce()
  })

  it('捕获 dimensions 相关的 TypeError 并返回 false', () => {
    const scroll = vi.fn(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'dimensions')")
    })
    expect(safeTerminalScrollCall(scroll)).toBe(false)
    expect(scroll).toHaveBeenCalledOnce()
  })

  it('不捕获非 dimensions 的 TypeError', () => {
    const scroll = vi.fn(() => {
      throw new TypeError('some other error')
    })
    expect(() => safeTerminalScrollCall(scroll)).toThrow(TypeError)
    expect(() => safeTerminalScrollCall(scroll)).toThrow('some other error')
  })

  it('不捕获非 TypeError 异常', () => {
    const scroll = vi.fn(() => {
      throw new Error('generic error')
    })
    expect(() => safeTerminalScrollCall(scroll)).toThrow('generic error')
  })

  it('scroll 函数抛出包含 "dimensions" 子串的其他异常时继续抛出', () => {
    // 只有 TypeError 类型且 message 包含 "dimensions" 才被捕获
    const scroll = vi.fn(() => {
      throw new RangeError('dimensions out of range')
    })
    expect(() => safeTerminalScrollCall(scroll)).toThrow(RangeError)
  })

  it('scroll 未调用时不做任何操作', () => {
    const scroll = vi.fn()
    safeTerminalScrollCall(scroll)
    expect(scroll).toHaveBeenCalledOnce()
  })
})