# 终端渲染层重构：模块化解耦或 ca 终端基础设施移植

## Problem Statement

当前 `XtermTerminal.ts` 是一个约 1800 行的单体类，承担了从 xterm 初始化、addon 管理、数据流管道、滚动管理、WebGL 渲染器、resize 防抖、键盘快捷键、拖拽文件、Shell Integration 命令解析、链接检测、光标/主题/字号热更新等全部职责。这种「上帝类」架构导致：

- **测试困难**：滚动捕获/恢复、输出调度、WebGL 降级等核心逻辑混合在类内部，无法独立测试
- **修改风险高**：一处改动（如 resize 逻辑）可能意外影响其他子系统（如滚动状态管理）
- **缺少关键能力**：相比 orca/VS Code 的终端实现，缺少 parse-clocked 输出调度、写管道健康监控、reflow 弹性滚动锚点等关键能力
- **背压流控不完整**：写完成回调的异常会导致 WriteBuffer 永久死锁（xterm 已知问题），当前无任何防护

## Solution

将 orca 终端中**通用（非 orca 特有）**的基础设施模块移植到 pi-desktop，形成 `lib/terminal/` 模块集。每个模块有单一职责、可独立测试，并通过组合方式重构 `XtermTerminal`。

核心原则：
- 只移植通用终端基础设施，不移植 orca 特有功能（runtime SSH、worktree 集成、native chat、mobile driver 等）
- 保持现有 IPC 架构（`TerminalChannel` 抽象）和 React 组件层（`IntegratedPane`）不变
- 保持与 VS Code 对齐的背压流控设计（`BackpressureController` + `AckDataBufferer`）
- 尽可能复用现有测试桩（`@xterm/addon-webgl` mock、`PiApi` mock）

## User Stories

1. 作为终端渲染层开发者，我希望输出调度器能按背景/前台优先级排队写入，以便隐藏终端的大量输出不阻塞可见终端的渲染
2. 作为终端渲染层开发者，我希望输出调度器有 backlog 上限，以便隐藏终端在长时间输出后不会耗尽内存
3. 作为终端渲染层开发者，我希望写管道健康监控能检测 xterm WriteBuffer 死锁，以便在写管道永久阻塞时触发恢复
4. 作为终端渲染层开发者，我希望写完成回调有异常守卫，以便单个回调的同步 throw 不会永久冻结整个管道的写入
5. 作为终端用户，我希望 resize 窗口时滚动位置不丢失，以便 resize 后不需要重新滚动到之前的阅读位置
6. 作为终端用户，我希望在 reflow（列宽变化导致内容重排）后滚动位置保持准确，以便 resize 后视口不跳转到错误位置
7. 作为终端用户，我希望 WebGL 渲染器上下文丢失后自动降级为 DOM 渲染器，以便终端不因 GPU 问题而白屏
8. 作为终端用户，我希望 WebGL 渲染器的选择策略（auto/on/off）能智能判断，以便在 GPU 不可用时自动回退为 DOM 渲染器
9. 作为终端渲染层开发者，我希望滚动意图（followOutput vs pinnedViewport）能被显式跟踪，以便在输出写入和 resize 时做出正确的滚动恢复决策
10. 作为终端渲染层开发者，我希望 ACK 信用能在 pane 销毁时正确丢弃，以便主进程的背压窗口不会因未完成的写回调而泄漏
11. 作为终端渲染层开发者，我希望 xterm 渲染暂停状态能被强制穿透，以便在 tab 切换后终端能立即渲染而非等待 IntersectionObserver 回调
12. 作为终端渲染层开发者，我希望 xterm 实例销毁状态能被可靠探测，以便在已销毁的实例上写入不会静默丢失回调
13. 作为终端用户，我希望 resize 后滚动条能正确同步，以便滚动条 thumb 位置与视口内容一致
14. 作为终端渲染层开发者，我希望每个模块都有独立的单元测试，以便在修改时能快速定位回归

## Implementation Decisions

### 1. 模块拆分与目录结构

新增 `src/renderer/src/lib/terminal/` 目录，包含以下模块。每个模块一个文件，单一导出。

### 2. 模块设计

#### 2.1 `scroll-buffer-snapshot.ts` — 滚动缓冲快照

从 xterm `Terminal.buffer.active` 读取当前视口状态。纯函数，无状态。

```typescript
export type TerminalScrollBufferType = 'normal' | 'alternate'

export interface TerminalScrollBufferSnapshot {
  bufferType: TerminalScrollBufferType
  viewportY: number
  baseY: number
}

export function readTerminalScrollBufferSnapshot(
  terminal: TerminalScrollBufferTarget
): TerminalScrollBufferSnapshot | null

export function isTerminalViewportAtBottom(viewportY: number, baseY: number): boolean

export function clampTerminalViewportY(viewportY: number, baseY: number): number
```

#### 2.2 `instance-disposed.ts` — 实例销毁探针

通过 `_core._store._isDisposed` 探针检测 xterm 实例是否已销毁。封装对 xterm 内部字段的访问，升级时退化。

```typescript
export function isXtermInstanceDisposed(terminal: unknown): boolean
```

#### 2.3 `write-callback-guard.ts` — 写完成回调守卫

在 `try/catch` 中执行写完成回调的每一步，防止同步 throw 冻结 xterm 的 WriteBuffer。

```typescript
export function runGuardedWriteCompletionStep(context: string, step: () => void): void
```

#### 2.4 `ack-credit.ts` — ACK 信用追踪

追踪已提交给 xterm 但尚未解析的写 ACK 信用。pane 销毁时丢弃所有飞行中信用，防止主进程背压窗口泄漏。

```typescript
export function registerTerminalOutputAckCredits(
  terminal: object,
  credits: readonly (() => void)[]
): (() => void) | undefined

export function discardInFlightTerminalOutputAckCredits(terminal: object): void
```

#### 2.5 `scrollbar-sync.ts` — 滚动条同步

在 resize 后通过 ±1 行微调强制 xterm 滚动条 thumb 同步。

```typescript
export function forceTerminalViewportScrollbarSync(terminal: Terminal): void
```

#### 2.6 `render-pause-release.ts` — 渲染暂停穿透

当 xterm 的 RenderService 因 IntersectionObserver 滞后而处于暂停状态时，强制一次同步全视口重绘。

```typescript
export function forceRepaintThroughRenderPause(terminal: unknown): boolean
```

#### 2.7 `scroll-intent.ts` — 滚动意图跟踪

跟踪终端视口的滚动意图：`followOutput`（跟随最新输出）或 `pinnedViewport`（用户已上滚查看历史）。意图在写前捕获、写后或 resize 后恢复。支持按 key 绑定/解绑意图，允许跨 pane 生命周期保持。

```typescript
export type TerminalScrollIntentKind = 'followOutput' | 'pinnedViewport'

export interface TerminalStructuralScrollIntentSnapshot {
  kind: TerminalScrollIntentKind
  bufferType: TerminalScrollBufferType
  viewportY: number
  baseY: number
  revision: number
}

export function captureTerminalStructuralScrollIntent(
  terminal: TerminalScrollIntentTarget
): TerminalStructuralScrollIntentSnapshot | null

export function isTerminalStructuralScrollIntentCurrent(
  terminal: TerminalScrollIntentTarget,
  intent: TerminalStructuralScrollIntentSnapshot | null
): boolean

export function restoreTerminalStructuralScrollIntent(
  terminal: TerminalScrollIntentTarget,
  intent: TerminalStructuralScrollIntentSnapshot | null
): void

export function bindTerminalScrollIntentKey(
  terminal: TerminalScrollIntentTarget,
  key: string | undefined
): TerminalScrollIntent | undefined

export function markTerminalViewportAtBottom(terminal: TerminalScrollIntentTarget): void
export function markTerminalPinnedViewport(terminal: TerminalScrollIntentTarget): void
```

#### 2.8 `reflow-scroll-anchor.ts` — Reflow 滚动锚点

在 resize（列宽变化）时，从视口顶行回溯到逻辑行首，记录逻辑行号和 cell 偏移。reflow 后从锚点重新定位视口，使 reflow 后视口内容不漂移。

```typescript
export function captureLogicalLineAnchor(
  terminal: Terminal,
  viewportY: number
): { cellOffset: number; lineY: number } | undefined

export function resolveLogicalCellOffsetLine(
  terminal: Terminal,
  logicalStartY: number,
  cellOffset: number
): number
```

#### 2.9 `scroll.ts` — 滚动管理

使用 xterm marker 捕获和恢复滚动位置。支持 deferred restore（在 fit 完成后恢复）和 pending fit scroll restore（在后续 fit 中恢复）。

```typescript
export interface ScrollState {
  bufferType: 'normal' | 'alternate'
  wasAtBottom: boolean
  viewportY: number
  baseY: number
  firstVisibleLineMarker?: IMarker | null
  firstVisibleLogicalLineMarker?: IMarker | null
  firstVisibleLogicalCellOffset?: number
}

export function captureScrollState(terminal: Terminal): ScrollState
export function restoreScrollState(terminal: Terminal, state: ScrollState): boolean
export function restoreScrollStateAfterFit(
  terminal: Terminal,
  state: ScrollState,
  options: { onRestored?: () => void; shouldRestore?: () => boolean }
): void
export function cancelDeferredScrollRestore(terminal: object): void
export function releaseScrollStateMarker(state: ScrollState): void
```

#### 2.10 `webgl-auto-policy.ts` — WebGL 自动决策

智能判断是否启用 WebGL 渲染器。考虑 GPU 加速设置（auto/on/off）、历史失败记录、系统信息。

```typescript
export interface TerminalWebglAutoDecision {
  allowWebgl: boolean
  reason?: string
}

export function getTerminalWebglAutoDecision(): TerminalWebglAutoDecision
export function resetTerminalWebglAutoDecision(): void
```

#### 2.11 `webgl.ts` — WebGL 渲染器管理

WebGL addon 的 attach、dispose 和上下文恢复。支持 `auto`/`on`/`off` 三种 GPU 加速策略。

```typescript
export function attachWebgl(
  pane: ManagedPaneInternal,
  options?: { force?: boolean }
): boolean

export function disposeWebgl(
  pane: ManagedPaneInternal,
  options?: { refreshDimensions?: boolean }
): void

export function cancelPendingWebglRefresh(pane: ManagedPaneInternal): void
export function clearTerminalWebglAttachBackoff(): void
export function resetTerminalWebglSuggestion(): void
```

#### 2.12 `fit.ts` — Safe fit 带滚动保持

在 fit 操作前后捕获和恢复滚动位置，确保 resize 不丢失视口位置。支持最小尺寸守卫（防止 0 尺寸 fit 导致异常）和 mobile fit override。

```typescript
export function safeFit(
  pane: ManagedPane,
  options?: { preserveScroll?: boolean }
): boolean

export function safeFitAndThen(
  pane: ManagedPane,
  operationKey: string,
  continuation: () => void
): SafeFitContinuationHandle

export function cancelPendingSafeFitContinuations(pane: ManagedPane): void
```

#### 2.13 `write-pipeline-health.ts` — 写管道健康监控

监控 xterm 写管道的健康状态。如果写完成回调在超时（10s）后仍未触发，发送 probe 写确认管道是否死锁。支持注册不可送达写处理器，触发 pane 恢复。

```typescript
export type UndeliverableWriteReason = 'write-stalled' | 'replay-wedged'

export function registerUndeliverableWriteHandler(
  terminal: object,
  handler: (reason: UndeliverableWriteReason) => void
): () => void

export function recordTerminalParseProgress(terminal: object): void
export function captureTerminalParseProgressGeneration(terminal: object): number
export function hasTerminalParseProgressSince(terminal: object, generation: number): boolean

export function armTerminalWriteStallWatch(
  terminal: object,
  onCertifiedDead?: () => void
): void

export function cancelTerminalWriteStallWatch(terminal: object): void
export function settleTerminalWriteStallWatch(terminal: object): void
export function isTerminalWritePipelineCertifiedDead(terminal: object): boolean
```

#### 2.14 `output-scheduler.ts` — 输出队列调度器

基于优先级的终端输出写调度器。核心能力：

- **前台/后台优先级**：可见终端的输出高优先级写入，隐藏终端的输出低优先级
- **Parse-clocked drain**：每次 drain 在 xterm 解析完成后才触发下一次，避免写队列无限增长
- **Backlog 上限**：后台队列超过上限时丢弃旧数据，防止隐藏终端耗尽内存
- **前台 coalesce**：前台输出在 1s 内 coalesce 合并，减少帧数
- **ACK 信用集成**：每个写入段携带 ACK 信用，解析后释放

```typescript
export function writeTerminalOutput(
  terminal: TerminalOutputTarget,
  data: string,
  options?: WriteTerminalOutputOptions
): void

export function configureTerminalOutputBacklogCap(scrollbackRows: number): void
export function drainQueuedOutput(): void
export function discardQueuedOutput(terminal: TerminalOutputTarget): void
export function getTerminalOutputSchedulerDebugSnapshot(): SchedulerDebugSnapshot
```

### 3. 重构 `XtermTerminal.ts`

`XtermTerminal` 类改为使用上述模块的组合，而非内联实现：

| 当前内联逻辑 | 替换为 |
|-------------|--------|
| `captureScrollState()` | `scroll.ts` 的 `captureScrollState()` |
| `restoreScrollState()` | `scroll.ts` 的 `restoreScrollState()` |
| `_resizeBoth`/`_resizeX`/`_resizeY` 中的滚动保存 | `fit.ts` 的 `safeFit()` |
| `_writeProcessData` 中的写回调 | `write-callback-guard.ts` 的 `runGuardedWriteCompletionStep()` |
| `enableWebgl()` 中的 WebGL 决策 | `webgl-auto-policy.ts` + `webgl.ts` |
| `setActive` 中的强制 refresh | `render-pause-release.ts` 的 `forceRepaintThroughRenderPause()` |
| `unmount` 中的 ACK 清理 | `ack-credit.ts` 的 `discardInFlightTerminalOutputAckCredits()` |
| `resize` 回调中的滚动保存 | `scroll.ts` + `scrollbar-sync.ts` |
| `mount` 中的 addon 加载 | `webgl.ts` 的 `attachWebgl()` + 现有 addon 加载逻辑 |

### 4. 保持不变的接口

以下接口和模块在重构中保持不变：

- **`TerminalChannel`**（`terminalChannel.ts`）— IPC 抽象
- **`AckDataBufferer`**（`ackDataBufferer.ts`）— ACK 累积缓冲
- **`TerminalResizeDebouncer`**（`terminalResizeDebouncer.ts`）— resize 分轴防抖（可后续替换为 scheduler 集成）
- **`IntegratedPane`**（`IntegratedPane.tsx`）— React 壳
- **`paneManager.ts`** — 实例注册表（仅需适配 `XtermTerminal` 的新接口）
- **`BackpressureController`**（`main/backpressure.ts`）— 主进程背压控制
- **`UnifiedTerminalPool`**（`main/unifiedTerminalPool.ts`）— PTY 池

## Testing Decisions

### 测试哲学

- **只测外部行为，不测实现细节**：测试模块的公开接口，不测试内部状态或私有方法
- **优先使用 mock 隔离**：用 `@xterm/xterm` 的 mock 替代真实 xterm 实例（jsdom 无真实 canvas/GPU）
- **每个模块独立测试**：不依赖其他模块的内部状态
- **现有测试继续通过**：重构不改变 `XtermTerminal` 的公开接口签名

### 测试模块

| 模块 | 测试策略 | 现有先例 |
|------|---------|---------|
| `scroll-buffer-snapshot` | 用 mock xterm buffer 验证快照读取 | `XtermTerminal.test.ts` 中的 mock |
| `instance-disposed` | 用 mock 对象验证 disposed 探针 | 无，新模块 |
| `write-callback-guard` | 验证 throw 被捕获，后续步骤继续执行 | 无，新模块 |
| `ack-credit` | 验证 credit 注册/触发/丢弃 | `ackDataBufferer.test.ts` |
| `scrollbar-sync` | 验证 scrollLines 调用次数 | 无，新模块 |
| `render-pause-release` | 验证 `_isPaused` 状态清除和 `refreshRows` 调用 | 无，新模块 |
| `scroll-intent` | 验证 intent 捕获/恢复/绑定 | orca `terminal-scroll-intent.test.ts` |
| `reflow-scroll-anchor` | 验证逻辑行锚点捕获和解析 | 无，新模块 |
| `scroll` | 验证 marker 基滚动捕获/恢复/超时 | orca `pane-scroll.test.ts` |
| `webgl-auto-policy` | 验证不同 GPU 设置下的决策 | 无，新模块 |
| `fit` | 验证 fit 调用和 scroll 保持 | 无，新模块 |
| `write-pipeline-health` | 验证 stall 检测和 probe 写 | orca `terminal-write-pipeline-health.test.ts` |
| `output-scheduler` | 验证队列调度/优先级/backlog 上限/ACK 集成 | orca `pane-terminal-output-scheduler.test.ts` |
| `XtermTerminal`（重构后） | 验证公开接口行为不变，集成新模块 | 现有 `XtermTerminal.test.ts` |

### 测试 seam

最高 seam：**模块级单元测试**（vitest + jsdom）。每个模块独立测试，不依赖 React 组件渲染。

次级 seam：**`XtermTerminal` 集成测试**（现有测试文件）。验证重构后公开接口行为不变。

## Out of Scope

- **分屏面板管理器**（orca 的 `PaneManager` 类）：不移植，pi-desktop 当前无分屏需求
- **SSH 远程终端**：不涉及
- **Mobile driver overlay**：orca 特有
- **Floating terminal**：orca 特有
- **Activity terminal portals**：orca 特有
- **Native chat 集成**：orca 特有
- **Worktree 集成**：orca 特有
- **Agent session fork dialog**：orca 特有
- **Kitty 键盘协议**：暂不移植，未来需要时补充
- **连字（ligatures）addon**：暂不移植，xterm 6.0 已支持 `customGlyphs`
- **终端设置面板**：不涉及
- **I18n**：不涉及

## Further Notes

### 实施顺序

1. **Phase 1 — 基础设施层**（无侵入，先建独立模块）
   - `scroll-buffer-snapshot.ts`
   - `instance-disposed.ts`
   - `write-callback-guard.ts`
   - `ack-credit.ts`
   - `scrollbar-sync.ts`
   - `render-pause-release.ts`
   - 每个模块附带完整测试

2. **Phase 2 — 核心能力层**（依赖 Phase 1）
   - `scroll-intent.ts`
   - `reflow-scroll-anchor.ts`
   - `scroll.ts`
   - `webgl-auto-policy.ts`
   - `webgl.ts`
   - `fit.ts`
   - 每个模块附带完整测试

3. **Phase 3 — 输出调度层**（依赖 Phase 1+2）
   - `write-pipeline-health.ts`
   - `output-scheduler.ts`
   - 每个模块附带完整测试

4. **Phase 4 — 集成重构**
   - 重构 `XtermTerminal.ts` 使用新模块
   - 更新 `paneManager.ts`（如有必要）
   - 更新现有测试
   - 端到端验证

### 风险

- **Output Scheduler 的引入可能改变现有数据流时序**：需要仔细验证现有终端行为不变
- **xterm 内部字段访问**（`instance-disposed.ts`、`render-pause-release.ts`）在 xterm 升级时可能失效：通过防御性 `try/catch` 和 mock 测试确保退化
- **Write Pipeline Health 的 stall watch** 可能在写负荷重时误触发：超时时间（10s）足够区分慢 vs 死

### 参考

- orca 源码：`src/renderer/src/lib/pane-manager/` 目录
- 当前背压对齐文档：`docs/plans/backpressure-alignment-vscode.md`
- VS Code 终端源码：`src/vs/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts`