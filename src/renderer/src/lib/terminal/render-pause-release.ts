/**
 * 强制穿透 xterm RenderService 暂停状态的渲染刷新函数。
 *
 * 问题：tab 切换后，终端所在的 DOM 已可见，但 xterm 内部的 IntersectionObserver
 * 回调可能滞后一帧（负载高时更严重），导致 RenderService._isPaused === true。
 * 暂停期间 refreshRows 直接 early-return，仅记录 _needsFullRefresh 标记，
 * 因此切换后的 terminal.refresh() 被吞掉——渲染模型已清空但 canvas 未重绘，
 * 用户看到的是旧帧（典型症状：底部行缺失，直到拖选才恢复）。
 *
 * 方案：不等 observer 自然恢复，直接清除暂停标记并驱动一次同步全屏渲染。
 * observer 下次回调时会自然恢复权威状态。
 *
 * 所有访问都通过 typeof 守卫：xterm 升级改名这些内部属性时降级为 no-op，
 * 不会在渲染帧中抛出异常。
 */

type MaybePausableRenderService = {
  _isPaused?: boolean
  _needsFullRefresh?: boolean
  refreshRows?: (start: number, end: number, sync?: boolean) => void
}

type PausableRenderService = MaybePausableRenderService & {
  refreshRows: (start: number, end: number, sync?: boolean) => void
}

type TerminalWithRenderService = {
  rows?: number
  _core?: {
    _renderService?: MaybePausableRenderService
  }
}

function getRenderService(terminal: unknown): PausableRenderService | null {
  const service = (terminal as TerminalWithRenderService | null)?._core?._renderService
  return service && typeof service.refreshRows === 'function'
    ? (service as PausableRenderService)
    : null
}

/**
 * 如果 xterm 渲染器处于暂停状态（observer 尚未赶上切回时机），
 * 清除暂停标记并强制同步全屏重绘。
 *
 * @param terminal - xterm Terminal 实例
 * @returns 是否驱动了渲染；false 表示未暂停或内部结构不可用，调用方应回退到正常 terminal.refresh()
 */
export function forceRepaintThroughRenderPause(terminal: unknown): boolean {
  const service = getRenderService(terminal)
  if (!service || service._isPaused !== true) {
    return false
  }

  const rows = (terminal as TerminalWithRenderService).rows
  if (typeof rows !== 'number' || rows < 1) {
    return false
  }

  // 清除暂停标记和待刷新标记——我们即将执行一次完整刷新，
  // observer 下次回调时不应再触发冗余的全屏重绘。
  service._isPaused = false
  service._needsFullRefresh = false
  try {
    service.refreshRows(0, rows - 1, true)
    return true
  } catch {
    return false
  }
}