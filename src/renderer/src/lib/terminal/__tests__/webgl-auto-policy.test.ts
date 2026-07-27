// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getTerminalWebglAutoDecision,
  isLinuxRendererHost,
  resetTerminalWebglAutoDecision
} from '../webgl-auto-policy'

type MockWebglRendererInfo = {
  renderer?: string | null
  vendor?: string | null
  hasWebgl2?: boolean
  hasDebugInfo?: boolean
}

function stubNavigator(platform: string, userAgent: string): void {
  vi.stubGlobal('navigator', { platform, userAgent })
}

function stubWebglRendererInfo({
  renderer = 'Mesa Intel(R) Graphics',
  vendor = 'Intel',
  hasWebgl2 = true,
  hasDebugInfo = true
}: MockWebglRendererInfo): void {
  const rendererKey = 0x9246
  const vendorKey = 0x9245
  const gl = {
    getExtension: vi.fn(() =>
      hasDebugInfo
        ? {
            UNMASKED_RENDERER_WEBGL: rendererKey,
            UNMASKED_VENDOR_WEBGL: vendorKey
          }
        : null
    ),
    getParameter: vi.fn((key: number) => {
      if (key === rendererKey) {
        return renderer
      }
      if (key === vendorKey) {
        return vendor
      }
      return null
    })
  }

  vi.stubGlobal('document', {
    createElement: vi.fn((tagName: string) => {
      if (tagName === 'canvas') {
        return {
          getContext: vi.fn((contextName: string) =>
            hasWebgl2 && contextName === 'webgl2' ? gl : null
          )
        }
      }
      return {}
    })
  })
}

function stubNoDocument(): void {
  vi.stubGlobal('document', undefined)
}

describe('terminal WebGL 自动策略', () => {
  beforeEach(() => {
    resetTerminalWebglAutoDecision()
  })

  afterEach(() => {
    resetTerminalWebglAutoDecision()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  // ─── isLinuxRendererHost ───────────────────────────────────────

  it('从 platform 或 userAgent 中检测 Linux 主机', () => {
    expect(isLinuxRendererHost('Linux x86_64', 'Mozilla/5.0')).toBe(true)
    expect(isLinuxRendererHost('MacIntel', 'Mozilla/5.0 (X11; Linux x86_64)')).toBe(true)
    expect(isLinuxRendererHost('MacIntel', 'Mozilla/5.0 (Macintosh)')).toBe(false)
    expect(isLinuxRendererHost('Linux x86_64', 'Node.js/24')).toBe(false)
  })

  // ─── 非 Linux ──────────────────────────────────────────────────

  it('非 Linux 系统自动允许 WebGL，无需检测渲染器', () => {
    stubNavigator('MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    stubNoDocument()

    expect(getTerminalWebglAutoDecision()).toMatchObject({
      allowWebgl: true,
      reason: 'non-linux'
    })
  })

  // ─── Linux + 硬件渲染器 ────────────────────────────────────────

  it('Linux 可识别的硬件渲染器允许 WebGL', () => {
    stubNavigator('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64)')
    stubWebglRendererInfo({
      renderer: 'Mesa Intel(R) UHD Graphics 770 (ADL-S GT1)',
      vendor: 'Intel'
    })

    expect(getTerminalWebglAutoDecision()).toEqual({
      allowWebgl: true,
      reason: 'linux-hardware-renderer',
      renderer: 'Mesa Intel(R) UHD Graphics 770 (ADL-S GT1)',
      vendor: 'Intel'
    })
  })

  // ─── Linux + 无 WebGL2 ─────────────────────────────────────────

  it('Linux 无 WebGL2 时禁用 WebGL', () => {
    stubNavigator('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64)')
    stubWebglRendererInfo({ hasWebgl2: false })

    expect(getTerminalWebglAutoDecision()).toMatchObject({
      allowWebgl: false,
      reason: 'linux-webgl2-unavailable'
    })
  })

  // ─── Linux + 渲染器身份不可获取 ────────────────────────────────

  it('Linux 无法获取渲染器身份时禁用 WebGL', () => {
    stubNavigator('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64)')
    stubWebglRendererInfo({ hasDebugInfo: false })

    expect(getTerminalWebglAutoDecision()).toMatchObject({
      allowWebgl: false,
      reason: 'linux-renderer-unavailable'
    })
  })

  // ─── Linux + 软件渲染器 ────────────────────────────────────────

  it.each([
    ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))'],
    ['llvmpipe (LLVM 17.0.6, 256 bits)'],
    ['softpipe'],
    ['Mesa X11 Software Rasterizer'],
    ['SVGA3D; build: RELEASE; LLVM;']
  ])('Linux 软件渲染器 %s 禁用 WebGL', (renderer) => {
    stubNavigator('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64)')
    stubWebglRendererInfo({ renderer, vendor: 'Mesa/X.org' })

    expect(getTerminalWebglAutoDecision()).toMatchObject({
      allowWebgl: false,
      reason: 'linux-software-renderer',
      renderer
    })
  })

  // ─── 缓存行为 ───────────────────────────────────────────────────

  it('多次调用返回相同缓存结果', () => {
    stubNavigator('MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    stubNoDocument()

    const first = getTerminalWebglAutoDecision()
    const second = getTerminalWebglAutoDecision()
    expect(first).toBe(second)
  })

  it('resetTerminalWebglAutoDecision 清除缓存，下一次调用重新检测', () => {
    stubNavigator('MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    stubNoDocument()

    const first = getTerminalWebglAutoDecision()
    expect(first.reason).toBe('non-linux')

    // 清除缓存并切换为 Linux 环境
    resetTerminalWebglAutoDecision()
    stubNavigator('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64)')
    stubWebglRendererInfo({ hasWebgl2: false })

    const second = getTerminalWebglAutoDecision()
    expect(second.reason).toBe('linux-webgl2-unavailable')
  })
})