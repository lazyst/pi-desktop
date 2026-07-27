/**
 * terminal-scroll-buffer-snapshot
 *
 * 从 xterm Terminal 的 buffer 读取滚动静像的纯函数。
 * 不依赖 xterm 实例，只操作 buffer 对象的结构化子集。
 *
 * 移植自 orca 源码的 TerminalScrollBufferSnapshot 模块。
 */

/** 终端 buffer 类型：'normal'（主 buffer）｜'alternate'（交替 buffer，如 vim/less）。 */
export type TerminalScrollBufferType = 'normal' | 'alternate'

/** 读取滚动静像所需的最小 buffer 结构。 */
export type TerminalScrollBufferTarget = {
  buffer?: {
    active?: {
      type?: string
      viewportY?: number
      baseY?: number
    }
  }
}

/** 某一时刻的 buffer 滚动位置快照。 */
export type TerminalScrollBufferSnapshot = {
  bufferType: TerminalScrollBufferType
  viewportY: number
  baseY: number
}

/**
 * 读取 terminal buffer 的滚动静像。
 * 若 buffer.active 或 viewportY/baseY 不可用，返回 null。
 */
export function readTerminalScrollBufferSnapshot(
  terminal: TerminalScrollBufferTarget
): TerminalScrollBufferSnapshot | null {
  const buffer = terminal.buffer?.active
  const viewportY = buffer?.viewportY
  const baseY = buffer?.baseY
  if (typeof viewportY !== 'number' || typeof baseY !== 'number') {
    return null
  }
  return {
    bufferType: buffer?.type === 'alternate' ? 'alternate' : 'normal',
    viewportY,
    baseY,
  }
}

/**
 * 判断视口是否已滚到底部。
 * viewportY >= baseY 时表示用户没有向上滚动，视口在最新内容处。
 */
export function isTerminalViewportAtBottom(viewportY: number, baseY: number): boolean {
  return viewportY >= baseY
}

/**
 * 将 viewportY 裁剪到 [0, baseY] 区间，防止越界。
 */
export function clampTerminalViewportY(viewportY: number, baseY: number): number {
  return Math.max(0, Math.min(viewportY, baseY))
}

/**
 * 安全地执行 terminal scroll 调用。
 * xterm 的 scrollToLine / scrollToBottom 在 buffer 未完全初始化时可能抛出
 * TypeError（"Cannot read properties of undefined (reading 'dimensions')"）。
 * 此函数捕获该特定错误并返回 false，其他异常则继续抛出。
 *
 * @param scroll 滚动函数，如 () => terminal.scrollToLine(n)
 * @returns true 执行成功，false 因 dimensions 未就绪跳过
 */
export function safeTerminalScrollCall(scroll: () => void): boolean {
  try {
    scroll()
    return true
  } catch (err) {
    if (err instanceof TypeError && /dimensions/.test(err.message)) {
      return false
    }
    throw err
  }
}