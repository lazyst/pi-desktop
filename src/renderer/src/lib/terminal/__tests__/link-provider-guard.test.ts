// @vitest-environment jsdom

import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  guardLinkProvider,
  installGuardedLinkProviderRegistration
} from '../link-provider-guard'

function collectLinks(provider: ILinkProvider, bufferLineNumber = 1): ILink[] | undefined {
  let result: ILink[] | undefined
  let called = false
  provider.provideLinks(bufferLineNumber, (links) => {
    called = true
    result = links
  })
  expect(called).toBe(true)
  return result
}

describe('guardLinkProvider', () => {
  it('捕获同步 throw 不使其逃逸，返回 undefined 并报告 console.error', () => {
    // 模拟 xterm web-links 的 RangeError —— LinkComputer._getWindowedLineStrings
    // 在病态回绕行上分配了无效长度的数组。
    const provider: ILinkProvider = {
      provideLinks: () => {
        throw new RangeError('Invalid array length')
      }
    }
    const guarded = guardLinkProvider(provider, 'web-links')

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => collectLinks(guarded)).not.toThrow()
      expect(collectLinks(guarded)).toBeUndefined()
      expect(errorSpy).toHaveBeenCalledWith(
        '[terminal] link provider "web-links" threw at bufferLineNumber 1:',
        expect.any(RangeError)
      )
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('provider 正常返回时透传链接，不报异常', () => {
    const links = [{ text: 'term_abc' }] as unknown as ILink[]
    const provider: ILinkProvider = {
      provideLinks: (_lineNumber, callback) => callback(links)
    }
    const guarded = guardLinkProvider(provider, 'orca-handle')

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(collectLinks(guarded)).toBe(links)
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('provider 先回调再 throw 时不会重复调用 callback', () => {
    const links = [{ text: 'file.ts' }] as unknown as ILink[]
    const provider: ILinkProvider = {
      provideLinks: (_lineNumber, callback) => {
        callback(links)
        throw new RangeError('Invalid array length')
      }
    }
    const guarded = guardLinkProvider(provider, 'orca-file')

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const callback = vi.fn()
      expect(() => guarded.provideLinks(1, callback)).not.toThrow()
      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback).toHaveBeenCalledWith(links)
      expect(errorSpy).toHaveBeenCalledOnce()
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('installGuardedLinkProviderRegistration', () => {
  it('修补后所有注册的 provider 都被守卫（包括 addon 内部注册）', () => {
    const registered: ILinkProvider[] = []
    const terminal = {
      registerLinkProvider: (provider: ILinkProvider) => {
        registered.push(provider)
        return { dispose: vi.fn() }
      }
    } as unknown as Terminal

    installGuardedLinkProviderRegistration(terminal)

    // 模拟 web-links addon 通过 loadAddon -> registerLinkProvider 注册 provider
    terminal.registerLinkProvider({
      provideLinks: () => {
        throw new RangeError('Invalid array length')
      }
    })

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(registered).toHaveLength(1)
      expect(() => collectLinks(registered[0])).not.toThrow()
      expect(collectLinks(registered[0])).toBeUndefined()
      expect(errorSpy).toHaveBeenCalledWith(
        '[terminal] link provider "provider-1" threw at bufferLineNumber 1:',
        expect.any(RangeError)
      )
    } finally {
      errorSpy.mockRestore()
    }
  })
})