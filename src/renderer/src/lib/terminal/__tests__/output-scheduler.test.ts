// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// 注意：pipeline health 函数通过动态 import 获取，确保与 scheduler 共享同一模块实例。
// 见 `loadScheduler` 中 `vi.resetModules()` 的说明。

/** 创建一个基本终端 mock（只支持 write）。 */
function createTerminal() {
  return {
    write: vi.fn((_data: string, callback?: () => void) => {
      callback?.()
    }),
  }
}

/** 加载 scheduler 模块（每次测试独立加载以保证隔离的模块状态）。 */
async function loadScheduler() {
  vi.resetModules()
  return import('../output-scheduler')
}

describe('output-scheduler 基于优先级的终端输出写调度器', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  describe('ACK 信用集成（parse-deferred ACK crediting）', () => {
    function makeCredit(): { fire: () => void; count: () => number } {
      let fired = 0
      return { fire: () => (fired += 1), count: () => fired }
    }

    it('前台立即写入的 ACK 信用在解析完成后才释放', async () => {
      const { writeTerminalOutput } = await loadScheduler()
      const terminal = createTerminal()
      let parsed: (() => void) | undefined
      terminal.write.mockImplementation((_data: string, callback?: () => void) => {
        parsed = callback
      })
      const credit = makeCredit()

      writeTerminalOutput(terminal, 'hello', {
        foreground: true,
        ackCredit: credit.fire,
      })
      expect(credit.count()).toBe(0)
      expect(terminal.write).toHaveBeenCalledWith('hello', expect.any(Function))

      parsed?.()
      expect(credit.count()).toBe(1)
    })

    it('排队写入的 ACK 信用在 drain 解析完成后才释放', async () => {
      const { writeTerminalOutput } = await loadScheduler()
      const terminal = createTerminal()
      let parsed: (() => void) | undefined
      terminal.write.mockImplementation((_data: string, callback?: () => void) => {
        parsed = callback
      })
      const credit = makeCredit()

      writeTerminalOutput(terminal, 'queued', {
        foreground: false,
        ackCredit: credit.fire,
      })
      expect(credit.count()).toBe(0)

      // 触发 drain
      vi.advanceTimersByTime(50)
      expect(terminal.write).toHaveBeenCalledWith('queued', expect.any(Function))
      expect(credit.count()).toBe(0)

      // 解析完成
      parsed?.()
      expect(credit.count()).toBe(1)
    })

    it('空写入立即释放 ACK 信用', async () => {
      const { writeTerminalOutput } = await loadScheduler()
      const terminal = createTerminal()
      const credit = makeCredit()

      writeTerminalOutput(terminal, '', { foreground: true, ackCredit: credit.fire })
      expect(credit.count()).toBe(1)
      expect(terminal.write).not.toHaveBeenCalled()
    })

    it('丢弃队列时释放所有未消费的 ACK 信用', async () => {
      const { writeTerminalOutput, discardQueuedOutput } = await loadScheduler()
      const terminal = createTerminal()
      terminal.write.mockImplementation(() => {}) // 永不完成
      const credit = makeCredit()

      writeTerminalOutput(terminal, 'doomed', {
        foreground: false,
        ackCredit: credit.fire,
      })
      expect(credit.count()).toBe(0)

      discardQueuedOutput(terminal)
      expect(credit.count()).toBe(1)
    })

    it('backlog 超过上限时释放所有未消费的 ACK 信用', async () => {
      const { writeTerminalOutput, configureTerminalOutputBacklogCap } = await loadScheduler()
      const terminal = createTerminal()
      terminal.write.mockImplementation(() => {}) // 永不完成
      const credits = [makeCredit(), makeCredit(), makeCredit()]

      // 缩小容量以触发 backlog cap
      configureTerminalOutputBacklogCap(1_000)

      for (const credit of credits) {
        writeTerminalOutput(terminal, 'x'.repeat(1024 * 1024), {
          foreground: true,
          latencySensitive: false,
          ackCredit: credit.fire,
        })
      }

      // 所有 credit 应被释放
      for (const credit of credits) {
        expect(credit.count()).toBe(1)
      }
    })

    it('前台立即写入的 ACK 信用在解析后释放，且与 onParsed 一起', async () => {
      const { writeTerminalOutput } = await loadScheduler()
      const terminal = createTerminal()
      let parsed: (() => void) | undefined
      terminal.write.mockImplementation((_data: string, callback?: () => void) => {
        parsed = callback
      })
      const credit = makeCredit()
      const onParsed = vi.fn()

      writeTerminalOutput(terminal, 'now', {
        foreground: true,
        ackCredit: credit.fire,
        onParsed,
      })
      expect(credit.count()).toBe(0)
      expect(onParsed).not.toHaveBeenCalled()

      parsed?.()
      expect(credit.count()).toBe(1)
      expect(onParsed).toHaveBeenCalledTimes(1)
    })
  })

  describe('写入行为（foreground / background）', () => {
    it('前台写入立即执行（latencySensitive 默认 true）', async () => {
      const { writeTerminalOutput } = await loadScheduler()
      const terminal = createTerminal()

      writeTerminalOutput(terminal, 'foreground', { foreground: true })

      expect(terminal.write).toHaveBeenCalledWith('foreground', expect.any(Function))
    })

    it('前台非延迟敏感写入排队到 drain', async () => {
      const { writeTerminalOutput } = await loadScheduler()
      const terminal = createTerminal()

      writeTerminalOutput(terminal, 'throughput', {
        foreground: true,
        latencySensitive: false,
      })

      expect(terminal.write).not.toHaveBeenCalled()
      vi.advanceTimersByTime(0)
      expect(terminal.write).toHaveBeenCalledWith('throughput', expect.any(Function))
    })

    it('后台写入合并到定时 drain', async () => {
      const { writeTerminalOutput } = await loadScheduler()
      const terminal = createTerminal()

      writeTerminalOutput(terminal, 'a', { foreground: false })
      writeTerminalOutput(terminal, 'b', { foreground: false })

      expect(terminal.write).not.toHaveBeenCalled()
      vi.advanceTimersByTime(50)

      // 合并写入
      expect(terminal.write).toHaveBeenCalledTimes(1)
      expect(terminal.write).toHaveBeenCalledWith('ab', expect.any(Function))
    })

    it('多个后台终端每次 drain 写入有限个', async () => {
      const { writeTerminalOutput } = await loadScheduler()
      const terminals = [createTerminal(), createTerminal(), createTerminal()]

      terminals.forEach((terminal, index) => {
        writeTerminalOutput(terminal, `pane-${index}`, { foreground: false })
      })

      // 第一次 drain 只处理 2 个终端（MAX_WRITES_PER_DRAIN）
      vi.advanceTimersByTime(50)
      expect(terminals[0].write).toHaveBeenCalledWith('pane-0', expect.any(Function))
      expect(terminals[1].write).toHaveBeenCalledWith('pane-1', expect.any(Function))
      expect(terminals[2].write).not.toHaveBeenCalled()

      // 第二次 drain
      vi.advanceTimersByTime(16)
      expect(terminals[2].write).toHaveBeenCalledWith('pane-2', expect.any(Function))
    })
  })

  describe('onParsed 回调', () => {
    it('前台立即写入的 onParsed 在解析后触发', async () => {
      const { writeTerminalOutput } = await loadScheduler()
      const terminal = createTerminal()
      let parsed: (() => void) | undefined
      terminal.write.mockImplementation((_data: string, callback?: () => void) => {
        parsed = callback
      })
      const onParsed = vi.fn()

      writeTerminalOutput(terminal, 'now', {
        foreground: true,
        onParsed,
      })

      expect(onParsed).not.toHaveBeenCalled()
      parsed?.()
      expect(onParsed).toHaveBeenCalledTimes(1)
    })

    it('排队写入的 onParsed 在 drain 解析后触发', async () => {
      const { writeTerminalOutput } = await loadScheduler()
      const terminal = createTerminal()
      let parsed: (() => void) | undefined
      terminal.write.mockImplementation((_data: string, callback?: () => void) => {
        parsed = callback
      })
      const onParsed = vi.fn()

      writeTerminalOutput(terminal, 'queued', {
        foreground: false,
        onParsed,
      })

      expect(onParsed).not.toHaveBeenCalled()
      vi.advanceTimersByTime(50)
      expect(terminal.write).toHaveBeenCalledWith('queued', expect.any(Function))
      expect(onParsed).not.toHaveBeenCalled()

      parsed?.()
      expect(onParsed).toHaveBeenCalledTimes(1)
    })
  })

  describe('优先级调度', () => {
    it('高优先级先于后台 drain', async () => {
      const { writeTerminalOutput } = await loadScheduler()
      const backgroundA = createTerminal()
      const backgroundB = createTerminal()
      const active = createTerminal()

      writeTerminalOutput(backgroundA, 'bg-a', { foreground: false })
      writeTerminalOutput(backgroundB, 'bg-b', { foreground: false })
      writeTerminalOutput(active, 'active', {
        foreground: true,
        latencySensitive: false,
      })

      vi.advanceTimersByTime(0)

      expect(active.write).toHaveBeenCalledWith('active', expect.any(Function))
      expect(active.write.mock.invocationCallOrder[0]).toBeLessThan(
        backgroundA.write.mock.invocationCallOrder[0],
      )
      expect(active.write.mock.invocationCallOrder[0]).toBeLessThan(
        backgroundB.write.mock.invocationCallOrder[0],
      )
    })

    it('大 backlog 后台提升为高优先级', async () => {
      const { writeTerminalOutput } = await loadScheduler()
      const terminal = createTerminal()
      const chunk = 'x'.repeat(16 * 1024)

      // 写入 64KB 触发大 backlog 阈值
      for (let i = 0; i < 64; i++) {
        writeTerminalOutput(terminal, chunk, { foreground: false })
      }

      expect(terminal.write).not.toHaveBeenCalled()

      // 大 backlog 使用高优先级 drain（8 次写入 per tick）
      vi.advanceTimersByTime(0)
      expect(terminal.write).toHaveBeenCalledTimes(8)
    })
  })

  describe('backlog 上限', () => {
    it('后台队列超过上限时保留警告消息', async () => {
      const { writeTerminalOutput } = await loadScheduler()
      const terminal = createTerminal()
      const chunk = 'x'.repeat(512 * 1024)

      // 写入大量数据触发 cap
      for (let i = 0; i < 5; i++) {
        writeTerminalOutput(terminal, chunk, { foreground: false })
      }
      writeTerminalOutput(terminal, 'after-cap\r\n', { foreground: false })

      vi.advanceTimersByTime(0)

      const output = terminal.write.mock.calls.map(([data]) => data).join('')
      expect(output).toContain('backlog limit reached')
      expect(output).toContain('after-cap')
      expect(output).not.toContain('x'.repeat(1024))
    })

    it('前台队列超过上限时保留前台警告消息', async () => {
      const { writeTerminalOutput } = await loadScheduler()
      const terminal = createTerminal()
      const chunk = 'x'.repeat(512 * 1024)

      for (let i = 0; i < 5; i++) {
        writeTerminalOutput(terminal, chunk, { foreground: true, latencySensitive: false })
      }
      writeTerminalOutput(terminal, 'after-cap\r\n', { foreground: true, latencySensitive: false })

      vi.advanceTimersByTime(0)

      const output = terminal.write.mock.calls.map(([data]) => data).join('')
      expect(output).toContain('Foreground output capped')
      expect(output).toContain('after-cap')
    })

    it('configureTerminalOutputBacklogCap 可以调整容量', async () => {
      const { writeTerminalOutput, configureTerminalOutputBacklogCap } = await loadScheduler()
      const terminal = createTerminal()
      const chunk = 'x'.repeat(512 * 1024)

      // 设置为 50k 行，容量很大
      configureTerminalOutputBacklogCap(50_000)

      for (let i = 0; i < 5; i++) {
        writeTerminalOutput(terminal, chunk, { foreground: true, latencySensitive: false })
      }
      vi.advanceTimersByTime(0)

      const output = terminal.write.mock.calls.map(([data]) => data).join('')
      expect(output).not.toContain('capped')
      expect(output).toContain('x'.repeat(1024))
    })
  })

  describe('discardQueuedOutput 丢弃队列', () => {
    it('丢弃队列后终端不再接收写入', async () => {
      const { discardQueuedOutput, writeTerminalOutput } = await loadScheduler()
      const terminal = createTerminal()

      writeTerminalOutput(terminal, 'stale', { foreground: false })
      discardQueuedOutput(terminal)
      vi.advanceTimersByTime(50)

      expect(terminal.write).not.toHaveBeenCalled()
    })

    it('丢弃后新写入进入新队列', async () => {
      const { discardQueuedOutput, writeTerminalOutput } = await loadScheduler()
      const terminal = createTerminal()

      writeTerminalOutput(terminal, 'old', { foreground: false })
      discardQueuedOutput(terminal)

      writeTerminalOutput(terminal, 'new', { foreground: false })
      vi.advanceTimersByTime(50)

      expect(terminal.write).toHaveBeenCalledWith('new', expect.any(Function))
    })
  })

  describe('setUseMessageChannelDrainForTesting', () => {
    it('可以切换到定时器 drain 模式', async () => {
      const { writeTerminalOutput, setUseMessageChannelDrainForTesting } = await loadScheduler()

      // 切换到定时器模式
      setUseMessageChannelDrainForTesting(false)

      const terminal = createTerminal()

      writeTerminalOutput(terminal, 'timer-test', {
        foreground: true,
        latencySensitive: false,
      })

      // 定时器模式：0 延迟仍然需要 setTimeout
      expect(terminal.write).not.toHaveBeenCalled()
      vi.advanceTimersByTime(0)
      expect(terminal.write).toHaveBeenCalledWith('timer-test', expect.any(Function))
    })

    it('可以恢复默认行为', async () => {
      const { setUseMessageChannelDrainForTesting } = await loadScheduler()

      // null 恢复默认
      setUseMessageChannelDrainForTesting(null)
      // 不抛出异常即可
    })
  })

  describe('与 write-pipeline-health 集成', () => {
    it('写入已认证死亡的终端时直接释放信用', async () => {
      const { writeTerminalOutput } = await loadScheduler()
      // 动态 import 确保与 scheduler 使用同一模块实例
      const {
        notifyUndeliverableWrite,
        isTerminalWritePipelineCertifiedDead,
        _resetWritePipelineHealthForTests,
      } = await import('../write-pipeline-health')
      const terminal = createTerminal()

      // 先认证终端死亡
      notifyUndeliverableWrite(terminal, 'write-stalled')
      expect(isTerminalWritePipelineCertifiedDead(terminal)).toBe(true)

      const credit = vi.fn()
      try {
        writeTerminalOutput(terminal, 'dead', { foreground: true, ackCredit: credit })

        expect(credit).toHaveBeenCalledTimes(1)
        expect(terminal.write).not.toHaveBeenCalled()
      } finally {
        _resetWritePipelineHealthForTests(terminal)
      }
    })

    it('丢弃队列时不会错误地标记解析进度', async () => {
      const { writeTerminalOutput, discardQueuedOutput } = await loadScheduler()
      const {
        captureTerminalParseProgressGeneration,
        hasTerminalParseProgressSince,
      } = await import('../write-pipeline-health')
      const terminal = createTerminal()
      terminal.write.mockImplementation(() => {})

      const generation = captureTerminalParseProgressGeneration(terminal)
      const credit = vi.fn()

      writeTerminalOutput(terminal, 'doomed', {
        foreground: false,
        ackCredit: credit,
      })

      expect(credit).not.toHaveBeenCalled()
      discardQueuedOutput(terminal)
      expect(credit).toHaveBeenCalledTimes(1)

      // 丢弃不应影响解析进度
      expect(hasTerminalParseProgressSince(terminal, generation)).toBe(false)
    })
  })
})