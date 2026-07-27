import type { Terminal } from '@xterm/xterm'

type LinkifierHoverCache = {
  _lastBufferCell?: unknown
  _activeLine?: number
  // 当 xterm 正在显示悬停链接时设置；在 mouseleave / 指针移出链接时清除（Linkifier `_clearCurrentLink`）。
  _currentLink?: unknown
}

type TerminalCoreWithLinkifier = {
  _core?: {
    linkifier?: LinkifierHoverCache
  }
}

/**
 * 强制 xterm 的 linkifier 在下次 mousemove 时重新运行 link providers。
 *
 * 为什么需要：当终端隐藏（工作区/标签切换）时，浏览器会触发 `mouseleave`，
 * 它会清除 linkifier 的当前链接，但保留 `_lastBufferCell` 缓存。
 * 显示时指针通常回到同一单元格，因此 xterm 的 mousemove 处理程序会短路（位置未变），
 * 永远不会重新链接——链接（文件路径、URL、term_* 句柄、OSC-8）保持无效，
 * 直到滚动改变缓冲区位置。清除单元格/行缓存可使下一次 mousemove 重新评估 providers，
 * 从而无需滚动即可恢复链接及其悬停下划线。
 *
 * 深入 xterm 内部（`@xterm/xterm` 6.1.0-beta.287 `Linkifier`），
 * 因为没有公开 API 来使悬停缓存失效。通过守卫保护，如果未来 xterm 构建重命名这些字段，
 * 会降级为修复前行为（链接在下次真正的单元格更改时恢复），而不是抛出异常。
 */
export function resetTerminalLinkifierHoverState(terminal: Terminal): void {
  try {
    const linkifier = (terminal as unknown as TerminalCoreWithLinkifier)._core?.linkifier
    if (!linkifier) {
      return
    }
    if ('_lastBufferCell' in linkifier) {
      linkifier._lastBufferCell = undefined
    }
    if ('_activeLine' in linkifier) {
      linkifier._activeLine = -1
    }
  } catch {
    /* linkifier 内部不可用——链接在下次单元格更改时恢复 */
  }
}

/**
 * 检查终端是否正在显示悬停链接。
 *
 * 为什么需要：在定时器上使悬停缓存失效的调用方（流式输出）
 * 必须在链接被悬停时跳过——清除缓存会使下一次 mousemove 清除并
 * （对于异步 providers，如文件路径）重新查询活动链接，导致其下划线/工具提示闪烁。
 * 守卫方式与 {@link resetTerminalLinkifierHoverState} 类似，
 * 重命名字段会降级为"未悬停"而不是抛出异常。
 */
export function isTerminalLinkifierHoverActive(terminal: Terminal): boolean {
  try {
    const linkifier = (terminal as unknown as TerminalCoreWithLinkifier)._core?.linkifier
    return Boolean(linkifier && '_currentLink' in linkifier && linkifier._currentLink)
  } catch {
    return false
  }
}