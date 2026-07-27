/**
 * WebGL 自动策略模块
 *
 * 根据运行环境自动判断是否启用 xterm.js 的 WebGL 渲染器。
 * 支持三种方式：auto（自动判断）、on（强制开启）、off（强制关闭）。
 *
 * 本模块专注于 auto 策略的决策逻辑：
 *  - 非 Linux 系统 → 允许 WebGL（无需检测渲染器）
 *  - Linux Wayland  → 禁用 WebGL（xterm #5319 问题，当前项目无 Wayland API 暂不生效）
 *  - Linux + WebGL2 不可用 → 禁用
 *  - Linux + 渲染器信息不可获取 → 禁用（无法区分硬件/软件渲染）
 *  - Linux + 软件渲染器（llvmpipe/swiftshader 等）→ 禁用
 *  - Linux + 硬件渲染器 → 允许
 */

export type TerminalWebglAutoDecision = {
  allowWebgl: boolean
  reason:
    | 'non-linux'
    | 'linux-wayland'
    | 'linux-hardware-renderer'
    | 'linux-webgl2-unavailable'
    | 'linux-renderer-unavailable'
    | 'linux-software-renderer'
  renderer: string | null
  vendor: string | null
}

let cachedDecision: TerminalWebglAutoDecision | null = null

/** Linux 软件渲染器识别模式（不区分大小写） */
const LINUX_SOFTWARE_RENDERER_PATTERN =
  /\b(swiftshader|llvmpipe|softpipe|software rasterizer|software adapter|basic render|virgl|svga3d)\b/i

/** 重置缓存，下次调用 `getTerminalWebglAutoDecision` 将重新检测 */
export function resetTerminalWebglAutoDecision(): void {
  cachedDecision = null
}

/**
 * 判断当前环境是否为 Linux 主机。
 * 通过 navigator.platform 或 navigator.userAgent 中的 "Linux" 标识判断。
 * Node.js 环境返回 false。
 */
export function isLinuxRendererHost(
  platform: string = typeof navigator === 'undefined' ? '' : navigator.platform,
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent
): boolean {
  if (userAgent.startsWith('Node.js/')) {
    return false
  }
  return platform.includes('Linux') || userAgent.includes('Linux')
}

/**
 * 读取当前显示服务器类型。
 *
 * 当前项目无 `window.api.platform.get()` 可用，始终返回 null。
 * 保留此函数以便未来接入系统 API 时无需修改决策逻辑。
 */
function readRendererDisplayServer(): 'wayland' | 'x11' | null {
  return null
}

/**
 * 通过 Canvas WebGL2 上下文读取渲染器信息。
 *
 * 纯浏览器 API，不依赖任何 Electron IPC 或系统调用。
 * 返回：
 *  - hasWebgl2: 浏览器是否支持 WebGL2
 *  - hasRendererInfo: 是否能获取到 UNMASKED_RENDERER/WEBGL_VENDOR
 *  - renderer: 渲染器字符串（如 "Mesa Intel(R) UHD Graphics 770"）
 *  - vendor: 供应商字符串（如 "Intel"）
 */
function readWebglRendererInfo(): Pick<TerminalWebglAutoDecision, 'renderer' | 'vendor'> & {
  hasWebgl2: boolean
  hasRendererInfo: boolean
} {
  if (typeof document === 'undefined') {
    return { hasWebgl2: false, hasRendererInfo: false, renderer: null, vendor: null }
  }

  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2')
    if (!gl) {
      return { hasWebgl2: false, hasRendererInfo: false, renderer: null, vendor: null }
    }

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
    if (!debugInfo) {
      return { hasWebgl2: true, hasRendererInfo: false, renderer: null, vendor: null }
    }

    const renderer = String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? '')
    const vendor = String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) ?? '')
    return {
      hasWebgl2: true,
      hasRendererInfo: renderer.length > 0 || vendor.length > 0,
      renderer: renderer || null,
      vendor: vendor || null
    }
  } catch {
    return { hasWebgl2: false, hasRendererInfo: false, renderer: null, vendor: null }
  }
}

/**
 * 获取终端 WebGL 自动决策结果。
 *
 * 决策流程（按优先级）：
 *  1. 非 Linux → 允许（不检测渲染器，safe 路径）
 *  2. Linux Wayland → 禁用（xterm #5319 终端输入卡死，当前项目暂不生效）
 *  3. Linux + 无 WebGL2 → 禁用
 *  4. Linux + 无渲染器身份 → 禁用（无法区分硬件/软件）
 *  5. Linux + 软件渲染器 → 禁用
 *  6. Linux + 硬件渲染器 → 允许
 *
 * 结果会被缓存，调用 `resetTerminalWebglAutoDecision` 可清除缓存。
 */
export function getTerminalWebglAutoDecision(): TerminalWebglAutoDecision {
  if (cachedDecision) {
    return cachedDecision
  }

  if (!isLinuxRendererHost()) {
    cachedDecision = {
      allowWebgl: true,
      reason: 'non-linux',
      renderer: null,
      vendor: null
    }
    return cachedDecision
  }

  if (readRendererDisplayServer() === 'wayland') {
    // 原因：#5319 在 Linux Wayland 上创建 xterm WebGL 上下文时可能会导致终端输入卡死，
    // 且 xterm 不会报告可恢复的上下文丢失事件。
    cachedDecision = {
      allowWebgl: false,
      reason: 'linux-wayland',
      renderer: null,
      vendor: null
    }
    return cachedDecision
  }

  const rendererInfo = readWebglRendererInfo()
  if (!rendererInfo.hasWebgl2) {
    cachedDecision = {
      allowWebgl: false,
      reason: 'linux-webgl2-unavailable',
      renderer: rendererInfo.renderer,
      vendor: rendererInfo.vendor
    }
    return cachedDecision
  }

  if (!rendererInfo.hasRendererInfo) {
    // 原因：Linux 上的渲染损坏路径可能 WebGL 仍存活但字形已损坏；
    // 没有渲染器身份就无法区分硬件渲染和软件渲染。
    cachedDecision = {
      allowWebgl: false,
      reason: 'linux-renderer-unavailable',
      renderer: rendererInfo.renderer,
      vendor: rendererInfo.vendor
    }
    return cachedDecision
  }

  const identity = `${rendererInfo.vendor ?? ''} ${rendererInfo.renderer ?? ''}`
  if (LINUX_SOFTWARE_RENDERER_PATTERN.test(identity)) {
    cachedDecision = {
      allowWebgl: false,
      reason: 'linux-software-renderer',
      renderer: rendererInfo.renderer,
      vendor: rendererInfo.vendor
    }
    return cachedDecision
  }

  cachedDecision = {
    allowWebgl: true,
    reason: 'linux-hardware-renderer',
    renderer: rendererInfo.renderer,
    vendor: rendererInfo.vendor
  }
  return cachedDecision
}