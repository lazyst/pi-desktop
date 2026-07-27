/**
 * scroll-intent
 *
 * 跟踪终端视口的滚动意图（followOutput vs pinnedViewport），支持在写前捕获、
 * 写后或 resize 后恢复。
 *
 * 移植自 orca 源码的 TerminalScrollIntent 模块，去掉了 orca 特有的 rebuild 依赖。
 */

import {
  clampTerminalViewportY,
  isTerminalViewportAtBottom,
  readTerminalScrollBufferSnapshot,
  safeTerminalScrollCall,
  type TerminalScrollBufferType,
} from './scroll-buffer-snapshot'

// ─── 公开类型 ──────────────────────────────────────────────────────────────

/** 滚动意图类型。 */
export type TerminalScrollIntentKind = 'followOutput' | 'pinnedViewport'

/** 终端目标对象的最小接口。 */
export type TerminalScrollIntentTarget = {
  buffer?: {
    active?: {
      type?: string
      viewportY?: number
      baseY?: number
    }
  }
  scrollToBottom?: () => void
  scrollToLine?: (line: number) => void
}

/** 滚动意图的外部标识键（字符串）。 */
export type TerminalScrollIntentKey = string

/** 结构操作（buffer 重建/replay/resize）前捕获的滚动意图快照。 */
export type TerminalStructuralScrollIntentSnapshot = {
  kind: TerminalScrollIntentKind
  bufferType: TerminalScrollBufferType
  viewportY: number
  baseY: number
  revision: number
}

// ─── 内部类型 ──────────────────────────────────────────────────────────────

type TerminalScrollIntent = {
  kind: TerminalScrollIntentKind
  bufferType: TerminalScrollBufferType
  viewportY: number
  baseY: number
  revision: number
}

type TerminalScrollIntentEnforceOptions = {
  // 'viewportLine' 恢复绝对 buffer 行（内容只增长时正确）。
  // 'bottomOffset' 恢复距底部的距离——buffer 重建（snapshot replay、reflow）重排行号后必需。
  restoreBy?: 'viewportLine' | 'bottomOffset'
}

// ─── 内部状态 ──────────────────────────────────────────────────────────────

const terminalScrollIntentByTerminal = new WeakMap<
  TerminalScrollIntentTarget,
  TerminalScrollIntent
>()
const terminalScrollIntentKeyByTerminal = new WeakMap<
  TerminalScrollIntentTarget,
  TerminalScrollIntentKey
>()
const terminalScrollIntentKeyBindingByTerminal = new WeakMap<
  TerminalScrollIntentTarget,
  number
>()
const terminalScrollIntentByKey = new Map<
  TerminalScrollIntentKey,
  TerminalScrollIntent
>()
const terminalScrollIntentBindingByKey = new Map<
  TerminalScrollIntentKey,
  number
>()

let nextTerminalScrollIntentRevision = 1
let nextTerminalScrollIntentKeyBinding = 1

// ─── 内部辅助 ──────────────────────────────────────────────────────────────

/**
 * 从终端读取当前 buffer 快照并写入滚动意图。
 */
function writeIntent(
  terminal: TerminalScrollIntentTarget,
  kind: TerminalScrollIntentKind,
): TerminalScrollIntent | null {
  const snapshot = readTerminalScrollBufferSnapshot(terminal)
  if (!snapshot) {
    return null
  }
  return writeIntentSnapshot(terminal, kind, snapshot)
}

/**
 * 使用提供的快照数据写入滚动意图。
 */
function writeIntentSnapshot(
  terminal: TerminalScrollIntentTarget,
  kind: TerminalScrollIntentKind,
  snapshot: { bufferType: TerminalScrollBufferType; viewportY: number; baseY: number },
): TerminalScrollIntent {
  const intent: TerminalScrollIntent = {
    kind,
    ...snapshot,
    revision: nextTerminalScrollIntentRevision,
  }
  nextTerminalScrollIntentRevision += 1
  terminalScrollIntentByTerminal.set(terminal, intent)
  const key = terminalScrollIntentKeyByTerminal.get(terminal)
  if (key) {
    terminalScrollIntentByKey.set(key, intent)
  }
  return intent
}

/**
 * 读取终端关联的存储意图。
 * 优先从 terminal 直接映射查找，其次通过 key 查找。
 */
function readStoredIntent(
  terminal: TerminalScrollIntentTarget,
): TerminalScrollIntent | undefined {
  const terminalIntent = terminalScrollIntentByTerminal.get(terminal)
  if (terminalIntent) {
    return terminalIntent
  }
  const key = terminalScrollIntentKeyByTerminal.get(terminal)
  return key ? terminalScrollIntentByKey.get(key) : undefined
}

// ─── 公开 API ──────────────────────────────────────────────────────────────

/**
 * 将一个外部 key 绑定到终端。
 * 如果该 key 已有意图数据，将其继承到当前终端。
 * 返回绑定时已存在的意图（如有）。
 */
export function bindTerminalScrollIntentKey(
  terminal: TerminalScrollIntentTarget,
  key: TerminalScrollIntentKey | undefined,
): TerminalScrollIntent | undefined {
  if (!key) {
    return terminalScrollIntentByTerminal.get(terminal)
  }
  terminalScrollIntentKeyByTerminal.set(terminal, key)
  const binding = nextTerminalScrollIntentKeyBinding
  nextTerminalScrollIntentKeyBinding += 1
  terminalScrollIntentKeyBindingByTerminal.set(terminal, binding)
  terminalScrollIntentBindingByKey.set(key, binding)
  const existing = terminalScrollIntentByKey.get(key)
  if (existing) {
    terminalScrollIntentByTerminal.set(terminal, existing)
  }
  return existing
}

/**
 * 检查终端的 key 绑定是否仍然是最新的。
 * 当 key 被重新绑定到不同终端时，旧终端的绑定失效。
 */
export function isTerminalScrollIntentKeyBindingCurrent(
  terminal: TerminalScrollIntentTarget,
): boolean {
  const key = terminalScrollIntentKeyByTerminal.get(terminal)
  if (!key) {
    return true
  }
  return (
    terminalScrollIntentKeyBindingByTerminal.get(terminal) ===
    terminalScrollIntentBindingByKey.get(key)
  )
}

/**
 * 标记终端为「跟随输出」模式。
 */
export function markTerminalFollowOutput(terminal: TerminalScrollIntentTarget): void {
  writeIntent(terminal, 'followOutput')
}

/**
 * 标记终端为「固定视口」模式。
 */
export function markTerminalPinnedViewport(terminal: TerminalScrollIntentTarget): void {
  writeIntent(terminal, 'pinnedViewport')
}

/**
 * 从视口的实际滚动位置同步滚动意图。
 *
 * @param terminal 终端目标
 * @param options.allowBufferShrink - 是否允许 buffer 收缩时覆盖 pinned 意图（默认 false）
 * @param options.preservePinnedAtBottom - 固定视口在底部时是否保留意图（默认 false）
 */
export function syncTerminalScrollIntentFromViewport(
  terminal: TerminalScrollIntentTarget,
  options: { allowBufferShrink?: boolean; preservePinnedAtBottom?: boolean } = {},
): void {
  const snapshot = readTerminalScrollBufferSnapshot(terminal)
  if (!snapshot) {
    return
  }
  const existing = readStoredIntent(terminal)
  // 为什么：重新挂载/replay 的终端可能短暂报告空或更短的滚动缓存。
  // 这种瞬时状态不能擦除持久的固定视口。
  if (
    !options.allowBufferShrink &&
    existing?.kind === 'pinnedViewport' &&
    snapshot.baseY < existing.baseY
  ) {
    terminalScrollIntentByTerminal.set(terminal, existing)
    return
  }
  if (
    options.preservePinnedAtBottom &&
    existing?.kind === 'pinnedViewport' &&
    isTerminalViewportAtBottom(snapshot.viewportY, snapshot.baseY)
  ) {
    return
  }
  const kind = isTerminalViewportAtBottom(snapshot.viewportY, snapshot.baseY)
    ? 'followOutput'
    : 'pinnedViewport'
  // 为什么：parser 自动回复和反复滚轮采样经常观察到无意图变化。
  // 避免制造可能取消有效结构恢复或放大终端输出突发节奏的修订号。
  if (
    existing?.kind === kind &&
    existing.bufferType === snapshot.bufferType &&
    (kind === 'followOutput' || existing.viewportY === snapshot.viewportY)
  ) {
    if (kind === 'pinnedViewport' && existing.baseY !== snapshot.baseY) {
      // 为什么：原生固定输出可以增长 baseY 而不移动 viewportY。
      // 刷新几何数据而不创建用户意图修订号，以便后续 keyed 重装恢复相同内容，
      // 而不是陈旧底部偏移。
      Object.assign(existing, snapshot)
    }
    return
  }
  writeIntent(terminal, kind)
}

/**
 * 获取终端的滚动意图类型。
 * 如果无存储的意图，根据当前视口位置推断。
 */
export function getTerminalScrollIntentKind(
  terminal: TerminalScrollIntentTarget,
): TerminalScrollIntentKind {
  const existing = readStoredIntent(terminal)
  if (existing) {
    return existing.kind
  }
  const snapshot = readTerminalScrollBufferSnapshot(terminal)
  if (!snapshot) {
    return 'followOutput'
  }
  return isTerminalViewportAtBottom(snapshot.viewportY, snapshot.baseY)
    ? 'followOutput'
    : 'pinnedViewport'
}

/**
 * 捕获用于结构操作（buffer 重建、snapshot replay、resize）的滚动意图快照。
 * 返回 null 表示无法获取有效快照。
 */
export function captureTerminalStructuralScrollIntent(
  terminal: TerminalScrollIntentTarget,
): TerminalStructuralScrollIntentSnapshot | null {
  const snapshot = readTerminalScrollBufferSnapshot(terminal)
  if (!snapshot) {
    return null
  }
  const existing = readStoredIntent(terminal)
  let kind =
    existing?.kind ??
    (isTerminalViewportAtBottom(snapshot.viewportY, snapshot.baseY)
      ? 'followOutput'
      : 'pinnedViewport')
  // 为什么：一个固定意图但其实际视口仍在底部，这是一个幽灵钉（用户从未真正脱离视口）。
  // 在结构操作后恢复它会将终端冻结在陈旧的行上。
  // 仅在滚动缓存至少和钉一样长时才信任底部判断——更短的是清空后等待 replay 的 buffer。
  if (
    kind === 'pinnedViewport' &&
    isTerminalViewportAtBottom(snapshot.viewportY, snapshot.baseY) &&
    (!existing || snapshot.baseY >= existing.baseY)
  ) {
    kind = 'followOutput'
  }
  // 为什么：keyed 重装在 replay 前从 0/0 开始。保留重装前的持久坐标，
  // 否则底部偏移恢复会静默丢失钉。
  const capturedCoordinates =
    existing?.kind === 'pinnedViewport' && snapshot.baseY < existing.baseY
      ? existing
      : snapshot
  return {
    ...capturedCoordinates,
    kind,
    revision: existing?.revision ?? 0,
  }
}

/**
 * 检查结构快照是否仍为当前（未被后续意图更新失效）。
 */
export function isTerminalStructuralScrollIntentCurrent(
  terminal: TerminalScrollIntentTarget,
  snapshot: TerminalStructuralScrollIntentSnapshot | null,
): boolean {
  if (!snapshot) {
    return false
  }
  return (readStoredIntent(terminal)?.revision ?? 0) === snapshot.revision
}

/**
 * 从结构快照恢复滚动意图。
 *
 * @param terminal 终端目标
 * @param snapshot 之前捕获的结构快照
 * @param options.restoreBy - 恢复方式：'viewportLine'（绝对行号）| 'bottomOffset'（距底部偏移）
 */
export function restoreTerminalStructuralScrollIntent(
  terminal: TerminalScrollIntentTarget,
  snapshot: TerminalStructuralScrollIntentSnapshot | null,
  options: TerminalScrollIntentEnforceOptions = {},
): void {
  if (!snapshot || !isTerminalStructuralScrollIntentCurrent(terminal, snapshot)) {
    return
  }
  const current = readTerminalScrollBufferSnapshot(terminal)
  if (!current || current.bufferType !== snapshot.bufferType) {
    return
  }
  if (snapshot.kind === 'followOutput') {
    if (safeTerminalScrollCall(() => terminal.scrollToBottom?.())) {
      writeIntent(terminal, 'followOutput')
    }
    return
  }
  const requestedY =
    options.restoreBy === 'bottomOffset'
      ? current.baseY - Math.max(0, snapshot.baseY - snapshot.viewportY)
      : snapshot.viewportY
  const targetY = clampTerminalViewportY(requestedY, current.baseY)
  if (current.viewportY !== targetY) {
    if (!safeTerminalScrollCall(() => terminal.scrollToLine?.(targetY))) {
      // 为什么：渲染器拆卸可能在 xterm 更改其原生视口前拒绝滚动；
      // 保持预期的钉用于下一次 fit/retry，而不是锁定瞬态当前底部。
      writeIntentSnapshot(terminal, 'pinnedViewport', {
        bufferType: current.bufferType,
        viewportY: targetY,
        baseY: current.baseY,
      })
      return
    }
  }
  const existing = readStoredIntent(terminal)
  // 为什么：滚动缓存在重建时比存储的钉短；从中重新锁定会
  // 用清空 buffer 的行 0 覆盖持久行。
  if (existing?.kind === 'pinnedViewport' && current.baseY < existing.baseY) {
    return
  }
  writeIntent(terminal, 'pinnedViewport')
}

/**
 * 强制执行终端当前的滚动意图。
 * 读取已存储的意图或即时捕获，然后恢复之。
 */
export function enforceTerminalCurrentScrollIntent(
  terminal: TerminalScrollIntentTarget,
): void {
  const existing = readStoredIntent(terminal)
  if (!existing) {
    restoreTerminalStructuralScrollIntent(
      terminal,
      captureTerminalStructuralScrollIntent(terminal),
    )
    return
  }
  const snapshot: TerminalStructuralScrollIntentSnapshot = {
    kind: existing.kind,
    bufferType: existing.bufferType,
    viewportY: existing.viewportY,
    baseY: existing.baseY,
    revision: existing.revision,
  }
  if (
    snapshot.kind === 'pinnedViewport' &&
    isTerminalViewportAtBottom(snapshot.viewportY, snapshot.baseY)
  ) {
    // 为什么：记录在底部的钉意味着视口从未脱离；恢复时必须跟随输出，
    // 而不是冻结在那个陈旧的行。
    snapshot.kind = 'followOutput'
  }
  const current = readTerminalScrollBufferSnapshot(terminal)
  // 为什么：实时 buffer 比存储的意图短意味着 buffer 被重建（snapshot replay/remount）；
  // 此时绝对行号已重新编号。
  const restoreBy =
    snapshot.kind === 'pinnedViewport' && current && current.baseY < snapshot.baseY
      ? 'bottomOffset'
      : 'viewportLine'
  restoreTerminalStructuralScrollIntent(terminal, snapshot, { restoreBy })
}
