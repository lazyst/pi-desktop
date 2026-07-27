/**
 * xterm write 完成回调的异常守卫。
 *
 * ## 为什么需要这个守卫
 *
 * xterm 的 WriteBuffer._innerWrite 在调用 write 完成回调时没有 try/catch；
 * 一旦某个回调同步 throw，会跳过循环尾部的重新调度逻辑，导致 WriteBuffer 不再处理
 * 后续写入。又因为 write() 仅在缓冲区清空时才会重新触发处理，一个挂起的缓冲区
 * 永远不会再被清空——因此一个逃逸的 throw 会永久冻结终端面板：输出停止渲染，
 * 待处理的 replay guard 永远不会释放，面板在 shell 仍存活的情况下静默吞噬每一次按键。
 *
 * @see xterm-write-buffer-stall.repro 中的断言（对应 vendored xterm 6.1.0-beta.287）
 */

/** 每个上下文最多报告的异常次数，防止 throw-per-write 循环无限刷日志。 */
const MAX_REPORTS_PER_CONTEXT = 5

/** 各上下文已报告的异常计数映射。 */
const reportCountsByContext = new Map<string, number>()

/**
 * 安全执行 write 完成回调中的一步，防止同步 throw 逃逸到 xterm 的 WriteBuffer。
 *
 * 各步骤独立守卫，这样前一步的失败（例如视口稳定期间的 WebGL 刷新异常）不会影响
 * 后续步骤（例如 replay-guard 释放）的执行。
 *
 * @param context 步骤的上下文描述，用于异常报告标识
 * @param step    要执行的步骤函数
 */
export function runGuardedWriteCompletionStep(context: string, step: () => void): void {
  try {
    step()
  } catch (error: unknown) {
    const reported = reportCountsByContext.get(context) ?? 0
    if (reported >= MAX_REPORTS_PER_CONTEXT) {
      return
    }
    reportCountsByContext.set(context, reported + 1)
    console.error(`[terminal] write-completion step "${context}" threw`, error)
  }
}

/** 清空各上下文报告计数（仅用于测试）。 */
export function _resetWriteCompletionReportsForTests(): void {
  reportCountsByContext.clear()
}
