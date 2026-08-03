# 终端渲染/写入/滚动系统优化方案

> 基于实际代码分析，非注释推测。

---

## 一、现状诊断（基于实际代码）

### 1.1 滚动系统

**当前实现（`scroll.ts` + `XtermTerminal.ts`）：**

`scroll.ts` 提供的是**单次快照模式**的 capture/restore：

- `captureScrollState()`：创建 IMarker 快照（含物理标记 + 逻辑行标记）
- `restoreScrollState()`：恢复位置后立即 `releaseScrollStateMarker()` 销毁标记
- 实际调用点（`XtermTerminal.ts`）：
  - `_writeProcessData` / `_writeProcessDataUnsafe`：写前 capture → 写回调中 restore
  - `_resizeBoth` / `_resizeX` / `_resizeY`：resize 前 capture → resize 后 restore

**缺失的关键能力：**

1. **无持久化滚动意图**：`scroll.ts` 的标记在每次 restore 后立即释放，只有 `followOutput`（贴底）一种行为模式。没有 `pinnedViewport`（用户上滚看历史）的概念，没有 revision 版本号防止晚到的 restore 覆盖新状态。

2. **无 DOM 事件跟踪**：`XtermTerminal.ts` 的 `wheelHandler`（第 1368 行）只做 `MouseWheelClassifier` 平滑滚动分类，不更新滚动意图。`onScroll`（第 1304 行）只驱动浮钮显隐，不跟踪意图。

3. **无 buffer 重建保护**：`resetSameFrame()`（第 585 行）直接 `term.write('\x1bc')` 清屏，但清屏后已有 marker 全部失效。后续 `restoreScrollback` 写入的数据恢复时，`scroll.ts` 的 restore 只能回退到绝对行号，但 buffer 已被清空，行号对不上。

### 1.2 渲染系统

**当前实现（`XtermTerminal.ts`）：**

```typescript
// 第 1474-1520 行：enableWebgl()
private enableWebgl(): void {
  if (!term || this.rendererLocked) return;       // ① 永久锁定
  if (this.webglAttachFailed) {                    // ② 失败后永久锁定
    this.rendererLocked = true;
    return;
  }
  this.rendererLocked = true;                      // ③ 成功后也永久锁定
  
  // ... 尝试创建 WebglAddon ...
  
  addon.onContextLoss(() => {                      // ④ 上下文丢失后降级，永不重建
    this.webglContextLost = true;
    this.webgl?.dispose();
    this.webgl = null;
  });
}
catch (e) {
  this.webglAttachFailed = true;                   // ⑤ 附加失败 latch
}
```

**问题：**
- `rendererLocked` 一旦为 `true`，整个会话内永远不会再次调用 `enableWebgl()`
- `webglAttachFailed` 一旦为 `true`，整个会话内不会再尝试
- `webglContextLost` 只在 `unmount()` 时重置（第 467 行），但 unmount 后实例已销毁
- 无 WebGL 上下文显式释放（`WEBGL_lose_context` 未调用）

### 1.3 写入管道

**当前实现（`XtermTerminal.ts`）：**

```
channel.onData → handleProcessData → _segmentByShellIntegration
  → _writeProcessData / _writeProcessDataUnsafe → term.write()
```

**关键发现：**
- `output-scheduler.ts` 虽然存在（有 `writeTerminalOutput` 公共 API），但 `XtermTerminal.ts` **仅导入** `configureTerminalOutputBacklogCap`（配置函数），**不调用** `writeTerminalOutput`。实际写入走的是直接的 `term.write()` 路径。
- 渲染端无二次聚合：每个 IPC 消息直接触发一次 `term.write()` 调用。
- 无 Parse-Clock Pacer 机制：后台写入依赖固定定时器，不能以 xterm 解析速度推进。

---

## 二、优化方案

### 2.1 滚动意图系统（核心优化）

**目标：** 引入持久化的 `followOutput` / `pinnedViewport` 概念，让 resize、buffer 重建、tab 切换后都能精确恢复用户的上滚位置。

#### 2.1.1 新增 `lib/terminal/scroll-intent.ts`

**设计：**

```typescript
// 两种意图类型
type ScrollIntentKind = 'followOutput' | 'pinnedViewport'

// 每条意图持久化记录
type ScrollIntent = {
  kind: ScrollIntentKind
  bufferType: 'normal' | 'alternate'
  viewportY: number      // 视口行号
  baseY: number          // buffer 总行数
  revision: number       // 递增版本号，用于检测是否被覆盖
}

// 每终端仅一条意图，通过 WeakMap 关联
// 通过 revision 版本号避免「先捕获 A → 收到新输出 B → 晚到的 restore 错误覆盖」
```

**核心 API：**

```typescript
// 从视口位置同步意图（每次写入/滚动后调用）
syncTerminalScrollIntentFromViewport(terminal)

// 结构重放前捕获意图（清空→重放前调用）
captureTerminalStructuralScrollIntent(terminal): { kind, bufferType, viewportY, baseY, revision }

// 结构重放后恢复意图（支持 bottomOffset 模式适应 reflow 行数变化）
restoreTerminalStructuralScrollIntent(terminal, snapshot, { restoreBy: 'bottomOffset' })

// 强制当前意图立即生效（切 tab 回来时调用）
enforceTerminalCurrentScrollIntent(terminal)
```

**与现有 `scroll.ts` 的关系：**

`scroll.ts` 继续保持**单次操作的 capture/restore**（写前/写后、resize 前/后），而 `scroll-intent.ts` 在其之上增加**持久化意图层**：

```
写入前 → scroll.captureScrollState()     ← 单次快照
写入后 → scroll.restoreScrollState()     ← 单次恢复
  ↓
写入后 → scroll-intent.syncTerminalScrollIntentFromViewport()  ← 持久化意图

resize 前 → scroll.captureScrollState()  ← 单次快照
resize 后 → scroll.restoreScrollState()  ← 单次恢复
  ↓
resize 后 → scroll-intent.syncTerminalScrollIntentFromViewport()  ← 持久化意图
```

#### 2.1.2 新增 `lib/terminal/scroll-intent-rebuild.ts`

**设计：**

```typescript
// buffer 重建期间挂起所有意图更新
// 重建完成后统一恢复
beginTerminalScrollIntentBufferRebuild(terminal)  // 开始重建
endTerminalScrollIntentBufferRebuild(terminal)    // 结束重建
isTerminalScrollIntentRebuildInFlight(terminal)   // 是否重建中
```

**计数值设计：** 支持嵌套重建（多次 `begin` → 对应多次 `end`），只有最外层 `end` 才触发恢复。

#### 2.1.3 新增 `lib/terminal/scroll-intent-dom-tracking.ts`

**设计：**

```typescript
// 在 mount 时挂载，unmount 时卸除
attachTerminalScrollIntentTracking(
  terminal, host, intentKey?
): IDisposable
```

**事件→意图映射（基于实际场景）：**

| DOM 事件 | 意图变化 | 理由 |
|----------|---------|------|
| 滚轮向上(deltaY < 0) | `pinnedViewport` | 用户上滚看历史 |
| 滚轮向下到底部 | `followOutput` | 用户滚回底部 |
| 滚动条拖拽 | `pinnedViewport` | 用户手动定位 |
| 键盘输入（非鼠标） | `followOutput` | 输入后自动贴底 |
| 鼠标滚轮事件（TUI 模式） | 保持 `pinnedViewport` | 不打断 vim/less 阅读 |

**TUI 模式检测：** `xterm` 的 `enable-mouse-events` CSS class 存在时，滚动事件不触发 `followOutput`。

#### 2.1.4 新增 `lib/terminal/scroll-intent-settle.ts`

**设计：**

```typescript
// 多时间点采样稳定化意图
// 在 microtask、rAF×2、setTimeout 80ms 后分别采样
// 避免因 xterm 异步滚动应用导致的短暂状态误判
syncTerminalScrollIntentSoon(terminal, options?)
```

#### 2.1.5 新增 `lib/terminal/structural-replay-coordinator.ts`

**设计：**

```typescript
class StructuralReplayCoordinator {
  // 队列：保证多个清空→重放任务不重叠
  run(task: () => void | Promise<void>, options?: {
    shouldRestore?: () => boolean
    afterRestore?: () => void | Promise<void>
  }): Promise<void>
  
  dispose(): void
}
```

**内部流程：**
1. `captureTerminalStructuralScrollIntent(terminal)` — 捕获重建前意图
2. `cancelDeferredScrollRestore(terminal)` — 取消挂起的恢复
3. `beginTerminalScrollIntentBufferRebuild(terminal)` — 标记重建中
4. 执行 task（清屏 + 重放）
5. `endTerminalScrollIntentBufferRebuild(terminal)` — 结束重建标记
6. `restoreTerminalStructuralScrollIntent(terminal, intent, { restoreBy: 'bottomOffset' })` — 恢复

**使用场景：**

```typescript
// XtermTerminal 中
await this.replayCoordinator.run(async () => {
  this.term.write('\x1bc')  // 清屏
  this.term.write(restoredData)  // 重放
}, {
  afterRestore: () => {
    this.doResize(true)  // 恢复后 fit
  }
})
```

#### 2.1.6 修改 `XtermTerminal.ts`

**变更点：**

| 位置 | 修改内容 |
|------|---------|
| 构造函数 | 创建 `StructuralReplayCoordinator` 实例 |
| `_initXterm` 末尾 | 挂载 `attachTerminalScrollIntentTracking` |
| `_writeProcessData` 回调末尾 | 追加 `syncTerminalScrollIntentFromViewport` |
| `_writeProcessDataUnsafe` 回调末尾 | 追加 `syncTerminalScrollIntentFromViewport` |
| `_resizeBoth` / `_resizeX` / `_resizeY` | 追加 `syncTerminalScrollIntentFromViewport` |
| `resetSameFrame` | 改为通过 `replayCoordinator.run` 执行 |
| `restoreScrollback` | 改为通过 `replayCoordinator.run` 执行 |
| `setActive(true)` | 追加 `enforceTerminalCurrentScrollIntent` |
| `unmount` | `replayCoordinator.dispose()` + `scrollIntentDisposable.dispose()` |

---

### 2.2 WebGL 渲染器可重试

#### 2.2.1 修改 `XtermTerminal.ts` 的 `enableWebgl()`

**当前代码（第 1474-1520 行）：**

```typescript
// 当前：永久锁定策略
if (!term || this.rendererLocked) return;       // 永不重入
if (this.webglAttachFailed) {                   // 失败后永不重试
  this.rendererLocked = true;
  return;
}
this.rendererLocked = true;                     // 成功后永不切换
```

**改为：**

```typescript
// 改为：条件重试策略
if (this.webglDisabledAfterContextLoss) {
  // 上下文丢失后，等待重试时机（resize/setActive）
  return;
}
// 移除 rendererLocked 的永久锁定逻辑
// 移除 webglAttachFailed latch（改为在 unmount 时清除）
```

**新增 `retryWebglIfNeeded()`：**

```typescript
retryWebglIfNeeded(): void {
  if (!this.term || this.disposed) return;
  // 条件：WebGL 之前因上下文丢失降级，且当前可见
  if (this.webglDisabledAfterContextLoss && this.active) {
    this.webglDisabledAfterContextLoss = false;
    this.enableWebgl();
  }
  // 条件：WebGL 之前因附加失败 latch，且用户切换了 GPU 配置
  if (this.webglAttachFailed && this.active) {
    this.webglAttachFailed = false;
    this.enableWebgl();
  }
}
```

**WebGL 上下文显式释放：**

```typescript
// 在 unmount 和 disposeWebgl 时调用
private releaseWebglContext(): void {
  try {
    const renderer = (this.webgl as any)?._renderer;
    renderer?._gl?.getExtension('WEBGL_lose_context')?.loseContext();
    if (renderer?._canvas) {
      renderer._canvas.width = 0;
      renderer._canvas.height = 0;
    }
  } catch { /* ignore */ }
}
```

**调用时机：**

| 方法 | 追加调用 |
|------|---------|
| `setActive(true)` | `retryWebglIfNeeded()` |
| `doResize()` | `retryWebglIfNeeded()` |
| `unmount()` | `releaseWebglContext()` 替换现有 canvas loseContext 逻辑 |

---

### 2.3 写入管道优化

#### 2.3.1 启用 Parse-Clock Pacer

**当前：** `output-scheduler.ts` 已有 `makeParseClockPacer()` 函数（第 531-546 行），但从未被调用。

**修改：** 在 `writeTerminalOutput` 的前台立即写入路径中启用 pacer：

```typescript
// 第 583-598 行：前台立即写入路径
const pacer = makeParseClockPacer();
terminal.write(
  data,
  composeParsedCallback(terminal, options?.onParsed, ackCreditsParsed, pacer)
);
```

**效果：** 每次 xterm 解析完一批前台写入后，立即检查是否有高优先级 backlog 并调度下一次 drain，实现「以解析器最快速度推进」。

#### 2.3.2 渲染端二次聚合

**当前：** 每个 IPC 消息直接触发 `handleProcessData` → `_writeProcessData` → `term.write()`。

**缺少：** 渲染端没有数据聚合层。主进程 5ms 聚合后仍可能产生高频小段 IPC 消息。

**方案：** 在 `XtermTerminal.ts` 的 `handleProcessData` 入口处增加聚合逻辑：

```typescript
// 在 handleProcessData 入口
private handleProcessData(id: string, data: string): void {
  if (id !== this.sessionKey || !this.term) return;
  
  // 二次聚合：将高频小段合并为一个大块
  this.outputBatcher.push(data);  // 内部 5ms/64KB 聚合后调用 _flushProcessData
}

private _flushProcessData(data: string): void {
  // 原有逻辑：OSC 分段 → 写入
  const segments = this._segmentByShellIntegration(data);
  // ...
}
```

**聚合参数：** `MAX_BYTES = 64 * 1024`，`FLUSH_MS = 5`。

---

### 2.4 渲染去同步检测（可选）

#### 2.4.1 新增 `lib/terminal/desync-detector.ts`

**设计：** 轻量级 canvas 读回对比，仅检测顶行和底行，非全屏扫描。

```typescript
class DesyncDetector {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  
  start(terminal: Terminal): void {
    // 每 5 秒检测一次，仅 WebGL 模式且可见时
    this.intervalId = setInterval(() => {
      this.sample(terminal);
    }, 5000);
  }
  
  private sample(terminal: Terminal): boolean {
    // 1. 读取 buffer 顶行文本
    // 2. 读 canvas 对应行像素
    // 3. 对比：不匹配 cell > 10% 则触发恢复
    // 恢复：clearTextureAtlas() + refresh()
  }
  
  stop(): void {
    if (this.intervalId) clearInterval(this.intervalId);
  }
}
```

**与 Orca 的差异：**
- 不做全屏扫描（Orca 扫描所有 text cell），只采样首行和末行
- 不做像素级证据持久化
- 发现不匹配直接恢复，不等待用户确认

---

## 三、实施路线图

### 优先级 P0（核心体验，必须做）

| 阶段 | 文件 | 工作量 | 收益 |
|------|------|--------|------|
| 1 | 新建 `lib/terminal/scroll-intent.ts` | ~300 行 | 滚动意图持久化，切 tab 回来保持阅读位置 |
| 2 | 修改 `XtermTerminal.ts` | ~50 行 | 在写入/resize 后同步意图 |
| 3 | 新建 `lib/terminal/scroll-intent-rebuild.ts` | ~100 行 | buffer 重建（清空→重放）期间保护意图 |
| 4 | 新建 `lib/terminal/structural-replay-coordinator.ts` | ~100 行 | 清空→重放后精确恢复滚动位置 |

### 优先级 P1（重要体验，建议做）

| 阶段 | 文件 | 工作量 | 收益 |
|------|------|--------|------|
| 5 | 新建 `lib/terminal/scroll-intent-dom-tracking.ts` | ~250 行 | 滚轮/拖拽/输入→滚动意图实时同步 |
| 6 | 新建 `lib/terminal/scroll-intent-settle.ts` | ~80 行 | 多时间点采样稳定化意图 |
| 7 | 修改 `XtermTerminal.ts` WebGL 部分 | ~50 行 | WebGL 上下文丢失后自动恢复 |

### 优先级 P2（性能优化，有空做）

| 阶段 | 文件 | 工作量 | 收益 |
|------|------|--------|------|
| 8 | 修改 `output-scheduler.ts` | ~10 行 | 启用 Parse-Clock Pacer |
| 9 | 修改 `XtermTerminal.ts` 写入路径 | ~80 行 | 渲染端二次聚合减少高频写入 |

### 优先级 P3（诊断，可选）

| 阶段 | 文件 | 工作量 | 收益 |
|------|------|--------|------|
| 10 | 新建 `lib/terminal/desync-detector.ts` | ~150 行 | 自动检测 WebGL 渲染乱码 |

---

## 四、验收标准

### 滚动系统验收

| 测试场景 | 预期行为 |
|----------|---------|
| 用户上滚查看历史 → 新输出到达 | 视口不跳回底部，保持阅读位置 |
| 用户上滚 → 手动滚回底部 | 恢复 `followOutput`，新输出自动贴底 |
| 用户上滚 → resize 窗口 | 保持上滚位置，reflow 后行号正确 |
| 用户上滚 → 切 tab → 切回来 | 保持上滚位置 |
| 全屏 TUI (vim/less) 中滚动 | 不触发 `followOutput`，不打断阅读 |
| 清屏→重放 (resetSameFrame) | 重放后恢复滚动位置 |

### WebGL 验收

| 测试场景 | 预期行为 |
|----------|---------|
| 上下文丢失 | 降级 DOM，下次可见时尝试重建 WebGL |
| 快速连续开关 tab | 不触发 WebGL context 泄露 |
| 长时间运行 | 不因 context 泄露达到浏览器上限(~16) |

### 写入管道验收

| 测试场景 | 预期行为 |
|----------|---------|
| 大文件输出 (>1MB) | 无明显卡顿，xterm 以解析速度推进 |
| 高频率小段输出 | 5ms 聚合后一次性写入，减少 term.write 调用 |