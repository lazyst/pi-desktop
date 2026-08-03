/** PTY 侧效果处理器 —— 聚合终端标题 / 铃声 / 代理状态侧效果。
 *
 * 消费 xterm 解析后的标题（AFTER 路径）与 BEL 事件，把高频、可批量合并的
 * 侧效果聚合成一批，经一次微任务 flush 统一派发：
 *
 * - 同一批次内多个标题只转发最后一个（shell spinner 每帧都写 OSC 0 标题）
 * - 同一批次内多个 BEL 合并为一次 onBell
 * - 依据标题 Braille 前缀判定代理 working / idle 状态，仅在状态真变化时回调
 *
 * 纯函数模块：不依赖 xterm / Electron，测试可在 node 环境直接构造。
 *
 * ## 集成路径（仅 AFTER）
 *
 * xterm 的 `onTitleChange` 已处理跨块拆分（TCP 分块、多帧合并），本处理器
 * 只接收**解析后**的完整标题，不实现 processData 逐字节嗅探路径。
 *
 * ## 标题标准化策略
 *
 * 原始标题透传：onTitleChange 回调收到的是含 Braille 前缀的原始标题，
 * 标准化由消费者自行调用 analyzeRawTitle 完成（与壳 updateTabTitle
 * 直接消费原始标题的行为一致）。本模块仅在内部用 analyzeRawTitle
 * 判定代理状态，不对外输出标准化结果。
 */

import { analyzeRawTitle } from './osc-title-extractor'

/** 代理状态。null 表示尚未收到任何有效状态（首帧前）。 */
export type AgentStatus = 'working' | 'idle' | null

export interface PtyOutputProcessorOptions {
  /** 调度 flush 的方式。默认 queueMicrotask。测试时可注入同步调度器。 */
  scheduleFlush?: (fn: () => void) => void
}

export interface PtyOutputProcessorCallbacks {
  /** 标题变化回调，接收原始标题（含 Braille 前缀）。同一批次内多个标题只转发最后一个。 */
  onTitleChange?: (rawTitle: string) => void
  /** 铃声回调。同一批次内多个 BEL 合并为一次。 */
  onBell?: () => void
  /** 代理进入 working 状态（首次或从 idle→working）。 */
  onAgentBecameWorking?: () => void
  /** 代理进入 idle 状态（首次或从 working→idle）。 */
  onAgentBecameIdle?: () => void
}

/** 待 flush 的单个侧效果。 */
type PendingEffect = { type: 'title'; rawTitle: string } | { type: 'bell' }

export class PtyOutputProcessor {
  private callbacks: PtyOutputProcessorCallbacks
  private scheduleFlush: (fn: () => void) => void

  /** 最近一次收到的原始标题（同步更新，供 getTitle() 查询）。 */
  private _latestTitle: string | null = null
  /** 已转发给 onTitleChange 的最后一个标题（避免重复转发）。 */
  private _lastForwardedTitle: string | null = null
  /** 当前跟踪的代理状态。null 表示尚未收到任何有效状态。 */
  private _status: AgentStatus = null
  /** 待 flush 的侧效果队列。 */
  private _pending: PendingEffect[] = []
  /** 是否已调度 flush（防止同一批次重复调度）。 */
  private _scheduledFlush = false
  /** 是否已销毁。销毁后不再接受新效果、不再派发回调。 */
  private _disposed = false

  constructor(callbacks: PtyOutputProcessorCallbacks, options?: PtyOutputProcessorOptions) {
    this.callbacks = callbacks
    this.scheduleFlush = options?.scheduleFlush ?? ((fn) => queueMicrotask(fn))
  }

  /** xterm 解析后的标题（AFTER 路径，推荐）：xterm 已处理跨块拆分。
   *
   * 同步更新 _latestTitle 供查询，效果入队并调度 flush（批内只转发最后一个）。 */
  onTitleChange(rawTitle: string): void {
    if (this._disposed) return
    this._latestTitle = rawTitle
    this._pending.push({ type: 'title', rawTitle })
    this._scheduleFlush()
  }

  /** xterm onBell 路由入口。同一批次内多个 BEL 合并为一次回调。 */
  handleBell(): void {
    if (this._disposed) return
    this._pending.push({ type: 'bell' })
    this._scheduleFlush()
  }

  /** 立即 flush 所有待处理的侧效果（幂等）。供测试和 unmount 时调用。 */
  flushPendingSideEffects(): void {
    if (this._disposed || this._pending.length === 0) return

    // 复制待处理队列到局部，清空，重置调度标记。
    const pending = this._pending
    this._pending = []
    this._scheduledFlush = false

    // 聚合：记录最后一个标题与铃声计数。
    let lastTitle: string | null = null
    let bellCount = 0
    for (const effect of pending) {
      if (effect.type === 'title') {
        lastTitle = effect.rawTitle
      } else {
        bellCount++
      }
    }

    // 铃声：同批多个 BEL 合并为一次。
    if (bellCount > 0) {
      this.callbacks.onBell?.()
    }

    // 标题：仅在标题真变化时转发，并据其判定代理状态（仅状态变化时回调）。
    if (lastTitle !== null && lastTitle !== this._lastForwardedTitle) {
      this.callbacks.onTitleChange?.(lastTitle)
      this._lastForwardedTitle = lastTitle

      const { status } = analyzeRawTitle(lastTitle)
      if (status !== null && status !== this._status) {
        if (status === 'working') {
          this.callbacks.onAgentBecameWorking?.()
        } else {
          this.callbacks.onAgentBecameIdle?.()
        }
        this._status = status
      }
    }
  }

  /** 销毁处理器。先 flush 再 dispose，确保尾部侧效果不丢失。 */
  dispose(): void {
    this.flushPendingSideEffects()
    this._disposed = true
    this._pending = []
  }

  /** 当前跟踪的代理状态。 */
  getStatus(): AgentStatus {
    return this._status
  }

  private _scheduleFlush(): void {
    if (this._scheduledFlush) return
    this._scheduledFlush = true
    this.scheduleFlush(() => this.flushPendingSideEffects())
  }
}
