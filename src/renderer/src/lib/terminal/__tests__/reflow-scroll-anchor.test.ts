// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import {
  captureLogicalLineAnchor,
  resolveLogicalCellOffsetLine,
  type ReflowLineReader,
} from '../reflow-scroll-anchor'

// ─── 辅助：构建模拟的 xterm 行对象 ─────────────────────────────────────────

type MockCell = {
  getCode: () => number
  getWidth: () => number
}

type MockLine = {
  isWrapped: boolean
  length: number
  getCell: (x: number) => MockCell | undefined
}

function mockCell(code: number, width: number): MockCell {
  return { getCode: () => code, getWidth: () => width }
}

/** 创建一个普通行（非折行），每个单元格填充默认字符。 */
function normalLine(length: number, overrides?: Partial<MockLine>): MockLine {
  const cells: MockCell[] = Array.from({ length }, () => mockCell(32, 1))
  return {
    isWrapped: false,
    length,
    getCell: (x: number) => (x >= 0 && x < length ? cells[x] : undefined),
    ...overrides,
  }
}

/** 创建一个折行行（isWrapped = true），每个单元格填充默认字符。 */
function wrappedLine(length: number): MockLine {
  return {
    ...normalLine(length),
    isWrapped: true,
  }
}

/** 创建一个行，可在指定位置替换特定单元格。 */
function lineWithCells(
  length: number,
  cells: { col: number; code: number; width: number }[],
  isWrapped: boolean = false
): MockLine {
  const defaultCells: MockCell[] = Array.from({ length }, () => mockCell(32, 1))
  for (const { col, code, width } of cells) {
    if (col >= 0 && col < length) {
      defaultCells[col] = mockCell(code, width)
    }
  }
  return {
    isWrapped,
    length,
    getCell: (x: number) => (x >= 0 && x < length ? defaultCells[x] : undefined),
  }
}

type MockBuffer = {
  type: string
  cursorY: number
  cursorX: number
  viewportY: number
  baseY: number
  length: number
  getLine: (y: number) => MockLine | undefined
  getNullCell: () => MockCell
}

type MockTerminal = {
  cols: number
  rows: number
  buffer: { active: MockBuffer }
  options: {
    reflowCursorLine?: boolean
    windowsPty?: { backend?: string; buildNumber?: number }
  }
}

/** 构建模拟的 xterm Terminal 对象。 */
function mockTerminal(options: {
  cols: number
  rows: number
  baseY: number
  viewportY: number
  cursorY: number
  lines: MockLine[]
  reflowCursorLine?: boolean
  windowsPty?: { backend?: string; buildNumber?: number }
}): MockTerminal {
  return {
    cols: options.cols,
    rows: options.rows,
    buffer: {
      active: {
        type: 'normal',
        cursorY: options.cursorY,
        cursorX: 0,
        viewportY: options.viewportY,
        baseY: options.baseY,
        length: options.lines.length,
        getLine: (y: number) => (y >= 0 && y < options.lines.length ? options.lines[y] : undefined),
        getNullCell: () => mockCell(0, 1),
      },
    },
    options: {
      reflowCursorLine: options.reflowCursorLine ?? false,
      windowsPty: options.windowsPty,
    },
  }
}

// ─── captureLogicalLineAnchor ───────────────────────────────────────────────

describe('captureLogicalLineAnchor', () => {
  it('viewportY 在逻辑行中间时，找到逻辑行首并计算偏移', () => {
    // 场景：3 行组成的逻辑行，viewportY 在第 3 行
    // 行 0: 正常行（逻辑行首）
    // 行 1: 折行
    // 行 2: 折行（viewportY = 2）
    const lines = [normalLine(80), wrappedLine(80), wrappedLine(80)]
    const term = mockTerminal({ cols: 80, rows: 24, baseY: 100, viewportY: 2, cursorY: 50, lines })
    const result = captureLogicalLineAnchor(term as any, 2)
    expect(result).toEqual({ cellOffset: 160, lineY: 0 })
  })

  it('viewportY 已在逻辑行首时，cellOffset 为 0', () => {
    const lines = [normalLine(80), wrappedLine(80)]
    const term = mockTerminal({ cols: 80, rows: 24, baseY: 100, viewportY: 0, cursorY: 50, lines })
    const result = captureLogicalLineAnchor(term as any, 0)
    expect(result).toEqual({ cellOffset: 0, lineY: 0 })
  })

  it('单行非折行逻辑行，cellOffset 为 0', () => {
    const lines = [normalLine(80)]
    const term = mockTerminal({ cols: 80, rows: 24, baseY: 100, viewportY: 50, cursorY: 60, lines })
    const result = captureLogicalLineAnchor(term as any, 50)
    expect(result).toEqual({ cellOffset: 0, lineY: 50 })
  })

  it('getLine 不可用时返回 undefined', () => {
    const term = {
      cols: 80,
      rows: 24,
      buffer: {
        active: { getLine: undefined },
      },
      options: {},
    }
    expect(captureLogicalLineAnchor(term as any, 0)).toBeUndefined()
  })

  it('windowsPty 旧版时返回 undefined（shouldKeepPhysicalResizeAnchor）', () => {
    const lines = [normalLine(80)]
    const term = mockTerminal({
      cols: 80,
      rows: 24,
      baseY: 100,
      viewportY: 5,
      cursorY: 50,
      lines,
      windowsPty: { backend: 'conpty', buildNumber: 19045 },
    })
    // buildNumber < 21376 时应该返回 undefined
    expect(captureLogicalLineAnchor(term as any, 5 as any)).toBeUndefined()
  })

  it('windowsPty 新版时正常返回锚点', () => {
    const lines = [normalLine(80)]
    const term = mockTerminal({
      cols: 80,
      rows: 24,
      baseY: 100,
      viewportY: 5,
      cursorY: 50,
      lines,
      windowsPty: { backend: 'conpty', buildNumber: 21376 },
    })
    const result = captureLogicalLineAnchor(term as any, 5 as any)
    expect(result).toEqual({ cellOffset: 0, lineY: 5 })
  })

  it('光标在逻辑行内且 reflowCursorLine 未启用时返回 undefined', () => {
    // 逻辑行：行 0-2（行 1,2 折行），光标在行 1
    // cursorLineY = baseY + cursorY = 100 + 1 = 101
    // 但 viewportY=2 的逻辑行首是行 0，光标在行 1 也在同一逻辑行内
    const lines = [normalLine(80), wrappedLine(80), wrappedLine(80)]
    const term = mockTerminal({ cols: 80, rows: 24, baseY: 100, viewportY: 2, cursorY: 1, lines })
    // cursorY=1 意味着 cursorLineY = 100 + 1 = 101，而 viewportY=2 在行 0-2 的逻辑行内
    // 但 lineContainsLine 检查的是从 logicalStartY+1 到 cursorLineY 的所有行是否都是 wrapped
    // logicalStartY=0, cursorLineY=101, 检查行 1-101 是否都是 wrapped
    // 行 1 和 2 是 wrapped，但行 3-101 不是（只有 3 行），所以 lineContainsLine 返回 false
    // 需要调整：让 cursorLineY 在逻辑行内
    const term2 = mockTerminal({
      cols: 80,
      rows: 24,
      baseY: 0,
      viewportY: 2,
      cursorY: 1,
      lines,
      reflowCursorLine: false,
    })
    // cursorLineY = 0 + 1 = 1, logicalStartY = 0
    // 检查行 1 是否 wrapped: true, 所以 lineContainsLine 返回 true
    expect(captureLogicalLineAnchor(term2 as any, 2)).toBeUndefined()
  })

  it('光标在逻辑行外时正常返回锚点', () => {
    const lines = [normalLine(80), wrappedLine(80), normalLine(80)]
    const term = mockTerminal({
      cols: 80,
      rows: 24,
      baseY: 0,
      viewportY: 2,
      cursorY: 3,
      lines,
      reflowCursorLine: false,
    })
    // 逻辑行首为行 2（行 2 不是 wrapped），cursorLineY = 3
    // lineContainsLine 检查行 3 是否 wrapped: false，所以光标不在同一逻辑行内
    const result = captureLogicalLineAnchor(term as any, 2)
    expect(result).toEqual({ cellOffset: 0, lineY: 2 })
  })

  it('reflowCursorLine 启用时，即使光标在逻辑行内也返回锚点', () => {
    const lines = [normalLine(80), wrappedLine(80)]
    const term = mockTerminal({
      cols: 80,
      rows: 24,
      baseY: 0,
      viewportY: 1,
      cursorY: 0,
      lines,
      reflowCursorLine: true,
    })
    // cursorLineY = 0, logicalStartY = 0，光标在逻辑行首
    // 但 reflowCursorLine 为 true，所以不跳过
    const result = captureLogicalLineAnchor(term as any, 1)
    expect(result).toEqual({ cellOffset: 80, lineY: 0 })
  })

  it('多折行链，计算正确的 cellOffset', () => {
    // 4 行折行链，每行 80 列，viewportY = 3
    const lines = [normalLine(80), wrappedLine(80), wrappedLine(80), wrappedLine(80)]
    const term = mockTerminal({
      cols: 80,
      rows: 24,
      baseY: 100,
      viewportY: 3,
      cursorY: 50,
      lines,
    })
    // 从行 0 到行 2，每行 80 格，共 240
    const result = captureLogicalLineAnchor(term as any, 3)
    expect(result).toEqual({ cellOffset: 240, lineY: 0 })
  })

  it('CJK 换行边界：最后列是空占位且下一行首是宽字符时少计 1', () => {
    // 行 0: 最后列（col 79）为空占位（code=0, width=1），下一行首列是宽字符（width=2）
    const cols = 80
    const lines = [
      lineWithCells(cols, [{ col: cols - 1, code: 0, width: 1 }]),
      lineWithCells(cols, [{ col: 0, code: 0x4e2d, width: 2 }], true),
    ]
    const term = mockTerminal({
      cols,
      rows: 24,
      baseY: 100,
      viewportY: 1,
      cursorY: 50,
      lines,
    })
    // 行 0 的有效格数为 cols - 1 = 79
    const result = captureLogicalLineAnchor(term as any, 1)
    expect(result).toEqual({ cellOffset: 79, lineY: 0 })
  })

  it('viewportY 为 0 时返回 { cellOffset: 0, lineY: 0 }', () => {
    const lines = [normalLine(80)]
    const term = mockTerminal({ cols: 80, rows: 24, baseY: 100, viewportY: 0, cursorY: 50, lines })
    const result = captureLogicalLineAnchor(term as any, 0)
    expect(result).toEqual({ cellOffset: 0, lineY: 0 })
  })

  it('windowsPty 不存在时正常返回锚点', () => {
    const lines = [normalLine(80)]
    const term = mockTerminal({
      cols: 80,
      rows: 24,
      baseY: 100,
      viewportY: 5,
      cursorY: 50,
      lines,
      windowsPty: undefined,
    })
    const result = captureLogicalLineAnchor(term as any, 5)
    expect(result).toEqual({ cellOffset: 0, lineY: 5 })
  })
})

// ─── resolveLogicalCellOffsetLine ───────────────────────────────────────────

describe('resolveLogicalCellOffsetLine', () => {
  it('沿折行链前进，消耗单元格后找到目标行', () => {
    // 行 0: 正常行（逻辑行首），行 1-2: 折行
    // cellOffset = 80，应定位到行 1
    const lines = [normalLine(80), wrappedLine(80), wrappedLine(80)]
    const term = mockTerminal({ cols: 80, rows: 24, baseY: 100, viewportY: 0, cursorY: 50, lines })
    const result = resolveLogicalCellOffsetLine(term as any, 0, 80)
    expect(result).toBe(1)
  })

  it('cellOffset 为 0 时直接返回 logicalStartY', () => {
    const lines = [normalLine(80), wrappedLine(80)]
    const term = mockTerminal({ cols: 80, rows: 24, baseY: 100, viewportY: 0, cursorY: 50, lines })
    expect(resolveLogicalCellOffsetLine(term as any, 0, 0)).toBe(0)
    expect(resolveLogicalCellOffsetLine(term as any, 5, 0)).toBe(5)
  })

  it('cellOffset 恰好等于某行单元格数时前进到下一行', () => {
    // cellOffset = 80，行 0 的 80 格正好消耗完，前进到行 1
    const lines = [normalLine(80), wrappedLine(80), normalLine(80)]
    const term = mockTerminal({ cols: 80, rows: 24, baseY: 100, viewportY: 0, cursorY: 50, lines })
    const result = resolveLogicalCellOffsetLine(term as any, 0, 80)
    expect(result).toBe(1)
  })

  it('cellOffset 在行中间时停在当前行', () => {
    // cellOffset = 40，小于 80，停在行 0
    const lines = [normalLine(80), wrappedLine(80)]
    const term = mockTerminal({ cols: 80, rows: 24, baseY: 100, viewportY: 0, cursorY: 50, lines })
    const result = resolveLogicalCellOffsetLine(term as any, 0, 40)
    expect(result).toBe(0)
  })

  it('无折行时直接返回 logicalStartY', () => {
    const lines = [normalLine(80), normalLine(80), normalLine(80)]
    const term = mockTerminal({ cols: 80, rows: 24, baseY: 100, viewportY: 0, cursorY: 50, lines })
    // cellOffset 为 0，返回 logicalStartY
    expect(resolveLogicalCellOffsetLine(term as any, 5, 0)).toBe(5)
    // cellOffset 非 0，但下一行不是 wrapped，停在当前行
    expect(resolveLogicalCellOffsetLine(term as any, 5, 40)).toBe(5)
  })

  it('CJK 换行边界：考虑 cols-1 的情况', () => {
    // 行 0: 最后列是空占位，下一行首是宽字符
    const cols = 80
    const lines = [
      lineWithCells(cols, [{ col: cols - 1, code: 0, width: 1 }]),
      lineWithCells(cols, [{ col: 0, code: 0x4e2d, width: 2 }], true),
      normalLine(cols),
    ]
    const term = mockTerminal({
      cols,
      rows: 24,
      baseY: 100,
      viewportY: 0,
      cursorY: 50,
      lines,
    })
    // 行 0 有效格数为 79，cellOffset = 78 应停在行 0（未消耗完）
    expect(resolveLogicalCellOffsetLine(term as any, 0, 78)).toBe(0)
    // cellOffset = 79 恰好消耗完行 0 的有效格数，前进到行 1
    const result = resolveLogicalCellOffsetLine(term as any, 0, 79)
    expect(result).toBe(1)
  })

  it('到达 buffer 末尾时停在最后一行', () => {
    // 行 0: 正常行，baseY = 0（只有 1 行）
    const lines = [normalLine(80)]
    const term = mockTerminal({ cols: 80, rows: 24, baseY: 0, viewportY: 0, cursorY: 0, lines })
    const result = resolveLogicalCellOffsetLine(term as any, 0, 100)
    // 只有一行，无法前进，停在行 0
    expect(result).toBe(0)
  })

  it('large cellOffset 沿多行前进', () => {
    // 5 行折行链，每行 80 格，cellOffset = 240
    const lines = [
      normalLine(80),
      wrappedLine(80),
      wrappedLine(80),
      wrappedLine(80),
      wrappedLine(80),
    ]
    const term = mockTerminal({
      cols: 80,
      rows: 24,
      baseY: 100,
      viewportY: 0,
      cursorY: 50,
      lines,
    })
    // 240 / 80 = 3，前进 3 行到行 3
    const result = resolveLogicalCellOffsetLine(term as any, 0, 240)
    expect(result).toBe(3)
  })
})

// ─── ReflowLineReader 类型导出验证 ──────────────────────────────────────────

describe('ReflowLineReader 类型', () => {
  it('导出 ReflowLineReader 类型（编译期验证）', () => {
    const reader: ReflowLineReader = {
      isWrapped: () => false,
      getCellMetrics: () => ({ code: 32, width: 1 }),
    }
    expect(reader.isWrapped(0)).toBe(false)
    expect(reader.getCellMetrics(0, 0)).toEqual({ code: 32, width: 1 })
  })
})