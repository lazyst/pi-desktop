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
 * ## 实现思路
 *
 * 执行一次「上滚一行 + 下滚一行」的微调（jiggle），在不改变实际视口位置
 * 的前提下，触发 xterm 内部重绘滚动条。如果已经在底部，则不做微调，因为
 * scrollToBottom 已正确放置滚动条滑块，此时 jiggle 会导致终端停止跟随
 * 活动输出。
 *
 * 移植自 orca 源码的 forceTerminalViewportScrollbarSync 模块。
 */

import type { Terminal } from '@xterm/xterm'

/**
 * 强制同步 xterm 的滚动条位置。
 *
 * 通过一行上滚 + 一行下滚（或反向）的微调，触发 xterm 内部滚动条重绘，
 * 而不改变实际显示内容。适用于 split-pane 调整尺寸后需要刷新滚动条的场景。
 *
 * @param terminal - xterm Terminal 实例
 */
export function forceTerminalViewportScrollbarSync(terminal: Terminal): void {
  const buf = terminal.buffer.active

  if (buf.viewportY >= buf.baseY) {
    // 已在底部：不做微调。scrollToBottom 已正确放置滚动条滑块，
    // 此时 jiggle 会导致终端停止跟随活动输出。
    return
  }

  if (buf.viewportY > 0) {
    // 向上滚动过：先上滚一行恢复原位，再下滚一行回到原位
    safeScrollCall(() => terminal.scrollLines(-1))
    safeScrollCall(() => terminal.scrollLines(1))
  } else if (buf.viewportY < buf.baseY) {
    // 视口在顶部且内容可滚动：先下滚一行再上滚一行
    safeScrollCall(() => terminal.scrollLines(1))
    safeScrollCall(() => terminal.scrollLines(-1))
  }
}

/**
 * 安全执行 xterm 滚动调用。
 *
 * xterm 的 scrollLines 在 buffer 未完全初始化时可能抛出
 * TypeError（如 "Cannot read properties of undefined (reading 'dimensions')"）。
 * 此函数捕获该特定错误并静默忽略，其他异常则继续抛出。
 *
 * @param fn - 滚动函数，如 () => terminal.scrollLines(-1)
 */
function safeScrollCall(fn: () => void): void {
  try {
    fn()
  } catch (error) {
    if (!(error instanceof TypeError) || !/dimensions/.test(error.message)) {
      throw error
    }
  }
}