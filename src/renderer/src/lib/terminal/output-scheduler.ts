/**
 * 基于优先级的终端输出写调度器。
 *
 * 核心能力：
 * - 前台/后台优先级队列
 * - Parse-clocked drain（每次 drain 在 xterm 解析完成后才触发下一次）
 * - Backlog 上限（后台队列超过上限时丢弃旧数据并写入警告）
 * - ACK 信用集成（每个写入段携带 ACK 信用，解析后释放）
 */

import { runGuardedWriteCompletionStep } from './write-callback-guard'
import {
  registerTerminalOutputAckCredits,
  discardInFlightTerminalOutputAckCredits,
} from './ack-credit'
import {
  armTerminalWriteStallWatch,
  cancelTerminalWriteStallWatch,
  settleTerminalWriteStallWatch,
  recordTerminalParseProgress,
  isTerminalWritePipelineCertifiedDead,
  failTerminalWriteStallWatch,
} from './write-pipeline-health'
import { writeForegroundTerminalChunk } from './foreground-render-settle'

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

export type TerminalOutputTarget = {
  write(data: string, callback?: () => void): void
  buffer?: {
    active?: {
      cursorY?: number
      baseY?: number
      viewportY?: number
    }
  }
  rows?: number
  _core?: {
    refresh?(start: number, end: number, sync?: boolean): void
  }
  refresh?(start: number, end: number): void
}

export type WriteTerminalOutputOptions = {
  /** 前台写入（高优先级），默认 false */
  foreground?: boolean
  /** 延迟敏感（true=立即写入，false=排队由 drain 处理），默认 true */
  latencySensitive?: boolean
  /** 写入前的准备回调 */
  beforeWrite?: (data: string) => void
  /** 写入被 xterm 解析后的回调 */
  onParsed?: () => void
  /** ACK 信用：当 xterm 解析完这批字节后回调 */
  ackCredit?: () => void
  /** 强制写后刷新视口（用于前台写入后的渲染 settle）。默认 true。 */
  forceForegroundRefresh?: boolean
  /** 是否始终调度 followup viewport settle。默认 false。 */
  followupForegroundRefresh?: boolean
}

/** 队列中的单个数据块 */
type QueueChunk = {
  data: string
  foreground: boolean
  beforeWrite?: (data: string) => void
  onParsed?: () => void
  ackCredit?: () => void
}

/** 从队列取出后准备写入的合并数据 */
type QueuedWrite = {
  data: string
  foreground: boolean
  beforeWrite?: (data: string) => void
  onParsed?: () => void
  ackCredits: (() => void)[]
}

/** 每终端队列条目 */
type QueueEntry = {
  terminal: TerminalOutputTarget
  chunks: QueueChunk[]
  chunkIndex: number
  queuedChars: number
  highPriority: boolean
}

// ─── 常量 ─────────────────────────────────────────────────────────────────────

/** 后台首次 flush 延迟（ms） */
const BACKGROUND_FLUSH_DELAY_MS = 50
/** 后台 drain 间隔（ms） */
const BACKGROUND_DRAIN_INTERVAL_MS = 16
/** 高优先级 drain 间隔（ms） */
const HIGH_PRIORITY_DRAIN_INTERVAL_MS = 4
/** 每次 drain 最多取出的字符数 */
const BACKGROUND_CHUNK_CHARS = 16 * 1024
/** 每次 drain 最多写入次数（后台） */
const MAX_WRITES_PER_DRAIN = 2
/** 每次 drain 最多写入次数（高优先级） */
const HIGH_PRIORITY_MAX_WRITES_PER_DRAIN = 8
/** drain 时间预算（ms），超过则 yield */
const DRAIN_TIME_BUDGET_MS = 8
/** 大 backlog 阈值，超过则视为高优先级 */
const LARGE_BACKLOG_CHARS = 512 * 1024
/** 默认 backlog 容量上限（字符数） */
const DEFAULT_BACKLOG_CAP_CHARS = 2 * 1024 * 1024
/** 后台队列最大 chunk 数 */
const MAX_BACKGROUND_QUEUE_CHUNKS = 4096

/** 后台 backlog 丢弃警告 */
const BACKGROUND_BACKLOG_WARNING =
  '\x18\x1b[0m\r\n[Output capped: backlog limit reached]\r\n'
/** 前台 backlog 丢弃警告 */
const FOREGROUND_BACKLOG_WARNING =
  '\x18\x1b[0m\r\n[Foreground output capped: backlog limit reached]\r\n'

// ─── 可变状态 ─────────────────────────────────────────────────────────────────

/** 当前 backlog 容量上限（字符数） */
let maxQueueChars = DEFAULT_BACKLOG_CAP_CHARS

/** 按终端组织的队列 */
const queuedByTerminal = new Map<TerminalOutputTarget, QueueEntry>()

/** drain 定时器 */
let drainTimer: ReturnType<typeof setTimeout> | null = null
let drainTimerDelayMs: number | null = null

/** MessageChannel 用于零延迟 drain */
let drainImmediatePending = false
let drainImmediateGeneration = 0
let useMessageChannelDrain = typeof MessageChannel !== 'undefined' && !isVitestEnv()
let drainChannel: MessageChannel | null = null

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function isVitestEnv(): boolean {
  return typeof process !== 'undefined' && process.env?.VITEST === 'true'
}

function getDrainChannel(): MessageChannel {
  if (drainChannel === null) {
    drainChannel = new MessageChannel()
    drainChannel.port1.onmessage = (event: MessageEvent) => {
      if (event.data !== drainImmediateGeneration || !drainImmediatePending) {
        return
      }
      drainImmediatePending = false
      drainQueuedOutput()
    }
  }
  return drainChannel
}

function cancelImmediateDrain(): void {
  drainImmediateGeneration++
  drainImmediatePending = false
}

function getTimeNow(): number {
  if (typeof performance !== 'undefined') {
    return performance.now()
  }
  return Date.now()
}

// ─── 队列管理 ─────────────────────────────────────────────────────────────────

function createQueueEntry(terminal: TerminalOutputTarget): QueueEntry {
  return {
    terminal,
    chunks: [],
    chunkIndex: 0,
    queuedChars: 0,
    highPriority: true,
  }
}

function enqueueChunk(
  entry: QueueEntry,
  data: string,
  options?: {
    foreground?: boolean
    beforeWrite?: (data: string) => void
    onParsed?: () => void
    ackCredit?: () => void
  },
): void {
  entry.chunks.push({
    data,
    foreground: options?.foreground === true,
    beforeWrite: options?.beforeWrite,
    onParsed: options?.onParsed,
    ackCredit: options?.ackCredit,
  })
  entry.queuedChars += data.length
}

/** 释放队列中所有未消费 chunk 的 ACK 信用。 */
function fireQueuedAckCredits(entry: QueueEntry): void {
  for (let i = entry.chunkIndex; i < entry.chunks.length; i++) {
    entry.chunks[i].ackCredit?.()
  }
}

/** 检查队列是否超过容量上限。 */
function queueCapExceeded(entry: QueueEntry): boolean {
  return (
    entry.queuedChars > maxQueueChars ||
    entry.chunks.length - entry.chunkIndex > MAX_BACKGROUND_QUEUE_CHUNKS
  )
}

/** 用警告替换整个 backlog，释放所有 ACK 信用。 */
function replaceBacklogWithWarning(entry: QueueEntry, warning: string): void {
  // 保留最后一个 chunk 的 beforeWrite（如果有）
  let beforeWrite: ((data: string) => void) | undefined
  for (let i = entry.chunks.length - 1; i >= entry.chunkIndex; i--) {
    if (entry.chunks[i]?.beforeWrite) {
      beforeWrite = entry.chunks[i].beforeWrite
      break
    }
  }
  fireQueuedAckCredits(entry)
  entry.chunks = [
    {
      data: warning,
      foreground: false,
      beforeWrite,
    },
  ]
  entry.chunkIndex = 0
  entry.queuedChars = warning.length
  entry.highPriority = true
}

/** 从队列中取出最多 limit 字符的数据，并合并相关的回调。 */
function takeQueuedChunk(entry: QueueEntry, limit: number): QueuedWrite | null {
  let remaining = limit
  let data = ''
  let foreground: boolean | null = null
  let beforeWrite: ((data: string) => void) | undefined
  const parsedCallbacks: (() => void)[] = []
  const ackCredits: (() => void)[] = []

  while (remaining > 0 && entry.chunkIndex < entry.chunks.length) {
    const chunk = entry.chunks[entry.chunkIndex]

    // 如果前后 chunk 的优先级不同，停止合并
    if (foreground !== null && chunk.foreground !== foreground) {
      break
    }
    foreground ??= chunk.foreground

    // 保留 beforeWrite（取第一个非空的）
    if (!beforeWrite && chunk.beforeWrite) {
      beforeWrite = chunk.beforeWrite
    }

    if (chunk.data.length <= remaining) {
      // 完整消费该 chunk
      data += chunk.data
      remaining -= chunk.data.length
      entry.queuedChars -= chunk.data.length
      entry.chunkIndex++
      if (chunk.onParsed) {
        parsedCallbacks.push(chunk.onParsed)
      }
      if (chunk.ackCredit) {
        ackCredits.push(chunk.ackCredit)
      }
    } else {
      // 部分消费——只取 remaining 部分，chunk 剩余数据保留
      data += chunk.data.slice(0, remaining)
      entry.chunks[entry.chunkIndex] = {
        ...chunk,
        data: chunk.data.slice(remaining),
      }
      entry.queuedChars -= remaining
      remaining = 0
    }
  }

  compactConsumedChunks(entry)
  if (entry.queuedChars < 0) {
    entry.queuedChars = 0
  }

  if (!data) {
    return null
  }

  return {
    data,
    foreground: foreground === true,
    beforeWrite,
    onParsed:
      parsedCallbacks.length > 0
        ? () => {
            for (const cb of parsedCallbacks) {
              cb()
            }
          }
        : undefined,
    ackCredits,
  }
}

/** 清理已消费的 chunk（当 chunkIndex 较大时回收数组空间）。 */
function compactConsumedChunks(entry: QueueEntry): void {
  if (entry.chunkIndex === 0) {
    return
  }
  if (entry.chunkIndex >= entry.chunks.length) {
    entry.chunks.length = 0
    entry.chunkIndex = 0
    return
  }
  if (entry.chunkIndex >= 64) {
    entry.chunks.splice(0, entry.chunkIndex)
    entry.chunkIndex = 0
  }
}

function hasQueuedChunks(entry: QueueEntry): boolean {
  return entry.chunkIndex < entry.chunks.length
}

// ─── 优先级与 drain 调度 ──────────────────────────────────────────────────────

function hasHighPriorityBacklog(): boolean {
  for (const entry of queuedByTerminal.values()) {
    if (entry.highPriority || entry.queuedChars > LARGE_BACKLOG_CHARS) {
      return true
    }
  }
  return false
}

function hasDrainableBacklog(): boolean {
  return queuedByTerminal.size > 0
}

/** 取出下一个可 drain 的队列条目。高优先级先出，然后是大 backlog，最后是普通后台。 */
function takeNextDrainableEntry(): QueueEntry | null {
  // 第一遍：找高优先级
  for (const entry of queuedByTerminal.values()) {
    if (entry.highPriority) {
      queuedByTerminal.delete(entry.terminal)
      return entry
    }
  }
  // 第二遍：找大 backlog（提升优先级）
  for (const entry of queuedByTerminal.values()) {
    if (entry.queuedChars > LARGE_BACKLOG_CHARS) {
      queuedByTerminal.delete(entry.terminal)
      return entry
    }
  }
  // 第三遍：普通 FIFO
  for (const entry of queuedByTerminal.values()) {
    queuedByTerminal.delete(entry.terminal)
    return entry
  }
  return null
}

// ─── Parse-clock pacer ────────────────────────────────────────────────────────

/**
 * 创建解析时钟调速器：每次 xterm 解析完成后，如果还有高优先级 backlog，立即调度下一次 drain。
 * 这保证了高优先级写入以解析器的最快速度推进，而不是被固定定时器限速。
 */
function makeParseClockPacer(): () => void {
  return () => {
    try {
      if (queuedByTerminal.size > 0 && hasHighPriorityBacklog()) {
        scheduleDrain(0)
      }
    } catch {
      // 安全运行在 xterm 回调链中，必须不抛异常
    }
  }
}

// ─── 写入执行 ─────────────────────────────────────────────────────────────────

function writeBackgroundTerminalChunk(
  terminal: TerminalOutputTarget,
  data: string,
  onParsed?: () => void,
  onWriteFailure?: () => void,
): boolean {
  const runOnParsed = onParsed
    ? (): void => runGuardedWriteCompletionStep('background-on-parsed', onParsed)
    : undefined
  const runOnWriteFailure = onWriteFailure
    ? (): void => runGuardedWriteCompletionStep('background-on-write-failure', onWriteFailure)
    : undefined
  try {
    // 如果 terminal.write 不接受回调参数（length < 2），直接调用后手动触发回调
    if (!runOnParsed || terminal.write.length < 2) {
      terminal.write(data)
      runOnParsed?.()
      return true
    }
    terminal.write(data, runOnParsed)
    return true
  } catch {
    runOnWriteFailure?.()
    return false
  }
}

/** 组合完成回调：onParsed → ACK 信用释放 → pacer → 停滞监视器结算 */
function composeParsedCallback(
  terminal: TerminalOutputTarget,
  onParsed: (() => void) | undefined,
  ackCreditsParsed: (() => void) | undefined,
  pacer: (() => void) | undefined,
): () => void {
  return () => {
    try {
      onParsed?.()
    } finally {
      ackCreditsParsed?.()
      pacer?.()
      settleTerminalWriteStallWatch(terminal)
    }
  }
}

/** 组合写入失败回调：ACK 信用释放 → 管道失败标记 */
function composeWriteFailureCallback(
  terminal: TerminalOutputTarget,
  ackCreditsParsed: (() => void) | undefined,
): () => void {
  return () => {
    try {
      ackCreditsParsed?.()
    } finally {
      failTerminalWriteStallWatch(terminal)
    }
  }
}

/** 执行一个队列条目的写入操作。返回 true 表示执行了一次写入。 */
function writeQueuedChunk(entry: QueueEntry): 'foreground' | 'background' | null {
  if (isTerminalWritePipelineCertifiedDead(entry.terminal)) {
    // 管道已死：释放所有信用，清空队列，丢弃该终端
    fireQueuedAckCredits(entry)
    entry.chunks.length = 0
    entry.chunkIndex = 0
    entry.queuedChars = 0
    discardQueuedOutput(entry.terminal)
    return null
  }

  const queuedWrite = takeQueuedChunk(entry, BACKGROUND_CHUNK_CHARS)
  if (!queuedWrite) {
    return null
  }

  const pacer = entry.highPriority ? makeParseClockPacer() : undefined
  const ackCreditsParsed = registerTerminalOutputAckCredits(entry.terminal, queuedWrite.ackCredits)

  // 在写入前武装停滞监视器
  armTerminalWriteStallWatch(entry.terminal, {
    onCertifiedDead: () => discardQueuedOutput(entry.terminal),
  })

  try {
    queuedWrite.beforeWrite?.(queuedWrite.data)

    const writeAccepted = writeBackgroundTerminalChunk(
      entry.terminal,
      queuedWrite.data,
      composeParsedCallback(entry.terminal, queuedWrite.onParsed, ackCreditsParsed, pacer),
      composeWriteFailureCallback(entry.terminal, ackCreditsParsed),
    )

    if (!writeAccepted) {
      // 写入被拒绝：释放信用，清空队列
      fireQueuedAckCredits(entry)
      entry.chunks.length = 0
      entry.chunkIndex = 0
      entry.queuedChars = 0
      return null
    }
  } catch {
    // beforeWrite 或写入设置失败
    cancelTerminalWriteStallWatch(entry.terminal)
    ackCreditsParsed?.()
    fireQueuedAckCredits(entry)
    entry.chunks.length = 0
    entry.chunkIndex = 0
    entry.queuedChars = 0
    return null
  }

  return queuedWrite.foreground ? 'foreground' : 'background'
}

// ─── Drain 调度 ───────────────────────────────────────────────────────────────

function scheduleDrain(delayMs: number): void {
  if (drainImmediatePending) {
    // 已有零延迟 drain 在等待，无需再调度
    return
  }
  if (drainTimer !== null) {
    if (drainTimerDelayMs !== null && drainTimerDelayMs <= delayMs) {
      return
    }
    clearTimeout(drainTimer)
    drainTimer = null
    drainTimerDelayMs = null
  }
  if (queuedByTerminal.size === 0) {
    return
  }

  if (delayMs === 0 && useMessageChannelDrain) {
    drainImmediatePending = true
    getDrainChannel().port2.postMessage(drainImmediateGeneration)
    return
  }

  drainTimer = setTimeout(drainQueuedOutput, delayMs)
  drainTimerDelayMs = delayMs
}

function drainQueuedOutput(): void {
  drainTimer = null
  drainTimerDelayMs = null
  let writes = 0
  const startedAt = getTimeNow()
  const maxWrites = hasHighPriorityBacklog()
    ? HIGH_PRIORITY_MAX_WRITES_PER_DRAIN
    : MAX_WRITES_PER_DRAIN

  while (queuedByTerminal.size > 0 && writes < maxWrites) {
    const entry = takeNextDrainableEntry()
    if (!entry) {
      break
    }

    const writeKind = writeQueuedChunk(entry)
    if (writeKind) {
      writes++
    }

    if (hasQueuedChunks(entry)) {
      queuedByTerminal.set(entry.terminal, entry)
    } else {
      entry.highPriority = false
    }

    // 时间预算检查：如果已超过 DRAIN_TIME_BUDGET_MS，yield 给主线程
    if (writes > 0 && getTimeNow() - startedAt >= DRAIN_TIME_BUDGET_MS) {
      break
    }
  }

  if (queuedByTerminal.size > 0 && hasDrainableBacklog()) {
    scheduleDrain(
      hasHighPriorityBacklog()
        ? useMessageChannelDrain
          ? 0
          : HIGH_PRIORITY_DRAIN_INTERVAL_MS
        : BACKGROUND_DRAIN_INTERVAL_MS,
    )
  }
}

// ─── 公开 API ─────────────────────────────────────────────────────────────────

/**
 * 向终端写入输出数据。
 *
 * - 前台（foreground=true, latencySensitive 默认 true）：立即写入 xterm
 * - 前台（foreground=true, latencySensitive=false）：排队到高优先级 drain
 * - 后台（foreground=false）：排队到后台 drain
 *
 * 每个写入段携带 ACK 信用，在 xterm 解析完成后释放。
 * 队列超过 backlog 上限时，旧数据会被丢弃并写入警告消息。
 */
export function writeTerminalOutput(
  terminal: TerminalOutputTarget,
  data: string,
  options?: WriteTerminalOutputOptions,
): void {
  // 处理已认证死亡的终端
  if (isTerminalWritePipelineCertifiedDead(terminal)) {
    options?.ackCredit?.()
    return
  }

  // 空数据：直接释放信用
  if (!data) {
    options?.ackCredit?.()
    return
  }

  const foreground = options?.foreground === true
  const latencySensitive = options?.latencySensitive !== false // 默认 true

  if (foreground && latencySensitive) {
    // ─── 前台立即写入（含渲染 settle） ─────────────────────────────────
    const ackCredits = options?.ackCredit ? [options.ackCredit] : []
    const ackCreditsParsed = registerTerminalOutputAckCredits(terminal, ackCredits)
    armTerminalWriteStallWatch(terminal, {
      onCertifiedDead: () => discardQueuedOutput(terminal),
    })

    // 使用 writeForegroundTerminalChunk 确保写后渲染 settle
    const forceRefresh = options?.forceForegroundRefresh !== false // 默认 true
    // 默认始终调度一次 followup viewport settle，确保视口完全稳定
    // 特别是在高频输出场景下，单次 refresh 可能被后续写覆盖
    const followupRefresh = options?.followupForegroundRefresh !== false
    const pacer = makeParseClockPacer()

    const accepted = writeForegroundTerminalChunk(
      terminal,
      data,
      {
        forceViewportRefresh: forceRefresh,
        followupViewportRefresh: followupRefresh,
        onParsed: () => {
          try {
            options?.onParsed?.()
            ackCreditsParsed?.()
            pacer?.()
            settleTerminalWriteStallWatch(terminal)
          } catch {
            // 安全运行在 xterm 回调链中，必须不抛异常
          }
        },
        onWriteFailure: () => {
          try {
            ackCreditsParsed?.()
          } finally {
            failTerminalWriteStallWatch(terminal)
          }
        },
      },
    )

    if (!accepted) {
      // 写入被拒绝：释放信用
      ackCreditsParsed?.()
      cancelTerminalWriteStallWatch(terminal)
    }
    return
  }

  // ─── 排队写入（前台非延迟敏感或后台） ──────────────────────────────────
  let entry = queuedByTerminal.get(terminal)
  if (!entry) {
    entry = createQueueEntry(terminal)
    entry.highPriority = foreground // 前台排队仍为高优先级
    queuedByTerminal.set(terminal, entry)
  } else if (foreground) {
    entry.highPriority = true
  }

  enqueueChunk(entry, data, {
    foreground,
    beforeWrite: options?.beforeWrite,
    onParsed: options?.onParsed,
    ackCredit: options?.ackCredit,
  })

  if (queueCapExceeded(entry)) {
    replaceBacklogWithWarning(entry, foreground ? FOREGROUND_BACKLOG_WARNING : BACKGROUND_BACKLOG_WARNING)
  }

  scheduleDrain(
    entry.highPriority || entry.queuedChars > LARGE_BACKLOG_CHARS
      ? 0
      : BACKGROUND_FLUSH_DELAY_MS,
  )
}

/**
 * 设置 backlog 容量上限（基于 scrollback 行数）。
 * 简化版：使用固定公式计算容量。
 */
export function configureTerminalOutputBacklogCap(scrollbackRows: number): void {
  // 公式：每行约 2KB，上限至少为最小容量
  const estimatedCharsPerRow = 2048
  const cap = Math.max(DEFAULT_BACKLOG_CAP_CHARS, scrollbackRows * estimatedCharsPerRow)
  maxQueueChars = cap
}

/**
 * 丢弃指定终端的队列输出，释放所有 ACK 信用。
 * 当终端被销毁或不再需要渲染输出时调用。
 */
export function discardQueuedOutput(terminal: TerminalOutputTarget): void {
  const entry = queuedByTerminal.get(terminal)
  if (entry) {
    fireQueuedAckCredits(entry)
    entry.chunks.length = 0
    entry.chunkIndex = 0
    entry.queuedChars = 0
  }
  discardInFlightTerminalOutputAckCredits(terminal)
  queuedByTerminal.delete(terminal)
  cancelTerminalWriteStallWatch(terminal)
}

/**
 * 设置是否使用 MessageChannel 进行零延迟 drain（仅用于测试）。
 * 当 value 为 null 时恢复默认行为。
 */
export function setUseMessageChannelDrainForTesting(value: boolean | null): void {
  cancelImmediateDrain()
  useMessageChannelDrain = value ?? (typeof MessageChannel !== 'undefined' && !isVitestEnv())
}