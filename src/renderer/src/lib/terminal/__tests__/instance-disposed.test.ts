// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { isXtermInstanceDisposed } from '../instance-disposed'

describe('isXtermInstanceDisposed', () => {
  it('tracks dispose on the real vendored xterm build', () => {
    // 钉住 vendored 构建是故意的：如果 xterm 升级移动了私有字段，
    // 本测试必须大声失败——探针静默返回 false 会让僵尸 pane 的埋点失明。
    const terminal = new Terminal({ allowProposedApi: true })
    expect(isXtermInstanceDisposed(terminal)).toBe(false)
    terminal.dispose()
    expect(isXtermInstanceDisposed(terminal)).toBe(true)
  })

  it('answers false for non-terminal shapes', () => {
    expect(isXtermInstanceDisposed(null)).toBe(false)
    expect(isXtermInstanceDisposed(undefined)).toBe(false)
    expect(isXtermInstanceDisposed({})).toBe(false)
  })
})