/**
 * xterm 写管道健康监控模块。
 *
 * ## 为什么需要这个模块
 *
 * 面板的 xterm 写管道可能在其 PTY 仍存活的情况下死亡——同步 throw 从无守卫的写回调中逃逸会
 * 楔住 WriteBuffer（issue #2836），而对已销毁的终端调用 write() 会静默丢弃其完成回调
 * （已在 vendored xterm 6.1.0-beta.287 中确认）。这两种状态下，后续的所有写入都会无限排队：
 * 输出停止渲染、回执信贷泄漏，面板变成用户只能通过重载窗口才能恢复的化石。
 *
 * 本模块通过 probe 探查来认定死锁（与 replay-guard.ts 类似）：某个写入的完成回调超时未触发，
 * 则发起一次空内容 probe 写入；xterm 按 FIFO 顺序解析，因此如果 probe 也从未完成，就证明
 * 管道已死而非缓慢。认证后通知已注册的每终端处理器（由面板的 PTY 连接注册），
 * 请求面板恢复——即重建 xterm 并重新挂载存活 PTY。
 */

import { runGuardedWriteCompletionStep } from './write-callback-guard'

type WriteTarget = {
  write(data: string, callback?: () => void): void
}

export type UndeliverableWriteReason = 'write-stalled' | 'replay-wedged'

type UndeliverableWriteHandler = (reason: UndeliverableWriteReason) => void

const handlersByTerminal = new WeakMap<object, UndeliverableWriteHandler>()
const certifiedDeadTerminals = new WeakSet<object>()
// 为什么用 generation：楔住判定必须区分"已死"与"活着但落后"。generation 避免同一毫秒的
// 漏判和时钟调整，同时保持完成回调热路径为常数时间且限定在终端作用域内。
const parseProgressGenerationByTerminal = new WeakMap<object, number>()

/** 报告此终端有一次写入解析完成。 */
export function recordTerminalParseProgress(terminal: object): void {
  const nextGeneration = (parseProgressGenerationByTerminal.get(terminal) ?? 0) + 1
  parseProgressGenerationByTerminal.set(terminal, nextGeneration)
}

/** 捕获当前解析进度代数，用于后续的静默窗口检查。 */
export function captureTerminalParseProgressGeneration(terminal: object): number {
  return parseProgressGenerationByTerminal.get(terminal) ?? 0
}

/** 自 `generation` 被捕获以来，是否有写入回调完成并解析。 */
export function hasTerminalParseProgressSince(terminal: object, generation: number): boolean {
  return captureTerminalParseProgressGeneration(terminal) !== generation
}

type StallWatch = {
  timer: ReturnType<typeof setTimeout>
  onCertifiedDead?: () => void
}

const stallWatchByTerminal = new WeakMap<object, StallWatch>()

export const WRITE_PIPELINE_STALL_CHECK_MS = 10_000

function certifyTerminalWritePipelineDead(terminal: object, expectedWatch?: StallWatch): void {
  const watch = stallWatchByTerminal.get(terminal)
  // 为什么需要 expectedWatch：真实的解析可能在过期的 probe 截止前就已解决并移除 watch。
  // 只有发起该截止时间的 watch 才有权认证。
  if (expectedWatch && watch !== expectedWatch) {
    return
  }
  if (watch) {
    stallWatchByTerminal.delete(terminal)
    try {
      watch.onCertifiedDead?.()
    } catch {
      // 什么也不做：清理过程可能触及部分 window.api 接口；恢复通知在清理失败后仍需执行。
    }
  }
  notifyUndeliverableWrite(terminal, 'write-stalled')
}

export function registerUndeliverableWriteHandler(
  terminal: object,
  handler: UndeliverableWriteHandler
): () => void {
  handlersByTerminal.set(terminal, handler)
  return () => {
    if (handlersByTerminal.get(terminal) === handler) {
      handlersByTerminal.delete(terminal)
    }
  }
}

/** 每个终端实例仅通知一次：恢复会替换 xterm，因此对同一对象的二次通知始终是重复的。 */
export function notifyUndeliverableWrite(terminal: object, reason: UndeliverableWriteReason): void {
  if (certifiedDeadTerminals.has(terminal)) {
    return
  }
  certifiedDeadTerminals.add(terminal)
  try {
    handlersByTerminal.get(terminal)?.(reason)
  } catch {
    // 什么也不做：notify 从定时器和写回调上下文中触发，抛出会变成未处理错误；
    // 恢复是按契约尽力而为的（参见 terminal-pane-recovery.ts）。
  }
}

export function isTerminalWritePipelineCertifiedDead(terminal: object): boolean {
  return certifiedDeadTerminals.has(terminal)
}

/**
 * 发起（或保持）终端的停滞监视器，用于刚执行了写入的终端。
 * 由 settleTerminalWriteStallWatch 从写入完成回调中清除。
 * 如果完成回调始终未到达，则发起一次空内容 probe 写入来认证死锁 vs 慢速（与
 * replay-guard.ts 相同）：probe 完成 → 管道存活（慢速解析），重新武装并继续等待；
 * probe 在又一间隔内静默 → 已死，通知。
 */
export function armTerminalWriteStallWatch(
  terminal: WriteTarget,
  options: { onCertifiedDead?: () => void; stallCheckMs?: number } = {}
): void {
  if (stallWatchByTerminal.has(terminal) || certifiedDeadTerminals.has(terminal)) {
    return
  }
  const stallCheckMs = options.stallCheckMs ?? WRITE_PIPELINE_STALL_CHECK_MS
  const watch: StallWatch = {
    onCertifiedDead: options.onCertifiedDead,
    timer: setTimeout(probeForStall, stallCheckMs)
  }
  const certifyDead = (): void => certifyTerminalWritePipelineDead(terminal, watch)
  function probeForStall(): void {
    if (stallWatchByTerminal.get(terminal) !== watch) {
      return
    }
    let probeParsed = false
    try {
      terminal.write('', () => {
        runGuardedWriteCompletionStep('write-pipeline-probe', () => {
          probeParsed = true
          // 为什么：replay guard 共享此终端作用域的 generation；即使是辅助 FIFO probe
          // 也足以证明解析器存活且正在推进。
          recordTerminalParseProgress(terminal)
          // 为什么：probe 被解析证明管道存活——之前停滞的写入只是慢速。
          // 解除监视；下一次写入会重新武装。
          const current = stallWatchByTerminal.get(terminal)
          if (current === watch) {
            clearTimeout(current.timer)
            stallWatchByTerminal.delete(terminal)
          }
        })
      })
    } catch {
      certifyDead()
      return
    }
    watch.timer = setTimeout(() => {
      if (!probeParsed) {
        certifyDead()
      }
    }, stallCheckMs)
  }
  stallWatchByTerminal.set(terminal, watch)
}

/** 取消待处理的监视器，不声明任何字节已解析。 */
export function cancelTerminalWriteStallWatch(terminal: object): void {
  const watch = stallWatchByTerminal.get(terminal)
  if (!watch) {
    return
  }
  clearTimeout(watch.timer)
  stallWatchByTerminal.delete(terminal)
}

/** 写入正常完成——管道健康；移除任何待处理的监视器。 */
export function settleTerminalWriteStallWatch(terminal: object): void {
  recordTerminalParseProgress(terminal)
  cancelTerminalWriteStallWatch(terminal)
}

/** 同步 terminal.write 失败证明管道无法接受已发出的写入。立即恢复，不报告虚假的解析进度。 */
export function failTerminalWriteStallWatch(terminal: object): void {
  certifyTerminalWritePipelineDead(terminal)
}

export function _resetWritePipelineHealthForTests(terminal?: object): void {
  if (terminal) {
    const watch = stallWatchByTerminal.get(terminal)
    if (watch) {
      clearTimeout(watch.timer)
    }
    stallWatchByTerminal.delete(terminal)
    handlersByTerminal.delete(terminal)
    certifiedDeadTerminals.delete(terminal)
    parseProgressGenerationByTerminal.delete(terminal)
  }
}