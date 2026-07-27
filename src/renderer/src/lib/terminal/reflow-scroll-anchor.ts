/**
 * reflow-scroll-anchor
 *
 * 终端在 resize（列宽变化）时，xterm 会对 buffer 行进行 reflow（重排），
 * 导致视口（viewport）内容漂移。此模块提供两个纯函数：
 *
 * 1. `captureLogicalLineAnchor` — 在 reflow 前记录逻辑行锚点（逻辑行首 + 单元格偏移）
 * 2. `resolveLogicalCellOffsetLine` — 在 reflow 后从锚点重新定位视口行号
 *
 * 核心思路：不依赖物理行号（reflow 后会变化），而是记录用户在视口顶行在
 * 逻辑行中的"单元格偏移量"，reflow 后重新计算该偏移量对应的新行号。
 *
 * 移植自 orca 源码的 terminal-reflow-scroll-anchor 模块，改用 xterm 公开 API。
 */
import type { Terminal } from '@xterm/xterm'

// ─── 类型 ──────────────────────────────────────────────────────────────────

/** 用于读取行信息的接口，抽象对 xterm buffer 的访问。 */
export type ReflowLineReader = {
  /** 获取指定行指定列的单元格信息（码点和宽度）。 */
  getCellMetrics: (lineY: number, column: number) => { code: number; width: number } | undefined
  /** 判断指定行是否是从上一行继续的折行（wrapped）。 */
  isWrapped: (lineY: number) => boolean
}

// ─── 公开函数 ──────────────────────────────────────────────────────────────

/**
 * 在 reflow 前捕获逻辑行锚点。
 *
 * 从 viewportY 处向上回溯，找到所属逻辑行的首行（isWrapped === false），
 * 然后计算 viewportY 在该逻辑行内的单元格偏移量。
 *
 * @param terminal   xterm Terminal 实例
 * @param viewportY  当前视口顶行号（buffer 坐标）
 * @returns          锚点信息：{ cellOffset, lineY } 或 undefined（无法锚定）
 *                   - cellOffset: viewportY 在逻辑行内的单元格偏移
 *                   - lineY: 逻辑行的首行行号
 */
export function captureLogicalLineAnchor(
  terminal: Terminal,
  viewportY: number
): { cellOffset: number; lineY: number } | undefined {
  const buf = terminal.buffer.active
  if (typeof buf.getLine !== 'function' || shouldKeepPhysicalResizeAnchor(terminal)) {
    return undefined
  }
  const lines = createReflowLineReader(terminal)
  // 从 viewportY 向上回溯，找到逻辑行的首行
  let lineY = viewportY
  while (lineY > 0 && lines.isWrapped(lineY)) {
    lineY -= 1
  }
  // 若光标在此逻辑行内且 reflowCursorLine 未启用，跳过锚定
  // 原因：当用户正在编辑某行时 reflow，保持光标可见比保持视口位置更重要
  const cursorLineY = buf.baseY + buf.cursorY
  if (terminal.options?.reflowCursorLine !== true && lineContainsLine(lines, lineY, cursorLineY)) {
    return undefined
  }
  // 计算 viewportY 在逻辑行内的单元格偏移
  let cellOffset = 0
  for (let currentLineY = lineY; currentLineY < viewportY; currentLineY += 1) {
    cellOffset += readReflowedRowCellCount(terminal, lines, currentLineY)
  }
  return { cellOffset, lineY }
}

/**
 * 在 reflow 后，从锚点重新定位视口行号。
 *
 * 从 logicalStartY 开始，沿着折行链向前移动，累计消耗 cellOffset 个单元格后
 * 返回对应的新行号。
 *
 * @param terminal        xterm Terminal 实例（reflow 后状态）
 * @param logicalStartY   reflow 前记录的锚点逻辑行首行号
 * @param cellOffset      reflow 前记录的逻辑行内单元格偏移
 * @returns               新视口行号（buffer 坐标）
 */
export function resolveLogicalCellOffsetLine(
  terminal: Terminal,
  logicalStartY: number,
  cellOffset: number
): number {
  const buf = terminal.buffer.active
  const lines = createReflowLineReader(terminal)
  let lineY = logicalStartY
  let remainingCells = cellOffset
  // 沿折行链前进，每行消耗该行的单元格数
  while (lineY < buf.baseY && lines.isWrapped(lineY + 1)) {
    const rowCells = readReflowedRowCellCount(terminal, lines, lineY)
    if (remainingCells < rowCells) {
      break
    }
    remainingCells -= rowCells
    lineY += 1
  }
  return lineY
}

// ─── 内部工具函数 ──────────────────────────────────────────────────────────

/**
 * 判断 targetY 是否在从 logicalStartY 开始的同一逻辑行内
 *（从 logicalStartY+1 到 targetY 的所有行都是 wrapped）。
 */
function lineContainsLine(
  lines: ReflowLineReader,
  logicalStartY: number,
  targetY: number
): boolean {
  if (targetY < logicalStartY) {
    return false
  }
  for (let lineY = logicalStartY + 1; lineY <= targetY; lineY += 1) {
    if (!lines.isWrapped(lineY)) {
      return false
    }
  }
  return true
}

/**
 * 读取某行在 reflow 中的有效单元格数。
 *
 * 通常情况下每行单元格数为 cols，但有一种特殊情况：
 * 当最后一个单元格为空占位（code=0, width=1）且下一行第一个单元格
 * 是宽度为 2 的字符（如 CJK）时，说明该宽字符在 reflow 中被挤到了下一行，
 * 最后一个单元格只是占位，不计入逻辑偏移。
 */
function readReflowedRowCellCount(
  terminal: Terminal,
  lines: ReflowLineReader,
  lineY: number
): number {
  const cols = Math.max(terminal.cols, 1)
  const lastCell = lines.getCellMetrics(lineY, cols - 1)
  const nextFirstCell = lines.getCellMetrics(lineY + 1, 0)
  // 如果最后单元格是空占位且下一行第一个是宽字符，该行有效格数为 cols - 1
  return lastCell?.code === 0 && lastCell.width === 1 && nextFirstCell?.width === 2
    ? cols - 1
    : cols
}

/**
 * 判断是否应使用物理行锚定而非逻辑行锚定。
 *
 * 对于旧版 Windows PTY（buildNumber < 21376 或 backend 非 conpty），
 * xterm 不会对 buffer 进行 reflow，因此无需逻辑行锚定。
 */
function shouldKeepPhysicalResizeAnchor(terminal: Terminal): boolean {
  const windowsPty = terminal.options?.windowsPty
  if (!windowsPty?.buildNumber) {
    return false
  }
  return windowsPty.backend !== 'conpty' || windowsPty.buildNumber < 21376
}

/**
 * 创建 ReflowLineReader，使用 xterm 的公开 API（buffer.active.getLine）。
 *
 * 与 orca 原版的区别：不使用 _core._bufferService.buffer.lines 内部路径，
 * 仅依赖 @xterm/xterm 公开的 IBuffer.getLine / IBufferLine.getCell 方法。
 */
function createReflowLineReader(terminal: Terminal): ReflowLineReader {
  const buffer = terminal.buffer.active
  return {
    isWrapped: (lineY) => buffer.getLine(lineY)?.isWrapped ?? false,
    getCellMetrics: (lineY, column) => {
      const cell = buffer.getLine(lineY)?.getCell(column)
      return cell ? { code: cell.getCode(), width: cell.getWidth() } : undefined
    }
  }
}
