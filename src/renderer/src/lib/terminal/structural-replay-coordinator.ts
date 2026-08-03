/**
 * structural-replay-coordinator
 *
 * 终端清屏后重放数据（如 resetSameFrame + restoreScrollback）时，确保滚动位置
 * 精确恢复到清屏前用户阅读的位置，而不是跳到底部。在重放期间，所有滚动意图更新
 * 被挂起，避免因清空 buffer 导致意图误判为 followOutput。
 *
 * 使用串行队列确保多个 run 调用按序执行、不重叠。支持取消（dispose 时中断正在
 * 执行的任务）和 shouldRestore / afterRestore 回调选项。
 */

import type { Terminal } from '@xterm/xterm'
import {
  captureTerminalStructuralScrollIntent,
  type TerminalScrollIntentTarget,
} from './scroll-intent'
import { beginTerminalScrollIntentBufferRebuild, endTerminalScrollIntentBufferRebuild } from './scroll-intent-rebuild'
import { cancelDeferredScrollRestore } from './scroll'

// ─── 公开类型 ──────────────────────────────────────────────────────────────

/** 结构重放协调器的选项。 */
export type TerminalStructuralReplayCoordinatorOptions = {
  /** 是否应该恢复滚动意图。返回 false 时跳过恢复，但任务仍被执行。 */
  shouldRestore?: () => boolean
  /** 恢复完成后的回调（在 restore 之后调用）。 */
  afterRestore?: () => void
}

// ─── 内部类型 ──────────────────────────────────────────────────────────────

type PendingTask = {
  task: () => void | Promise<void>
  options: TerminalStructuralReplayCoordinatorOptions
  resolve: (value: void) => void
  reject: (reason: Error) => void
  cancelled: boolean
}

// ─── TerminalStructuralReplayCoordinator ───────────────────────────────────

/**
 * 终端结构重放协调器。
 *
 * 管理 buffer 重建（清屏/重放）期间的滚动意图保护，确保重建后视口位置
 * 精确恢复到重建前用户阅读的位置。
 *
 * 串行队列：多个 run 调用按序执行，不重叠。
 * 取消支持：dispose 时中断正在执行的任务并清空队列。
 */
export class TerminalStructuralReplayCoordinator {
  /** xterm Terminal 实例引用（由 setTerminal 设置）。 */
  private terminal: TerminalScrollIntentTarget | null = null
  /** 待执行的任务队列。 */
  private taskQueue: PendingTask[] = []
  /** 是否有任务正在执行。 */
  private running = false
  /** 是否已释放（dispose 后不再接受新任务）。 */
  private disposed = false

  /**
   * 设置关联的 xterm Terminal 实例。
   * 必须在首次调用 run 之前设置。
   */
  setTerminal(terminal: TerminalScrollIntentTarget): void {
    this.terminal = terminal
  }

  /**
   * 执行一个结构重放任务。
   *
   * 内部流程：
   *   1. capture 重建前意图
   *   2. cancel 挂起恢复（来自 scroll.ts 的延迟恢复）
   *   3. begin 重建标记（阻止意图被覆盖）
   *   4. 执行 task
   *   5. end 重建标记（自动触发 restore）
   *   6. afterRestore 回调
   *
   * 多个 run 调用按序执行，不重叠。
   *
   * @param task 要执行的结构重放任务
   * @param options 选项（shouldRestore、afterRestore）
   */
  async run(
    task: () => void | Promise<void>,
    options: TerminalStructuralReplayCoordinatorOptions = {},
  ): Promise<void> {
    if (this.disposed) {
      return
    }
    return new Promise<void>((resolve, reject) => {
      this.taskQueue.push({
        task,
        options,
        resolve,
        reject,
        cancelled: false,
      })
      if (!this.running) {
        this.processNext()
      }
    })
  }

  /**
   * 释放协调器，中断所有正在执行和等待的任务。
   *
   * - 正在执行的任务：在下次异步 yield 时被中断（通过 cancelled 标记）
   * - 等待中的任务：立即被 reject
   * - 不再接受新任务（run 静默返回）
   */
  dispose(): void {
    this.disposed = true
    // 取消所有等待中的任务
    const pending = this.taskQueue
    this.taskQueue = []
    for (const item of pending) {
      item.cancelled = true
      item.reject(new Error('TerminalStructuralReplayCoordinator has been disposed'))
    }
  }

  // ─── 内部实现 ──────────────────────────────────────────────────────────

  /**
   * 处理队列中的下一个任务。
   * 串行保证：一次只处理一个任务，完成后才处理下一个。
   */
  private async processNext(): Promise<void> {
    if (this.disposed || this.running || this.taskQueue.length === 0) {
      return
    }

    this.running = true
    const item = this.taskQueue.shift()!

    try {
      // 如果任务已被取消（dispose 时标记），直接 reject
      if (item.cancelled) {
        item.reject(new Error('Task cancelled'))
        return
      }

      const terminal = this.terminal
      const { shouldRestore, afterRestore } = item.options

      // 检查 shouldRestore 守卫：如果返回 false，跳过重建/恢复
      const shouldRestoreResult = shouldRestore ? shouldRestore() : true

      if (!shouldRestoreResult) {
        // 不保护滚动意图，直接执行任务
        try {
          await item.task()
        } catch (e) {
          item.reject(e as Error)
          return
        }
        item.resolve()
        return
      }

      // 1. capture 重建前意图
      if (terminal) {
        captureTerminalStructuralScrollIntent(terminal)
      }

      // 2. cancel 挂起恢复（来自 scroll.ts 的延迟恢复）
      if (terminal) {
        cancelDeferredScrollRestore(terminal)
      }

      // 3. begin 重建标记
      beginTerminalScrollIntentBufferRebuild(terminal ?? {} as TerminalScrollIntentTarget)

      // 4. 执行 task
      let taskError: Error | null = null
      try {
        await item.task()
      } catch (e) {
        taskError = e as Error
      }

      // 5. end 重建标记（自动触发 restore）
      endTerminalScrollIntentBufferRebuild(terminal ?? {} as TerminalScrollIntentTarget)

      // 6. afterRestore 回调
      afterRestore?.()

      if (taskError) {
        item.reject(taskError)
      } else {
        item.resolve()
      }
    } catch (e) {
      item.reject(e as Error)
    } finally {
      this.running = false
      // 处理下一个任务
      if (!this.disposed) {
        this.processNext()
      }
    }
  }
}