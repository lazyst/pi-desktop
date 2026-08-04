/**
 * stable-fit —— 稳定网格 fit 算法
 *
 * 移植自 Orca 的 pane-fit-resize-observer.ts。
 *
 * ## 为什么需要
 *
 * Windows 侧边栏锚点/滚动条在开/关时可能报告短时"一列抖动"（proposed dimensions
 * 在 1 列之间来回跳变）。如果每次跳变都触发 fit → PTY resize → SIGWINCH，
 * 会导致 Codex 收到快速 SIGWINCH 循环，终端内容明显振动。
 *
 * ## 实现
 *
 * 连续两帧提议尺寸一致时才执行 fit（稳定网格检测）。最多等待 8 帧，超时后强制 fit。
 * 已有 grid 匹配提议尺寸时立即跳过，不触发任何操作。
 */

import type { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

/** 稳定网格检测的最大等待帧数。超过此帧数后即使尺寸不稳定也强制 fit。 */
const MAX_STABILITY_FRAMES = 8

/** 进行中的稳定 fit 请求。 */
const pendingStableFitFrames = new Map<Terminal, { frameCount: number; previous: ProposedDimensions | null; rafId: number }>()

/** 提议尺寸。 */
type ProposedDimensions = {
  cols: number
  rows: number
}

/**
 * 获取 xterm 的提议尺寸（通过 FitAddon）。
 * 当终端或 fit 未就绪时返回 null。
 */
function getProposedDimensions(terminal: Terminal, fitAddon: FitAddon): ProposedDimensions | null {
  try {
    const dims = fitAddon.proposeDimensions()
    if (!dims) return null
    // 零尺寸守卫：Chromium 布局未就绪时返回 2×1 最小值
    if (dims.cols <= 2 && dims.rows <= 1) return null
    return { cols: dims.cols, rows: dims.rows }
  } catch {
    return null
  }
}

/**
 * 比较两个提议尺寸是否相等。
 */
function dimensionsEqual(a: ProposedDimensions | null, b: ProposedDimensions | null): boolean {
  return a?.cols === b?.cols && a?.rows === b?.rows
}

/**
 * 检查终端当前 grid 是否与提议尺寸一致。
 */
function terminalGridMatches(terminal: Terminal, dims: ProposedDimensions): boolean {
  return terminal.cols === dims.cols && terminal.rows === dims.rows
}

/**
 * 请求一次稳定网格 fit。
 *
 * 不会立即执行 fit，而是启动 rAF 循环检测提议尺寸是否稳定。
 * 当连续两帧提议尺寸一致（或超时）时，执行 callback。
 *
 * @param terminal - xterm Terminal 实例
 * @param fitAddon - FitAddon 实例
 * @param callback - 稳定后执行的回调（通常为 fit + resize）
 * @returns 取消函数
 */
export function requestStableFit(
  terminal: Terminal,
  fitAddon: FitAddon,
  callback: (cols: number, rows: number) => void,
): () => void {
  // 取消之前的 pending 请求
  cancelStableFit(terminal)

  const previous = getProposedDimensions(terminal, fitAddon)
  if (!previous) {
    // 无法获取尺寸，直接执行回调
    callback(terminal.cols, terminal.rows)
    return () => { /* no-op */ }
  }

  // 如果 grid 已匹配，直接跳过
  if (terminalGridMatches(terminal, previous)) {
    return () => { /* no-op */ }
  }

  let frameCount = 0
  let lastProposed = previous

  const waitForStableGrid = (): void => {
    const rafId = requestAnimationFrame(() => {
      const next = getProposedDimensions(terminal, fitAddon)
      frameCount += 1

      if (!next) {
        // 无法获取尺寸，强制 fit
        callback(lastProposed.cols, lastProposed.rows)
        pendingStableFitFrames.delete(terminal)
        return
      }

      // 如果 grid 已匹配提议尺寸，跳过
      if (terminalGridMatches(terminal, next)) {
        pendingStableFitFrames.delete(terminal)
        return
      }

      // 连续两帧一致或超时 → 执行 fit
      if (dimensionsEqual(lastProposed, next) || frameCount >= MAX_STABILITY_FRAMES) {
        callback(next.cols, next.rows)
        pendingStableFitFrames.delete(terminal)
        return
      }

      // 尺寸仍在变化，继续等待
      lastProposed = next
      pendingStableFitFrames.set(terminal, { frameCount, previous: lastProposed, rafId: 0 })
      waitForStableGrid()
    })

    const entry = pendingStableFitFrames.get(terminal)
    if (entry) {
      entry.rafId = rafId
    } else {
      pendingStableFitFrames.set(terminal, { frameCount, previous: lastProposed, rafId })
    }
  }

  waitForStableGrid()

  return () => cancelStableFit(terminal)
}

/**
 * 取消指定终端的稳定 fit 请求。
 */
export function cancelStableFit(terminal: Terminal): void {
  const entry = pendingStableFitFrames.get(terminal)
  if (entry) {
    cancelAnimationFrame(entry.rafId)
    pendingStableFitFrames.delete(terminal)
  }
}

/**
 * 取消所有终端的稳定 fit 请求。
 */
export function cancelAllStableFits(): void {
  for (const [terminal, entry] of pendingStableFitFrames) {
    cancelAnimationFrame(entry.rafId)
  }
  pendingStableFitFrames.clear()
}