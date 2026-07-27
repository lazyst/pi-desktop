import type { IDisposable, Terminal } from '@xterm/xterm'
import {
  isTerminalLinkifierHoverActive,
  resetTerminalLinkifierHoverState
} from './linkifier-hover-reset'

// 为什么需要：将流式输出的突发合并为每个窗口最多一次悬停缓存重置，
// 这样持续的 agent 输出不会在每个解析的块上强制 provider 重新查询。
// 150ms 使刚打印的链接在用户下次指针移动时响应，而不会产生可测量的抖动。
const HOVER_RESET_THROTTLE_MS = 150

/**
 * 在流式输出落地后不久使 xterm 的 linkifier 悬停缓存失效。
 *
 * 为什么需要：xterm 仅在鼠标移动时悬停的缓冲区单元格发生变化时才重新运行 link providers，
 * 并且它会缓存每行的 provider 响应，没有内容更改失效
 * （{@link resetTerminalLinkifierHoverState} 记录了这些字段）。
 * 因此，agent 流式输出到可见面板中，在静止指针下方的 URL 永远不会被加下划线——
 * 并且其原生激活保持无效——直到指针跨到不同的行，
 * 这就是"在链接起作用之前点击终端几次"的症状。
 * 当新内容落地时清除单元格/行缓存，让下一次指针移动重新链接新的 URL。
 *
 * 与可见性恢复重置（参见 terminal-visibility-resume.ts）是同类，
 * 后者仅覆盖显示——而不是输出流式输出到已可见的面板。
 */
export function installTerminalLinkifierHoverResetOnWrite(terminal: Terminal): IDisposable {
  // 为什么需要：绝不让此操作破坏面板创建，如果 Terminal 桩或未来的
  // xterm 构建缺少 onWriteParsed——链接会在下次单元格更改时恢复，
  // 就像此重置存在之前一样。
  if (typeof terminal.onWriteParsed !== 'function') {
    return { dispose: () => undefined }
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    // 为什么需要：绝不在用户悬停链接时使缓存失效——
    // 它会清除+重新查询活动链接（异步用于文件路径），
    // 导致其下划线/工具提示闪烁。重新安排而不是丢弃挂起的重置：
    // 如果这是突发中的最后一个块，并且在悬停的行上追加了一个链接，
    // 丢弃重置会使该链接保持无效直到行更改。
    // 重试会在悬停结束后执行重置。（timer 在重试期间保持非 null，
    // 因此并发写入不会堆叠第二个定时器。）
    if (isTerminalLinkifierHoverActive(terminal)) {
      timer = setTimeout(flush, HOVER_RESET_THROTTLE_MS)
      return
    }
    timer = null
    resetTerminalLinkifierHoverState(terminal)
  }
  const scheduleReset = (): void => {
    if (timer !== null) {
      return
    }
    timer = setTimeout(flush, HOVER_RESET_THROTTLE_MS)
  }
  const writeParsedDisposable = terminal.onWriteParsed(scheduleReset)
  return {
    dispose: () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      writeParsedDisposable.dispose()
    }
  }
}