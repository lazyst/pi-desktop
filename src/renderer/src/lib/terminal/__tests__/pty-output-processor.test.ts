import { describe, expect, it, vi } from 'vitest'
import { PtyOutputProcessor } from '../pty-output-processor'

// 默认 scheduleFlush 用 queueMicrotask：await 一个微任务即可让 flush 执行
// （flush 微任务先入队，先于本 promise 的 resolve 运行）。
const flushMicrotasks = (): Promise<void> =>
  new Promise((resolve) => queueMicrotask(resolve))

// ---------------------------------------------------------------------------
// onTitleChange 转发（原始标题透传，保留 Braille 前缀）
// ---------------------------------------------------------------------------

describe('onTitleChange 转发', () => {
  it('原始标题保留 Braille 前缀原样转发', async () => {
    const title = vi.fn()
    const processor = new PtyOutputProcessor({ onTitleChange: title })

    processor.onTitleChange('⠋ π - x')
    await flushMicrotasks()

    expect(title).toHaveBeenCalledTimes(1)
    expect(title).toHaveBeenCalledWith('⠋ π - x')
  })

  it('同一批次多个标题 → 只转发最后一个', async () => {
    const title = vi.fn()
    const processor = new PtyOutputProcessor({ onTitleChange: title })

    processor.onTitleChange('⠋ π - a')
    processor.onTitleChange('⠙ π - a')
    processor.onTitleChange('π - a')
    await flushMicrotasks()

    expect(title).toHaveBeenCalledTimes(1)
    expect(title).toHaveBeenCalledWith('π - a')
  })

  it('相同标题重复 → 不重复转发', async () => {
    const title = vi.fn()
    const processor = new PtyOutputProcessor({ onTitleChange: title })

    processor.onTitleChange('π - x')
    await flushMicrotasks()
    expect(title).toHaveBeenCalledTimes(1)

    // 后续批次再收到相同标题：不再转发
    processor.onTitleChange('π - x')
    await flushMicrotasks()
    expect(title).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// 状态切换（working / idle）
// ---------------------------------------------------------------------------

describe('状态切换', () => {
  it('Braille 标题 → onAgentBecameWorking', async () => {
    const working = vi.fn()
    const idle = vi.fn()
    const processor = new PtyOutputProcessor({
      onAgentBecameWorking: working,
      onAgentBecameIdle: idle,
    })

    processor.onTitleChange('⠋ π - x')
    await flushMicrotasks()

    expect(working).toHaveBeenCalledTimes(1)
    expect(idle).not.toHaveBeenCalled()
  })

  it('普通标题 → onAgentBecameIdle', async () => {
    const working = vi.fn()
    const idle = vi.fn()
    const processor = new PtyOutputProcessor({
      onAgentBecameWorking: working,
      onAgentBecameIdle: idle,
    })

    processor.onTitleChange('π - x')
    await flushMicrotasks()

    expect(idle).toHaveBeenCalledTimes(1)
    expect(working).not.toHaveBeenCalled()
  })

  it('working → idle 各触发一次', async () => {
    const working = vi.fn()
    const idle = vi.fn()
    const processor = new PtyOutputProcessor({
      onAgentBecameWorking: working,
      onAgentBecameIdle: idle,
    })

    processor.onTitleChange('⠋ π - x')
    await flushMicrotasks()
    processor.onTitleChange('π - x')
    await flushMicrotasks()

    expect(working).toHaveBeenCalledTimes(1)
    expect(idle).toHaveBeenCalledTimes(1)
  })

  it('working → idle → working 状态再次切换仍触发', async () => {
    const working = vi.fn()
    const idle = vi.fn()
    const processor = new PtyOutputProcessor({
      onAgentBecameWorking: working,
      onAgentBecameIdle: idle,
    })

    processor.onTitleChange('⠋ π - a')
    await flushMicrotasks()
    processor.onTitleChange('π - a')
    await flushMicrotasks()
    processor.onTitleChange('⠙ π - a')
    await flushMicrotasks()

    expect(working).toHaveBeenCalledTimes(2)
    expect(idle).toHaveBeenCalledTimes(1)
  })

  it('working → working（不同 Braille 帧）不重复触发', async () => {
    const working = vi.fn()
    const title = vi.fn()
    const processor = new PtyOutputProcessor({
      onTitleChange: title,
      onAgentBecameWorking: working,
    })

    processor.onTitleChange('⠋ π - x')
    await flushMicrotasks()
    processor.onTitleChange('⠙ π - x')
    await flushMicrotasks()

    expect(working).toHaveBeenCalledTimes(1)
    // 标题本身仍转发（新帧）
    expect(title).toHaveBeenCalledTimes(2)
  })

  it('空标题 → 不触发任何状态回调（标题透传仍按原始语义转发）', async () => {
    const working = vi.fn()
    const idle = vi.fn()
    const processor = new PtyOutputProcessor({
      onAgentBecameWorking: working,
      onAgentBecameIdle: idle,
    })

    processor.onTitleChange('')
    await flushMicrotasks()

    expect(working).not.toHaveBeenCalled()
    expect(idle).not.toHaveBeenCalled()
  })

  it('首次状态 null → idle 应触发 onAgentBecameIdle', async () => {
    const working = vi.fn()
    const idle = vi.fn()
    const processor = new PtyOutputProcessor({
      onAgentBecameWorking: working,
      onAgentBecameIdle: idle,
    })

    processor.onTitleChange('π - x')
    await flushMicrotasks()

    expect(idle).toHaveBeenCalledTimes(1)
    expect(working).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Bell 合并
// ---------------------------------------------------------------------------

describe('Bell 合并', () => {
  it('同一批次 3 次 handleBell → 1 次 onBell', async () => {
    const bell = vi.fn()
    const processor = new PtyOutputProcessor({ onBell: bell })

    processor.handleBell()
    processor.handleBell()
    processor.handleBell()
    await flushMicrotasks()

    expect(bell).toHaveBeenCalledTimes(1)
  })

  it('跨批次分别合并', async () => {
    const bell = vi.fn()
    const processor = new PtyOutputProcessor({ onBell: bell })

    processor.handleBell()
    await flushMicrotasks()
    processor.handleBell()
    processor.handleBell()
    await flushMicrotasks()

    expect(bell).toHaveBeenCalledTimes(2)
  })

  it('标题与铃声同批互不影响', async () => {
    const bell = vi.fn()
    const title = vi.fn()
    const processor = new PtyOutputProcessor({ onTitleChange: title, onBell: bell })

    processor.onTitleChange('π - x')
    processor.handleBell()
    processor.handleBell()
    await flushMicrotasks()

    expect(title).toHaveBeenCalledTimes(1)
    expect(bell).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

describe('生命周期', () => {
  it('dispose 先 flush 尾部侧效果，之后再调用不再触发', async () => {
    const title = vi.fn()
    const bell = vi.fn()
    const working = vi.fn()
    const idle = vi.fn()
    const processor = new PtyOutputProcessor({
      onTitleChange: title,
      onBell: bell,
      onAgentBecameWorking: working,
      onAgentBecameIdle: idle,
    })

    processor.onTitleChange('⠋ π - x')
    processor.dispose() // flush 尾部效果

    expect(title).toHaveBeenCalledTimes(1)
    expect(working).toHaveBeenCalledTimes(1)

    // 销毁后不再接受新效果
    processor.onTitleChange('π - x')
    processor.handleBell()
    await flushMicrotasks()

    expect(title).toHaveBeenCalledTimes(1)
    expect(bell).not.toHaveBeenCalled()
    expect(working).toHaveBeenCalledTimes(1)
    expect(idle).not.toHaveBeenCalled()
  })

  it('flushPendingSideEffects 幂等：重复调用不重复派发', async () => {
    const title = vi.fn()
    const processor = new PtyOutputProcessor({ onTitleChange: title })

    processor.onTitleChange('π - x')
    processor.flushPendingSideEffects()
    processor.flushPendingSideEffects()
    await flushMicrotasks() // 已调度的微任务 flush 此时为空队列 → no-op

    expect(title).toHaveBeenCalledTimes(1)
    expect(title).toHaveBeenCalledWith('π - x')
  })

  it('getStatus 返回当前状态', async () => {
    const processor = new PtyOutputProcessor({})

    expect(processor.getStatus()).toBeNull()

    processor.onTitleChange('⠋ π - x')
    await flushMicrotasks()
    expect(processor.getStatus()).toBe('working')

    processor.onTitleChange('π - x')
    await flushMicrotasks()
    expect(processor.getStatus()).toBe('idle')

    processor.onTitleChange('')
    await flushMicrotasks()
    expect(processor.getStatus()).toBe('idle') // 空标题状态为 null，不改变已跟踪状态
  })

  it('dispose 后 getStatus 仍可查询', () => {
    const processor = new PtyOutputProcessor({})
    processor.onTitleChange('⠋ π - x')
    processor.dispose()
    expect(processor.getStatus()).toBe('working')
  })
})

// ---------------------------------------------------------------------------
// 微任务调度
// ---------------------------------------------------------------------------

describe('微任务调度', () => {
  it('同步多次 onTitleChange → 只调度一次 flush', async () => {
    const title = vi.fn()
    let scheduledCount = 0
    let scheduledFn: (() => void) | null = null
    const processor = new PtyOutputProcessor(
      { onTitleChange: title },
      {
        scheduleFlush: (fn) => {
          scheduledCount++
          scheduledFn = fn
        },
      }
    )

    processor.onTitleChange('a')
    processor.onTitleChange('b')
    expect(scheduledCount).toBe(1)

    scheduledFn!()
    expect(title).toHaveBeenCalledTimes(1)
    expect(title).toHaveBeenCalledWith('b')
  })

  it('scheduleFlush 注入：一次 flush 后可再次调度', () => {
    const title = vi.fn()
    let scheduledCount = 0
    let scheduledFn: (() => void) | null = null
    const processor = new PtyOutputProcessor(
      { onTitleChange: title },
      {
        scheduleFlush: (fn) => {
          scheduledCount++
          scheduledFn = fn
        },
      }
    )

    processor.onTitleChange('a')
    processor.onTitleChange('b')
    expect(scheduledCount).toBe(1)
    scheduledFn!()
    expect(title).toHaveBeenLastCalledWith('b')

    // 已执行的调度器可再次被使用
    processor.onTitleChange('c')
    expect(scheduledCount).toBe(2)
    scheduledFn!()
    expect(title).toHaveBeenLastCalledWith('c')
    expect(title).toHaveBeenCalledTimes(2)
  })

  it('未 flush 前 getStatus 不更新（状态随 flush 派发）', () => {
    const processor = new PtyOutputProcessor({})
    processor.onTitleChange('⠋ π - x')
    expect(processor.getStatus()).toBeNull()
  })

  it('手动 flush 与调度 flush 混用安全', async () => {
    const title = vi.fn()
    const processor = new PtyOutputProcessor({ onTitleChange: title })

    processor.onTitleChange('a')
    processor.flushPendingSideEffects() // 手动立即处理
    processor.onTitleChange('b')
    await flushMicrotasks() // 调度 flush 处理 b

    expect(title).toHaveBeenCalledTimes(2)
    expect(title).toHaveBeenNthCalledWith(1, 'a')
    expect(title).toHaveBeenNthCalledWith(2, 'b')
  })
})
