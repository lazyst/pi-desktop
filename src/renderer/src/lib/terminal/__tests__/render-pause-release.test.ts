// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { forceRepaintThroughRenderPause } from '../render-pause-release'

type FakeRenderService = {
  _isPaused?: boolean
  _needsFullRefresh?: boolean
  refreshRows?: ReturnType<typeof vi.fn>
}

function createTerminal(options: {
  rows?: number
  renderService?: FakeRenderService | null
  withoutCore?: boolean
}): unknown {
  const { rows = 24, renderService, withoutCore } = options
  if (withoutCore) {
    return { rows }
  }
  return {
    rows,
    _core: { _renderService: renderService ?? null },
  }
}

describe('forceRepaintThroughRenderPause', () => {
  it('暂停状态时驱动同步全屏渲染并清除暂停标记', () => {
    const refreshRows = vi.fn()
    const renderService: FakeRenderService = {
      _isPaused: true,
      _needsFullRefresh: true,
      refreshRows,
    }
    const terminal = createTerminal({ rows: 30, renderService })

    expect(forceRepaintThroughRenderPause(terminal)).toBe(true)
    expect(refreshRows).toHaveBeenCalledWith(0, 29, true)
    expect(renderService._isPaused).toBe(false)
    expect(renderService._needsFullRefresh).toBe(false)
  })

  it('未暂停时保持终端不变并返回 false', () => {
    const refreshRows = vi.fn()
    const renderService: FakeRenderService = {
      _isPaused: false,
      _needsFullRefresh: false,
      refreshRows,
    }
    const terminal = createTerminal({ renderService })

    expect(forceRepaintThroughRenderPause(terminal)).toBe(false)
    expect(refreshRows).not.toHaveBeenCalled()
  })

  it('渲染服务内部结构不可用时返回 false', () => {
    expect(forceRepaintThroughRenderPause(createTerminal({ withoutCore: true }))).toBe(false)
    expect(forceRepaintThroughRenderPause(createTerminal({ renderService: null }))).toBe(false)
    expect(forceRepaintThroughRenderPause(createTerminal({ renderService: {} }))).toBe(false)
    expect(forceRepaintThroughRenderPause(null)).toBe(false)
  })

  it('行数无效时不渲染并返回 false', () => {
    const refreshRows = vi.fn()
    const terminal = createTerminal({
      rows: 0,
      renderService: { _isPaused: true, refreshRows },
    })

    expect(forceRepaintThroughRenderPause(terminal)).toBe(false)
    expect(refreshRows).not.toHaveBeenCalled()
  })

  it('强制渲染抛出异常时返回 false（终端已销毁）', () => {
    const renderService: FakeRenderService = {
      _isPaused: true,
      _needsFullRefresh: true,
      refreshRows: vi.fn(() => {
        throw new Error('terminal disposed')
      }),
    }
    const terminal = createTerminal({ renderService })

    expect(forceRepaintThroughRenderPause(terminal)).toBe(false)
    // 标记仍被清除——observer 下次回调会自然恢复权威状态，
    // 不能留下一个半服务的 full-refresh 标记。
    expect(renderService._isPaused).toBe(false)
  })
})
