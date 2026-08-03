// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  TerminalStructuralReplayCoordinator,
  type TerminalStructuralReplayCoordinatorOptions,
} from '../structural-replay-coordinator'
import {
  beginTerminalScrollIntentBufferRebuild,
  endTerminalScrollIntentBufferRebuild,
  isTerminalScrollIntentRebuildInFlight,
} from '../scroll-intent-rebuild'
import {
  markTerminalPinnedViewport,
  markTerminalFollowOutput,
  getTerminalScrollIntentKind,
  syncTerminalScrollIntentFromViewport,
  type TerminalScrollIntentTarget,
} from '../scroll-intent'

// ─── 辅助工厂函数 ──────────────────────────────────────────────────────────

/**
 * 创建一个模拟的终端对象（兼容 TerminalScrollIntentTarget）。
 */
function createMockTerminal(overrides?: {
  viewportY?: number
  baseY?: number
  bufferType?: string
  scrollToBottomShouldThrow?: boolean
  scrollToLineShouldThrow?: boolean
}): TerminalScrollIntentTarget {
  const viewportY = overrides?.viewportY ?? 0
  const baseY = overrides?.baseY ?? 0
  const bufferType = overrides?.bufferType ?? 'normal'

  const scrollToBottom = vi.fn<() => void>()
  if (overrides?.scrollToBottomShouldThrow) {
    scrollToBottom.mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'dimensions')")
    })
  }

  const scrollToLine = vi.fn<(line: number) => void>()
  if (overrides?.scrollToLineShouldThrow) {
    scrollToLine.mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'dimensions')")
    })
  }

  return {
    buffer: {
      active: {
        type: bufferType,
        viewportY,
        baseY,
      },
    },
    scrollToBottom,
    scrollToLine,
  }
}

// ─── 创建协调器辅助 ────────────────────────────────────────────────────────

function createCoordinator(terminal?: TerminalScrollIntentTarget): TerminalStructuralReplayCoordinator {
  const coordinator = new TerminalStructuralReplayCoordinator()
  if (terminal) {
    coordinator.setTerminal(terminal)
  }
  return coordinator
}

// ─── 构造函数与 setTerminal ─────────────────────────────────────────────────

describe('TerminalStructuralReplayCoordinator', () => {
  describe('构造函数与 setTerminal', () => {
    it('构造后不抛出异常', () => {
      expect(() => new TerminalStructuralReplayCoordinator()).not.toThrow()
    })

    it('setTerminal 设置终端引用后不抛出', () => {
      const coordinator = new TerminalStructuralReplayCoordinator()
      const term = createMockTerminal()
      expect(() => coordinator.setTerminal(term)).not.toThrow()
    })

    it('未设置 terminal 时 run 不抛出', async () => {
      const coordinator = new TerminalStructuralReplayCoordinator()
      await expect(coordinator.run(() => {})).resolves.toBeUndefined()
    })

    it('dispose 后 run 静默返回', async () => {
      const coordinator = new TerminalStructuralReplayCoordinator()
      coordinator.dispose()
      await expect(coordinator.run(() => {})).resolves.toBeUndefined()
    })
  })

  // ─── 串行执行 ──────────────────────────────────────────────────────────

  describe('串行执行', () => {
    it('单次 run 正常执行任务', async () => {
      const coordinator = createCoordinator()
      const task = vi.fn()
      await coordinator.run(task)
      expect(task).toHaveBeenCalledTimes(1)
    })

    it('多次 run 按序执行，不重叠', async () => {
      const coordinator = createCoordinator()
      const executionOrder: number[] = []

      const task1 = async () => {
        executionOrder.push(1)
        // 模拟异步操作
        await new Promise((r) => setTimeout(r, 10))
        executionOrder.push(2)
      }

      const task2 = async () => {
        executionOrder.push(3)
        await new Promise((r) => setTimeout(r, 5))
        executionOrder.push(4)
      }

      const task3 = () => {
        executionOrder.push(5)
      }

      // 同时提交三个任务
      const p1 = coordinator.run(task1)
      const p2 = coordinator.run(task2)
      const p3 = coordinator.run(task3)

      // 等待所有完成
      await Promise.all([p1, p2, p3])

      // 验证执行顺序：task1 完全执行完 → task2 → task3
      expect(executionOrder).toEqual([1, 2, 3, 4, 5])
    })

    it('串行队列中任务不会并发执行', async () => {
      const coordinator = createCoordinator()
      let concurrentCount = 0
      let maxConcurrent = 0

      const task1 = async () => {
        concurrentCount++
        maxConcurrent = Math.max(maxConcurrent, concurrentCount)
        await new Promise((r) => setTimeout(r, 10))
        concurrentCount--
      }

      const task2 = async () => {
        concurrentCount++
        maxConcurrent = Math.max(maxConcurrent, concurrentCount)
        await new Promise((r) => setTimeout(r, 5))
        concurrentCount--
      }

      const task3 = async () => {
        concurrentCount++
        maxConcurrent = Math.max(maxConcurrent, concurrentCount)
        await new Promise((r) => setTimeout(r, 5))
        concurrentCount--
      }

      await Promise.all([
        coordinator.run(task1),
        coordinator.run(task2),
        coordinator.run(task3),
      ])

      // 最大并发数应为 1（串行执行）
      expect(maxConcurrent).toBe(1)
    })

    it('任务执行期间 rebuild 标记为进行中', async () => {
      const term = createMockTerminal({ viewportY: 50, baseY: 100 })
      const coordinator = createCoordinator(term)

      let rebuildInFlightDuringTask = false
      await coordinator.run(() => {
        rebuildInFlightDuringTask = isTerminalScrollIntentRebuildInFlight(term)
      })

      expect(rebuildInFlightDuringTask).toBe(true)
    })

    it('任务执行完毕后 rebuild 标记为完成', async () => {
      const term = createMockTerminal({ viewportY: 50, baseY: 100 })
      const coordinator = createCoordinator(term)

      await coordinator.run(async () => {
        await new Promise((r) => setTimeout(r, 5))
      })

      expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(false)
    })
  })

  // ─── 取消（dispose） ──────────────────────────────────────────────────

  describe('取消（dispose）', () => {
    it('dispose 后等待中的任务被拒绝', async () => {
      const coordinator = createCoordinator()

      // 执行一个长时间运行的任务
      const longTask = coordinator.run(async () => {
        await new Promise((r) => setTimeout(r, 1000))
      })

      // 提交一个等待中的任务
      const pendingTask = coordinator.run(() => {})

      // 立即 dispose
      coordinator.dispose()

      // 等待中的任务应该被拒绝
      await expect(pendingTask).rejects.toThrow('TerminalStructuralReplayCoordinator has been disposed')

      // 正在执行的任务... 取决于实现，是否会被中断
      // 注意：当前实现中，正在执行的任务不会被中断（没有异步取消机制）
      await longTask.catch(() => {})
    })

    it('dispose 后新提交的任务静默返回', async () => {
      const coordinator = createCoordinator()
      coordinator.dispose()
      await expect(coordinator.run(() => {})).resolves.toBeUndefined()
    })

    it('dispose 可多次调用', () => {
      const coordinator = createCoordinator()
      expect(() => {
        coordinator.dispose()
        coordinator.dispose()
        coordinator.dispose()
      }).not.toThrow()
    })
  })

  // ─── shouldRestore 选项 ──────────────────────────────────────────────────

  describe('shouldRestore 选项', () => {
    it('shouldRestore 返回 false 时跳过重建/恢复但执行任务', async () => {
      const term = createMockTerminal({ viewportY: 50, baseY: 100 })
      const coordinator = createCoordinator(term)
      const task = vi.fn()
      const shouldRestore = vi.fn(() => false)

      await coordinator.run(task, { shouldRestore })

      // 任务被执行
      expect(task).toHaveBeenCalledTimes(1)
      // shouldRestore 被调用
      expect(shouldRestore).toHaveBeenCalledTimes(1)
    })

    it('shouldRestore 返回 false 时 rebuild 标记不应启动', async () => {
      const term = createMockTerminal({ viewportY: 50, baseY: 100 })
      const coordinator = createCoordinator(term)

      expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(false)

      await coordinator.run(() => {}, { shouldRestore: () => false })

      // rebuild 标记不应被启动
      expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(false)
    })

    it('shouldRestore 返回 true 时执行完整重建/恢复流程', async () => {
      const term = createMockTerminal({ viewportY: 50, baseY: 100 })
      const coordinator = createCoordinator(term)
      const task = vi.fn()

      await coordinator.run(task, { shouldRestore: () => true })

      // 任务被执行
      expect(task).toHaveBeenCalledTimes(1)
      // rebuild 标记应已恢复
      expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(false)
    })
  })

  // ─── afterRestore 回调 ──────────────────────────────────────────────────

  describe('afterRestore 回调', () => {
    it('afterRestore 在 restore 后被调用', async () => {
      const term = createMockTerminal({ viewportY: 50, baseY: 100 })
      const coordinator = createCoordinator(term)
      const afterRestore = vi.fn()

      await coordinator.run(() => {}, { afterRestore })

      expect(afterRestore).toHaveBeenCalledTimes(1)
    })

    it('afterRestore 在任务抛出异常时仍被调用', async () => {
      const term = createMockTerminal({ viewportY: 50, baseY: 100 })
      const coordinator = createCoordinator(term)
      const afterRestore = vi.fn()
      const error = new Error('task error')

      await expect(
        coordinator.run(() => { throw error }, { afterRestore }),
      ).rejects.toThrow('task error')

      // afterRestore 应在任务抛出后仍被调用（确保 restore 流程完整性）
      expect(afterRestore).toHaveBeenCalledTimes(1)
    })

    it('afterRestore 在 shouldRestore=false 时不被调用', async () => {
      const term = createMockTerminal({ viewportY: 50, baseY: 100 })
      const coordinator = createCoordinator(term)
      const afterRestore = vi.fn()

      await coordinator.run(() => {}, { shouldRestore: () => false, afterRestore })

      // shouldRestore=false 时跳过恢复流程，afterRestore 也不应被调用
      expect(afterRestore).not.toHaveBeenCalled()
    })
  })

  // ─── 意图恢复 ──────────────────────────────────────────────────────────

  describe('意图恢复', () => {
    it('task 清空 buffer 后意图恢复为 pinnedViewport', async () => {
      const term = createMockTerminal({ viewportY: 50, baseY: 100 })
      const coordinator = createCoordinator(term)

      // 标记为 pinnedViewport
      markTerminalPinnedViewport(term)
      expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')

      // 通过 coordinator 执行清空操作
      await coordinator.run(() => {
        // 模拟清空 buffer
        term.buffer!.active!.viewportY = 0
        term.buffer!.active!.baseY = 0
      })

      // 意图应保持为 pinnedViewport
      expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')
    })

    it('task 清空 buffer 后意图恢复为 followOutput', async () => {
      const term = createMockTerminal({ viewportY: 100, baseY: 100 })
      const coordinator = createCoordinator(term)

      // 标记为 followOutput
      markTerminalFollowOutput(term)
      expect(getTerminalScrollIntentKind(term)).toBe('followOutput')

      // 通过 coordinator 执行清空操作
      await coordinator.run(() => {
        // 模拟清空 buffer
        term.buffer!.active!.viewportY = 0
        term.buffer!.active!.baseY = 0
      })

      // 意图应恢复为 followOutput
      expect(getTerminalScrollIntentKind(term)).toBe('followOutput')
    })

    it('重建期间 syncTerminalScrollIntentFromViewport 不会覆盖意图', async () => {
      const term = createMockTerminal({ viewportY: 50, baseY: 100 })
      const coordinator = createCoordinator(term)

      // 标记为 pinnedViewport
      markTerminalPinnedViewport(term)
      expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')

      // 通过 coordinator 执行，期间 syncTerminalScrollIntentFromViewport 被调用
      await coordinator.run(() => {
        // 模拟 buffer 清空期间意图被 sync
        term.buffer!.active!.viewportY = 0
        term.buffer!.active!.baseY = 0
        // 带 allowBufferShrink 的 sync 会覆盖意图
        syncTerminalScrollIntentFromViewport(term, { allowBufferShrink: true })
        // 此时意图应被覆盖为 followOutput（因为视口在底部）
        expect(getTerminalScrollIntentKind(term)).toBe('followOutput')
      })

      // 重建完成后，意图应恢复为原始 pinnedViewport
      expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')
    })
  })

  // ─── 错误处理 ──────────────────────────────────────────────────────────

  describe('错误处理', () => {
    it('task 抛出同步异常时 run 返回 rejected promise', async () => {
      const coordinator = createCoordinator()
      await expect(
        coordinator.run(() => { throw new Error('sync error') }),
      ).rejects.toThrow('sync error')
    })

    it('task 抛出异步异常时 run 返回 rejected promise', async () => {
      const coordinator = createCoordinator()
      await expect(
        coordinator.run(async () => { throw new Error('async error') }),
      ).rejects.toThrow('async error')
    })

    it('一个任务失败不应影响后续任务', async () => {
      const coordinator = createCoordinator()
      const results: string[] = []

      const p1 = coordinator.run(() => { throw new Error('fail') }).catch(() => { results.push('fail') })
      const p2 = coordinator.run(() => { results.push('success') })

      await Promise.all([p1, p2])
      // 两个任务都应执行（顺序取决于微任务调度）
      expect(results).toContain('fail')
      expect(results).toContain('success')
    })
  })

  // ─── 集成场景 ──────────────────────────────────────────────────────────

  describe('集成场景', () => {
    it('连续多次 run 正确恢复意图', async () => {
      const term = createMockTerminal({ viewportY: 50, baseY: 100 })
      const coordinator = createCoordinator(term)

      markTerminalPinnedViewport(term)

      // 第一次重建
      await coordinator.run(() => {
        term.buffer!.active!.viewportY = 0
        term.buffer!.active!.baseY = 0
      })
      expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')

      // 第二次重建（buffer 已有新数据）
      term.buffer!.active!.viewportY = 30
      term.buffer!.active!.baseY = 80
      await coordinator.run(() => {
        term.buffer!.active!.viewportY = 10
        term.buffer!.active!.baseY = 20
      })
      expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')

      // 第三次重建
      term.buffer!.active!.viewportY = 50
      term.buffer!.active!.baseY = 100
      await coordinator.run(() => {
        term.buffer!.active!.viewportY = 0
        term.buffer!.active!.baseY = 0
      })
      expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')
    })

    it('run 结束后挂起恢复状态被清理', async () => {
      const term = createMockTerminal({ viewportY: 50, baseY: 100 })
      const coordinator = createCoordinator(term)

      // 没有调用 begin 时，挂起恢复状态应为 false
      expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(false)

      await coordinator.run(() => {
        // 执行中应为 true
        expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(true)
      })

      // 执行后应为 false
      expect(isTerminalScrollIntentRebuildInFlight(term)).toBe(false)
    })

    it('不同终端使用不同协调器互不影响', async () => {
      const term1 = createMockTerminal({ viewportY: 50, baseY: 100 })
      const term2 = createMockTerminal({ viewportY: 50, baseY: 100 })
      const coordinator1 = createCoordinator(term1)
      const coordinator2 = createCoordinator(term2)

      markTerminalPinnedViewport(term1)
      markTerminalFollowOutput(term2)

      // 并行执行（两个协调器独立）
      await Promise.all([
        coordinator1.run(() => {
          term1.buffer!.active!.viewportY = 0
          term1.buffer!.active!.baseY = 0
        }),
        coordinator2.run(() => {
          term2.buffer!.active!.viewportY = 0
          term2.buffer!.active!.baseY = 0
        }),
      ])

      // 各自的意图应保持
      expect(getTerminalScrollIntentKind(term1)).toBe('pinnedViewport')
      expect(getTerminalScrollIntentKind(term2)).toBe('followOutput')
    })
  })
})