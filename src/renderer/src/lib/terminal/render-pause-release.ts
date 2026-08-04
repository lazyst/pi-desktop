/**
 * 强制穿透 xterm RenderService 暂停状态。
 *
 * 问题：tab 切换后，终端所在的 DOM 已可见，但 xterm 内部的 IntersectionObserver
 * 回调可能滞后一帧（负载高时更严重），导致 RenderService._isPaused === true。
 * 暂停期间 refreshRows 直接 early-return，仅记录 _needsFullRefresh 标记，
 * 因此切换后的 terminal.refresh() 被吞掉——渲染模型已清空但 canvas 未重绘，
 * 用户看到的是旧帧（典型症状：底部行缺失，直到拖选才恢复）。
 *
 * 本函数仅清除暂停标记，不执行刷新。刷新由调用方通过 terminal.refresh() + 双 rAF settle 完成。
 * 这避免了同步 refreshRows(0, rows-1, true) 导致的同帧全屏闪烁。
 *
 * 所有访问都通过 typeof 守卫：xterm 升级改名这些内部属性时降级为 no-op，
 * 不会在渲染帧中抛出异常。
 */

type MaybePausableRenderService = {
  _isPaused?: boolean
  _needsFullRefresh?: boolean
}

type TerminalWithRenderService = {
  _core?: {
    _renderService?: MaybePausableRenderService
  }
}

type RenderServiceGuard = { _isPaused?: boolean; _needsFullRefresh?: boolean }

function getRenderService(terminal: unknown): RenderServiceGuard | null {
  const service = (terminal as TerminalWithRenderService | null)?._core?._renderService
  return service || null
}

/**
 * 如果 xterm 渲染器处于暂停状态，清除暂停标记，使下一次 terminal.refresh() 生效。
 * 不执行同步刷新——刷新由调用方通过正常的 terminal.refresh() + 双 rAF settle 完成。
 *
 * @param terminal - xterm Terminal 实例
 * @returns 是否清除了暂停状态；false 表示未暂停或内部结构不可用
 */
export function forceRepaintThroughRenderPause(terminal: unknown): boolean {
  const service = getRenderService(terminal)
  if (!service || service._isPaused !== true) {
    return false
  }

  // 清除暂停标记和待刷新标记——下一次 refresh() 调用时
  // RenderService 不再 early-return，正常执行渲染。
  service._isPaused = false
  service._needsFullRefresh = false
  return true
}