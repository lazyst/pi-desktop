/**
 * scrollbar-sync
 *
 * 强制 xterm 滚动条同步的实用函数。
 *
 * ## 为什么需要
 *
 * xterm 6 在 viewportY（ydisp）不变时，滚动条滑块可能停留在旧位置不更新。
 * 在 split-pane 调整尺寸、终端切换等场景后，viewportY 未变化但 xterm 内部
 * 的滚动条状态已过时，导致滑块位置与视口实际位置不一致。
 *
 * ## 实现方式
 *
 * 直接调用 scrollToBottom（底部时）或 scrollToLine（非底部时）使 xterm 内部
 * 重绘滚动条，而非使用「上滚一行 + 下滚一行」的微调（jiggle）。
 * jiggle 在 resize 场景下会导致终端内容可见抖动（向上跳一行再跳回），
 * 而且 scrollToBottom/scrollToLine 在 xterm 6 中已能触发滚动条重绘。
 *
 * 移植自 orca 源码的 forceTerminalViewportScrollbarSync 模块 — 但 orca 已弃用 jiggle 方案。
 */

import type { Terminal } from '@xterm/xterm'

/**
 * 强制同步 xterm 的滚动条位置。
 *
 * 使用 scrollToBottom（底部时）或 scrollToLine（非底部时）直接设置视口位置，
 * 触发 xterm 内部滚动条重绘，而不使用会导致可见抖动的 scrollLines 微调。
 * 适用于 split-pane 调整尺寸后需要刷新滚动条的场景。
 *
 * @param terminal - xterm Terminal 实例
 */
export function forceTerminalViewportScrollbarSync(terminal: Terminal): void {
  const buf = terminal.buffer.active

  if (buf.viewportY >= buf.baseY) {
    // 已在底部：不做任何操作。scrollToBottom 已正确放置滚动条滑块，
    // 且 jiggle 会导致终端停止跟随活动输出。
    return
  }

  // 非底部：调用 scrollToLine 直接跳转到当前视口位置，触发 xterm 内部滚动条重绘。
  // scrollToLine 在 viewportY 不变时也会触发 xterm 的滚动条更新逻辑。
  // 使用 safeScrollCall 防御性包装，处理 buffer 未完全初始化时的边界情况。
  safeScrollCall(() => terminal.scrollToLine(buf.viewportY))
}

/**
 * 安全执行 xterm 滚动调用。
 *
 * xterm 的 scrollToLine 在 buffer 未完全初始化时可能抛出
 * TypeError（如 "Cannot read properties of undefined (reading 'dimensions')"）。
 * 此函数捕获该特定错误并静默忽略，其他异常则继续抛出。
 *
 * @param fn - 滚动函数，如 () => terminal.scrollToLine(10)
 */
function safeScrollCall(fn: () => void): void {
  try {
    fn()
  } catch (error) {
    // 仅当 error 是 TypeError 且消息包含 'dimensions' 时静默忽略
    // （xterm buffer 未完全初始化时的预期异常）。
    // 非 TypeError、非 'dimensions' 错误、或非标准异常值（如 undefined）都继续抛出。
    if (error instanceof TypeError && /dimensions/.test(error.message)) {
      return
    }
    throw error
  }
}