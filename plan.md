# 终端渲染优化/重构计划

## 背景分析

### 核心问题

当前 pi-workbench 的终端（基于 xterm.js）在以下场景存在渲染问题：

1. **中间行挤出底部**：全屏差分渲染的终端（如 pi 扩展/agent 输出）在中间行写入内容时，视口被推离底部，用户看到底部行被"挤出"
2. **贴底不及时**：终端处于贴底（followOutput）模式时，新输出到达后视口不能稳定及时地保持在底部
3. **Tab 切换后渲染缺失**：切回已隐藏的终端 tab 时，首帧可能渲染不全（底部行空白）

---

## Orca 终端设计参考

### 架构总览

```
PTY 数据流
    │
    ▼
pty-dispatcher.ts ── 数据分发
    │
    ▼
pty-connection.ts ── PTY 连接管理（scrollback replay、eager buffer）
    │
    ▼
TerminalPane.tsx ── React 壳（布局、分栏、事件）
    │
    ├── pane-manager/ ── 分栏管理（PaneManager）
    │   ├── pane-fit.ts ── 安全 fit（滚动保护）
    │   ├── pane-scroll.ts ── 滚动捕获/恢复（IMarker 逻辑行跟踪）
    │   ├── pane-tree-ops.ts ── 分栏树操作
    │   ├── terminal-scroll-intent.ts ── 滚动意图（followOutput / pinnedViewport）
    │   ├── terminal-scroll-intent-dom-tracking.ts ── DOM 事件驱动的意图跟踪
    │   ├── terminal-scroll-intent-settle.ts ── 意图 settle（微任务+rAF+setTimeout 四重）
    │   └── terminal-scroll-buffer-snapshot.ts ── buffer 快照工具
    │
    ├── terminal-pane/ ── 终端面板功能
    │   ├── pty-transport.ts ── PTY 数据传输
    │   ├── foreground-render-settle.ts ── 前台写后渲染 settle
    │   ├── use-terminal-scroll-visibility-memory.ts ── 可见性记忆 Hook
    │   └── terminal-output-visibility.ts ── 输出内容可见性分析
    │
    └── xterm ── xterm.js 实例
```

### 核心机制一：中间行渲染不挤出底部

**原理**：写前捕获滚动意图，写后恢复。

```
写前：
  captureTerminalStructuralScrollIntent(pane.terminal)
    → 读取 viewportY / baseY / bufferType
    → 判断意图：followOutput（贴底）或 pinnedViewport（固定）
    → 如果是 pinnedViewport，额外 captureScrollState() 用 IMarker 标记逻辑行

写后：
  restoreTerminalStructuralScrollIntent(pane.terminal, snapshot)
    → followOutput → scrollToBottom()
    → pinnedViewport → scrollToLine(targetLine)
      使用 bottomOffset 恢复（buffer 重建后绝对行号改变）
```

**关键实现**：

- `pane-scroll.ts` 的 `captureScrollState` 使用 `terminal.registerMarker(offset)` 创建逻辑行标记，而非绝对行号。即使 resize 导致 reflow 重新编号，标记仍指向正确的逻辑行
- `restoreScrollStateAfterFit` 在 fit 后使用 rAF 重试机制（最多 2 帧），应对 WebGL 渲染器延迟
- `safeScrollCall` 捕获 `TypeError: dimensions` 异常（WebGL 拆卸时的常见错误），静默处理而非抛出

### 核心机制二：贴底时稳定及时贴底

**原理**：三级滚动意图跟踪系统。

```
第一级：意图状态机（scroll-intent.ts）
  followOutput（贴底）：视口在底部，新输出应自动滚动
  pinnedViewport（固定）：用户已上滚，保持当前位置

第二级：DOM 事件跟踪（scroll-intent-dom-tracking.ts）
  │ 滚轮向上 → 标记 pinnedViewport（用户上滚看历史）
  │ 滚轮向下 → 到底后自动转 followOutput
  │ 滚动条拖拽 → 标记 pinnedViewport
  │ 键盘输入（onUserInput）→ 重新同步意图
  │ 鼠标报告（SGR/X10）→ 不改变意图（防止全屏 TUI 误判）
  ▼
  意图修正 → 写回存储

第三级：Settle 确认（scroll-intent-settle.ts）
  微任务 → rAF → 双 rAF → setTimeout(80ms)
  四重确保 xterm 异步视口操作后意图正确分类
```

### 核心机制三：可见性记忆

**原理**：终端隐藏时保存滚动位置，恢复时还原。

```
Tab 切换隐藏：
  captureViewportPositions() → 保存每个 pane 的 ScrollState

Tab 恢复可见：
  applyPendingFollowOutputRequests()
    → 如果意图是 followOutput，scrollToBottom()
    → 如果是 pinnedViewport，保持原位
    → 使用双 rAF 延迟执行，确保 DOM 布局稳定
```

---

## pi-workbench 当前状态与差距

| 模块 | 当前状态 | 差距 |
|------|---------|------|
| `scroll-intent.ts` | ✅ 已实现（简化版） | 缺少 rebuild 集成 |
| `scroll-intent-dom-tracking.ts` | ✅ 已实现 | 缺少 buffer 重建后同步 |
| `scroll-intent-settle.ts` | ✅ 已实现 | 可用 |
| `scroll-intent-rebuild.ts` | ❌ 未实现 | 需要新建 |
| `scroll.ts` | ✅ 已实现（移植版） | 基本完整 |
| `fit.ts` | ✅ 已实现（简化版） | 缺少 rebuild 期间延期 fit |
| `foreground-render-settle.ts` | ✅ 已实现 | 缺少 `forceRepaintThroughRenderPause` 集成 |
| `render-pause-release.ts` | ✅ 已实现 | 未集成到写入管道 |
| `scroll-visibility-memory.ts` | ❌ 未实现 | 需要新建 |
| `output-scheduler.ts` | ✅ 已实现 | 与 foreground-render-settle 配合不够紧密 |

---

## 优化/重构计划

### 第一步：修复 RenderService 暂停状态导致的首帧渲染缺失 ⭐ P0

**问题**：tab 切换回后，xterm 的 `RenderService._isPaused` 仍为 `true`，导致 `terminal.refresh()` 被吞掉，底部行缺失。

**当前状态**：`forceRepaintThroughRenderPause` 已实现但**未集成到写入管道**。

**操作**：

1. 在 `foreground-render-settle.ts` 的 `settleForegroundRender()` 中，写后刷新前调用 `forceRepaintThroughRenderPause(terminal)`

```typescript
// foreground-render-settle.ts 修改点
function settleForegroundRender(terminal, beforeWriteViewport, options) {
  // 新增：强制穿透 RenderService 暂停状态
  forceRepaintThroughRenderPause(terminal)
  // 写后立即刷新可见行
  refreshVisibleRows(terminal, options.shouldRefreshViewportSynchronously() ?? true)
  // ...
}
```

2. 在 `XtermTerminal.ts` 的 `setActive(true)` 中，mount 后调用：

```typescript
// XtermTerminal.ts 修改点
setActive(active: boolean) {
  this.active = active
  if (active && this.term && this.opened) {
    forceRepaintThroughRenderPause(this.term)
    doResize(true)
    // 双 rAF settle 确保渲染器完全恢复
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try { this.term.refresh(0, this.term.rows - 1) } catch {}
      })
    })
  }
}
```

**涉及文件**：
- `src/renderer/src/lib/terminal/foreground-render-settle.ts`
- `src/renderer/src/components/XtermTerminal.ts`

---

### 第二步：增强写后滚动恢复的即时性和可靠性 ⭐ P0

**问题**：当前写后滚动恢复在 `onParsed` 回调中执行，高频率输出时后续写可能覆盖恢复，导致中间行挤出底部。

**操作**：

1. 在 `foreground-render-settle.ts` 的 `settleForegroundRender()` 中增加写后立即贴底逻辑：

```typescript
// foreground-render-settle.ts 修改点
function settleForegroundRender(terminal, beforeWriteViewport, options) {
  // 1. 强制穿透 RenderService 暂停
  forceRepaintThroughRenderPause(terminal)

  // 2. 写后立即刷新可见行
  refreshVisibleRows(terminal, true)

  // 3. 新增：如果视口在底部，立即 scrollToBottom 确保贴底
  if (beforeWriteViewport && isAtBottom(beforeWriteViewport)) {
    safeTerminalScrollCall(() => terminal.scrollToBottom?.())
  }

  // 4. 如果视口变化，调度 rAF settle
  if (options.followupViewportRefresh || viewportChangedDuringWrite(terminal, beforeWriteViewport)) {
    scheduleViewportSettleRefresh(terminal, true)
  }
}
```

2. `followupForegroundRefresh` 默认改为 `true`：

```typescript
// output-scheduler.ts 修改点
writeTerminalOutput(term, data, {
  foreground: true,
  latencySensitive: true,
  forceForegroundRefresh: true,    // 保持 true
  followupForegroundRefresh: true,  // 从 false 改为 true
  // ...
})
```

**涉及文件**：
- `src/renderer/src/lib/terminal/foreground-render-settle.ts`
- `src/renderer/src/lib/terminal/output-scheduler.ts`

---

### 第三步：实现 Scroll Visibility Memory（可见性记忆）⭐ P0

**问题**：当前 tab 切换时（`active` 变化），滚动位置信息丢失，切回后用户可能看到错误的行。

**操作**：

1. 新建 `src/renderer/src/lib/terminal/scroll-visibility-memory.ts`：

```typescript
/**
 * scroll-visibility-memory —— 终端可见性记忆
 *
 * 移植自 Orca 的 use-terminal-scroll-visibility-memory.ts
 *
 * ## 为什么需要
 *
 * 当终端面板被隐藏（tab 切换、工作区切换）后，将其恢复可见时：
 * - 如果之前是 followOutput（贴底），应滚动到最新输出
 * - 如果之前是 pinnedViewport（固定），应保持之前的位置
 *
 * 关键场景：全屏 TUI 程序在隐藏期间输出大量数据，
 * 恢复后应正确决定是贴底还是保持固定位置。
 */

import type { Terminal } from '@xterm/xterm'
import { captureScrollState, getTerminalOutputEpoch, type ScrollState } from './scroll'
import { getTerminalScrollIntentKind, markTerminalFollowOutput } from './scroll-intent'
import { cancelDeferredScrollRestore } from './scroll'

// ─── 类型 ──────────────────────────────────────────────────────────────────

type VisibleScrollSnapshot = {
  scrollState: ScrollState
  outputEpoch: number
}

// ─── 内部状态 ──────────────────────────────────────────────────────────────

const visibleScrollSnapshots = new Map<string, VisibleScrollSnapshot>()
const pendingFollowOutputPaneIds = new Set<string>()
let followOutputFrameIds: number[] = []

// ─── 常量 ──────────────────────────────────────────────────────────────────

const FOLLOW_OUTPUT_FLUSH_CHARS = 256 * 1024

// ─── 公开 API ──────────────────────────────────────────────────────────────

/**
 * 记住当前可见终端的滚动快照。
 * 在隐藏前调用，保存 scrollState + outputEpoch。
 */
export function rememberVisibleScrollSnapshot(
  paneKey: string,
  terminal: Terminal,
): void {
  visibleScrollSnapshots.set(paneKey, {
    scrollState: captureScrollState(terminal),
    outputEpoch: getTerminalOutputEpoch(terminal),
  })
}

/**
 * 获取所有 pane 的当前滚动位置快照。
 *
 * @param useRememberedSnapshots - true 时优先使用已保存的快照（隐藏前捕获的）
 */
export function captureViewportPositions(
  panes: { key: string; terminal: Terminal }[],
  useRememberedSnapshots: boolean,
): Map<string, ScrollState> {
  return new Map(
    panes.map(({ key, terminal }) => {
      const remembered = visibleScrollSnapshots.get(key)
      if (useRememberedSnapshots && remembered) {
        return [key, remembered.scrollState] as const
      }
      const state = captureScrollState(terminal)
      if (!useRememberedSnapshots || !remembered) {
        visibleScrollSnapshots.set(key, {
          scrollState: state,
          outputEpoch: getTerminalOutputEpoch(terminal),
        })
      }
      return [key, state] as const
    }),
  )
}

/**
 * 调度一个 pane 在可见性恢复后执行 followOutput。
 * 如果意图是 followOutput，在下一个动画帧中 scrollToBottom。
 */
export function scheduleFollowOutputIfNeeded(paneKey: string): void {
  pendingFollowOutputPaneIds.add(paneKey)
  if (followOutputFrameIds.length > 0) return

  const firstFrameId = requestAnimationFrame(() => {
    followOutputFrameIds = followOutputFrameIds.filter((id) => id !== firstFrameId)
    const secondFrameId = requestAnimationFrame(() => {
      followOutputFrameIds = followOutputFrameIds.filter((id) => id !== secondFrameId)
      applyPendingFollowOutputRequests()
    })
    followOutputFrameIds.push(secondFrameId)
  })
  followOutputFrameIds.push(firstFrameId)
}

/**
 * 执行所有挂起的 followOutput 请求。
 * 返回 true 表示至少执行了一次 scrollToBottom。
 */
export function applyPendingFollowOutputRequests(
  panes: { key: string; terminal: Terminal }[],
  isVisible: () => boolean,
): boolean {
  if (pendingFollowOutputPaneIds.size === 0) return false
  if (!isVisible()) return false

  let didScroll = false
  for (const { key, terminal } of panes) {
    if (!pendingFollowOutputPaneIds.has(key)) continue
    const previous = visibleScrollSnapshots.get(key)
    const currentEpoch = getTerminalOutputEpoch(terminal)
    const hasNewOutput = previous ? currentEpoch > previous.outputEpoch : currentEpoch > 0

    if (hasNewOutput) {
      if (getTerminalScrollIntentKind(terminal) === 'followOutput') {
        cancelDeferredScrollRestore(terminal)
        markTerminalFollowOutput(terminal)
        terminal.scrollToBottom()
        didScroll = true
      }
      visibleScrollSnapshots.set(key, {
        scrollState: captureScrollState(terminal),
        outputEpoch: currentEpoch,
      })
    }
    pendingFollowOutputPaneIds.delete(key)
  }
  return didScroll
}

/**
 * 取消挂起的 followOutput 帧。
 */
export function cancelPendingFollowOutputRequests(): void {
  for (const frameId of followOutputFrameIds) {
    cancelAnimationFrame(frameId)
  }
  followOutputFrameIds = []
  pendingFollowOutputPaneIds.clear()
}

/**
 * 清理不再存在的 pane 的记忆。
 */
export function pruneScrollSnapshots(activeKeys: Set<string>): void {
  for (const key of visibleScrollSnapshots.keys()) {
    if (!activeKeys.has(key)) {
      visibleScrollSnapshots.delete(key)
    }
  }
  for (const key of pendingFollowOutputPaneIds) {
    if (!activeKeys.has(key)) {
      pendingFollowOutputPaneIds.delete(key)
    }
  }
}
```

2. 在 `IntegratedPane.tsx` 中集成：

```typescript
// IntegratedPane.tsx 修改点
useEffect(() => {
  if (!hostRef.current) return

  // 终端可见：恢复时应用 followOutput
  if (active) {
    scheduleFollowOutputIfNeeded(terminalId)
  }
}, [active, terminalId])

// 在 active 切换前保存滚动快照
// 在 CenterPane 或父组件中，切换 activeCwd 前调用
```

3. 创建配套的 `src/renderer/src/lib/terminal/__tests__/scroll-visibility-memory.test.ts`

**涉及文件**：
- `src/renderer/src/lib/terminal/scroll-visibility-memory.ts`（新文件）
- `src/renderer/src/components/IntegratedPane.tsx`
- `src/renderer/src/components/SessionPane.tsx`

---

### 第四步：增强 Scroll Intent 的 DOM 跟踪器 ⭐ P1

**问题**：当前 `attachTerminalScrollIntentTracking` 已实现，但缺少 buffer 重建后的同步机制。

**操作**：

1. 新建 `src/renderer/src/lib/terminal/scroll-intent-rebuild.ts`（移植 Orca 的 `terminal-scroll-intent-rebuild.ts`）：

```typescript
/**
 * scroll-intent-rebuild —— 滚动意图 buffer 重建协调
 *
 * 移植自 Orca 的 terminal-scroll-intent-rebuild.ts
 *
 * ## 为什么需要
 *
 * 当终端的 buffer 被重建（snapshot replay、scrollback restore、eager buffer flush）时：
 * - 旧 buffer 的绝对行号全部失效
 * - 正在进行的 fit 操作应延期到重建完成
 * - 重建完成后应恢复滚动意图
 */

import type { Terminal } from '@xterm/xterm'

// ─── 类型 ──────────────────────────────────────────────────────────────────

type RebuildState = {
  inFlight: boolean
  completeCallbacks: ((completed: boolean) => void)[]
  pendingFitOperations: (() => void)[]
}

// ─── 内部状态 ──────────────────────────────────────────────────────────────

const rebuildStates = new WeakMap<object, RebuildState>()

// ─── 公开 API ──────────────────────────────────────────────────────────────

/**
 * 标记 buffer 重建开始。
 * 期间 fit 操作将被延期。
 */
export function beginTerminalScrollIntentBufferRebuild(terminal: object): void {
  rebuildStates.set(terminal, {
    inFlight: true,
    completeCallbacks: [],
    pendingFitOperations: [],
  })
}

/**
 * 标记 buffer 重建完成。
 * 执行所有挂起的完成回调和 fit 操作。
 */
export function endTerminalScrollIntentBufferRebuild(
  terminal: object,
  completed: boolean,
): void {
  const state = rebuildStates.get(terminal)
  if (!state) return

  state.inFlight = false
  rebuildStates.delete(terminal)

  // 执行延期的 fit 操作
  for (const fit of state.pendingFitOperations) {
    try { fit() } catch { /* 忽略 */ }
  }

  // 通知完成回调
  for (const cb of state.completeCallbacks) {
    try { cb(completed) } catch { /* 忽略 */ }
  }
}

/**
 * 检查是否正在进行 buffer 重建。
 */
export function isTerminalScrollIntentRebuildInFlight(terminal: object): boolean {
  return rebuildStates.get(terminal)?.inFlight === true
}

/**
 * 在重建期间延期一个几何操作（如 fit）。
 * 返回 true 表示操作被延期，false 表示立即执行。
 */
export function deferTerminalGeometryMutationDuringRebuild(
  terminal: object,
  label: string,
  fn: () => void,
): boolean {
  const state = rebuildStates.get(terminal)
  if (!state?.inFlight) return false

  state.pendingFitOperations.push(fn)
  return true
}

/**
 * 注册 buffer 重建完成回调。
 * 如果不在重建中，立即执行回调。
 * 返回取消函数。
 */
export function onTerminalScrollIntentBufferRebuildComplete(
  terminal: object,
  callback: (completed: boolean) => void,
): () => void {
  const state = rebuildStates.get(terminal)
  if (!state?.inFlight) {
    // 不在重建中，立即执行
    try { callback(true) } catch { /* 忽略 */ }
    return () => {}
  }

  state.completeCallbacks.push(callback)
  return () => {
    const index = state.completeCallbacks.indexOf(callback)
    if (index >= 0) {
      state.completeCallbacks.splice(index, 1)
    }
  }
}
```

2. 在 `scroll-intent-dom-tracking.ts` 中集成重建完成同步：

```typescript
// scroll-intent-dom-tracking.ts 修改点
import {
  onTerminalScrollIntentBufferRebuildComplete,
  isTerminalScrollIntentRebuildInFlight,
} from './scroll-intent-rebuild'

// 在 attachTerminalScrollIntentTracking 中添加：
let cancelPostRebuildSync: (() => void) | null = null

// 在 wheel/scroll 事件处理中：
function syncFromViewportOrAfterRebuild(mode: 'sample' | 'preservePinnedAtBottom'): boolean {
  if (!isTerminalScrollIntentRebuildInFlight(terminal)) {
    syncTerminalScrollIntentFromViewport(terminal, { allowBufferShrink: true })
    return true
  }
  // 重建中：注册完成回调，重建后同步
  cancelPostRebuildSync = onTerminalScrollIntentBufferRebuildComplete(terminal, (completed) => {
    cancelPostRebuildSync = null
    if (completed && isActive()) {
      syncTerminalScrollIntentFromViewport(terminal, { allowBufferShrink: true })
    }
  })
  return false
}
```

3. 在 `fit.ts` 中集成延期逻辑：

```typescript
// fit.ts 修改点
import { deferTerminalGeometryMutationDuringRebuild } from './scroll-intent-rebuild'

function performSafeFit(pane: ManagedPane, preserveScroll: boolean): boolean {
  // 新增：重建期间延期 fit
  if (deferTerminalGeometryMutationDuringRebuild(pane.terminal, 'safe-fit', () => {
    safeFit(pane)
  })) {
    return false
  }
  // ... 原有逻辑
}
```

**涉及文件**：
- `src/renderer/src/lib/terminal/scroll-intent-rebuild.ts`（新文件）
- `src/renderer/src/lib/terminal/scroll-intent-dom-tracking.ts`
- `src/renderer/src/lib/terminal/fit.ts`

---

### 第五步：重构输出调度器，集成渲染 settle 和滚动意图 ⭐ P2

**问题**：当前 `output-scheduler.ts` 的 `writeTerminalOutput` 和 `foreground-render-settle.ts` 是两个独立模块，配合不够紧密。

**操作**：

1. 将 `foreground-render-settle` 的 settle 逻辑内联到 `output-scheduler` 的 foreground 写入路径

2. `writeTerminalOutput` 在 foreground 模式下：
   - 写前：捕获滚动意图 + 视口快照
   - 写后：`forceRepaintThroughRenderPause` → `refreshVisibleRows` → 恢复滚动 → 同步意图
   - 始终调度一次 rAF settle

```typescript
// output-scheduler.ts 修改点
function processForegroundChunk(terminal, chunk): void {
  const beforeSnapshot = captureViewportSnapshot(terminal)
  const scrollIntent = captureTerminalStructuralScrollIntent(terminal)

  writeForegroundTerminalChunk(terminal, chunk.data, {
    forceViewportRefresh: true,
    followupViewportRefresh: true,
    onParsed: () => {
      // 写后恢复滚动意图
      restoreTerminalStructuralScrollIntent(terminal, scrollIntent)
      syncTerminalScrollIntentFromViewport(terminal)
      chunk.onParsed?.()
    },
  })
}
```

**涉及文件**：
- `src/renderer/src/lib/terminal/output-scheduler.ts`
- `src/renderer/src/lib/terminal/foreground-render-settle.ts`

---

### 第六步：集成测试覆盖 ⭐ P2

**操作**：

1. 为 `foreground-render-settle.ts` 补充测试（`render-pause-release.test.ts` 已存在，需扩展）
2. 为 `scroll-visibility-memory.ts` 编写测试
3. 为 `scroll-intent-rebuild.ts` 编写测试

**涉及文件**：
- `src/renderer/src/lib/terminal/__tests__/foreground-render-settle.test.ts`（扩展）
- `src/renderer/src/lib/terminal/__tests__/scroll-visibility-memory.test.ts`（新建）
- `src/renderer/src/lib/terminal/__tests__/scroll-intent-rebuild.test.ts`（新建）

---

## 执行优先级

| 步骤 | 优先级 | 预估工时 | 预期效果 |
|------|--------|---------|----------|
| 第一步：RenderService 暂停修复 | P0 | 2h | 修复 tab 切换回后底部行缺失 |
| 第二步：写后滚动恢复增强 | P0 | 3h | 修复中间行挤出底部、贴底不及时 |
| 第三步：可见性记忆 | P0 | 4h | 修复 tab 切换回后滚动位置错误 |
| 第四步：DOM 跟踪器增强 | P1 | 3h | 减少滚动意图误判 |
| 第五步：Buffer 重建协调 | P1 | 3h | 防止重建期间 fit 异常 |
| 第六步：调度器重构 | P2 | 4h | 架构优化，代码可维护性提升 |
| 第七步：测试覆盖 | P2 | 3h | 回归保障 |

**总计预估工时**：约 22h（含测试）

---

## 关键文件依赖图

```
IntegratedPane.tsx / SessionPane.tsx
    │
    ├── paneManager.ts ────────────────── 终端实例注册表
    │       │
    │       └── XtermTerminal.ts ──────── xterm 封装
    │               │
    │               ├── output-scheduler.ts ── 写入调度器
    │               │       │
    │               │       └── foreground-render-settle.ts ── 前台渲染 settle  ← 第一步
    │               │               │
    │               │               └── render-pause-release.ts ── 暂停恢复     ← 第一步
    │               │
    │               ├── fit.ts ──────────────── 安全 fit                      ← 第五步
    │               │       │
    │               │       └── scroll-intent-rebuild.ts ── 重建协调           ← 第五步
    │               │
    │               ├── scroll.ts ───────────── 滚动捕获/恢复
    │               │
    │               ├── scroll-intent.ts ────── 滚动意图状态机
    │               │       │
    │               │       └── scroll-intent-rebuild.ts ── 重建协调           ← 第四步
    │               │       └── scroll-intent-dom-tracking.ts ── DOM 跟踪      ← 第四步
    │               │       └── scroll-intent-settle.ts ── 意图 settle
    │               │
    │               └── scroll-visibility-memory.ts ── 可见性记忆              ← 第三步
    │
    └── scroll-buffer-snapshot.ts ──── buffer 快照工具（共享）
```