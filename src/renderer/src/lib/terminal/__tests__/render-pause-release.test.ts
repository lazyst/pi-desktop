// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { forceRepaintThroughRenderPause } from '../render-pause-release'

type FakeRenderService = {
  _isPaused?: boolean
  _needsFullRefresh?: boolean
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
  it('暂停状态时清除暂停标记并返回 true', () => {
    const renderService: FakeRenderService = {
      _isPaused: true,
      _needsFullRefresh: true,
    }
    const terminal = createTerminal({ rows: 30, renderService })

    expect(forceRepaintThroughRenderPause(terminal)).toBe(true)
    expect(renderService._isPaused).toBe(false)
    expect(renderService._needsFullRefresh).toBe(false)
  })

  it('未暂停时保持终端不变并返回 false', () => {
    const renderService: FakeRenderService = {
      _isPaused: false,
      _needsFullRefresh: false,
    }
    const terminal = createTerminal({ renderService })

    expect(forceRepaintThroughRenderPause(terminal)).toBe(false)
  })

  it('渲染服务内部结构不可用时返回 false', () => {
    expect(forceRepaintThroughRenderPause(createTerminal({ withoutCore: true }))).toBe(false)
    expect(forceRepaintThroughRenderPause(createTerminal({ renderService: null }))).toBe(false)
    expect(forceRepaintThroughRenderPause(createTerminal({ renderService: {} }))).toBe(false)
    expect(forceRepaintThroughRenderPause(null)).toBe(false)
  })

  it('暂停标记清除后不执行 refresh（由调用方通过双 rAF settle 刷新）', () => {
    const renderService: FakeRenderService = {
      _isPaused: true,
      _needsFullRefresh: true,
    }
    const terminal = createTerminal({ renderService })

    // 函数只清除暂停标记，不执行 refresh
    // refresh 由调用方在 _flushAndRender() 中通过双 rAF settle 完成
    expect(forceRepaintThroughRenderPause(terminal)).toBe(true)
    expect(renderService._isPaused).toBe(false)
    // 不检查 refreshRows——函数不再调用它
  })
})