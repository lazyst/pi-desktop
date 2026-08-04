# pi-workbench 终端防闪烁优化/重构计划

> 基于对 pi-workbench 当前终端实现的分析，以及 Orca 终端代码的深入研究。

---

## 一、问题分析：当前终端闪烁的 14 个根源

### P0 — 严重影响用户体验

| # | 闪烁根源 | 文件位置 | 机制 |
|---|---------|---------|------|
| 1 | **Scrollbar jiggle（滚动条抖动）** | `src/renderer/src/lib/terminal/scrollbar-sync.ts:38-49` | 每次 resize 后执行 `scrollLines(-1)` + `scrollLines(1)` 强制刷新滚动条，导致终端内容可见的"上滚一行回滚一行"抖动。此函数在 `_resizeBoth`、`_resizeX`、`_resizeY` 中都被调用 |
| 2 | **WebGL 纹理图集清空 + 3×多重刷新频闪** | `src/renderer/src/lib/terminal/terminal-webgl-atlas-recovery.ts:65-80` | `clearTextureAtlas()` 后 3×250ms 间隔重复刷新，750ms 内呈现频闪效果 |
| 3 | **Tab 切换双重刷新** | `XtermTerminal.ts:440-460` + `terminal-webgl-atlas-recovery.ts:100-114` | `setActive()` 的 `_flushAndRender()` 全屏刷新后，紧接着 100ms 防抖后触发 `scheduleTabRevealWebglAtlasRecovery()` 再次清 atlas + 刷新，100ms 内两次全屏闪烁 |

### P1 — 频繁触发

| # | 闪烁根源 | 文件位置 | 机制 |
|---|---------|---------|------|
| 4 | **5ms 突发式写聚合导致脉冲渲染** | `XtermTerminal.ts:288-290, 1620-1690` | 5ms 定时器聚合 + 64KB 上限，数据以脉冲方式写入 xterm，而非平滑流动。高速输出时每 5ms 一次 burst，渲染帧率剧烈波动 |
| 5 | **Render pause 强制释放导致全屏闪** | `src/renderer/src/lib/terminal/render-pause-release.ts:55-75` + `XtermTerminal.ts:461` | Tab 切回时 `forceRepaintThroughRenderPause()` 强制同步 `refreshRows(0, rows-1, true)`，直接访问 xterm 内部 `_core._renderService._isPaused`，全屏刷新一次 |
| 6 | **主题/字号变化 → full atlas clear + resize + reflow** | `XtermTerminal.ts:550-580`, `terminal-registry.ts:68-75` | 每次 `applyTheme`/`applyFontSize` 调用 `forceRedraw()` → `clearTextureAtlas()` + `term.refresh(0, rows-1)`，所有 glyph 消失再重新出现 |
| 7 | **X 轴 resize 100ms 防抖间隙** | `src/renderer/src/components/terminalResizeDebouncer.ts:104-107` | 列宽变化后 100ms 内终端显示错误尺寸，然后突然跳变到正确尺寸 |
| 8 | **WebGL ↔ DOM 渲染器切换闪光** | `src/renderer/src/lib/terminal/terminal-renderer-policy.ts:130-140` | 检测到 TUI 标题时降级到 DOM 渲染器，canvas 被替换，产生可见闪烁 |

### P2 — 偶发/边界情况

| # | 闪烁根源 | 文件位置 | 机制 |
|---|---------|---------|------|
| 9 | **滚动条宽度反馈循环** | `src/renderer/src/styles/app.css:1188-1196` | `scrollbar-width: none` + `overflow-y: auto` 导致滚动条出现/消失改变有效视口宽度 → 触发 ResizeObserver → 触发 fit → 内容高度变化 → 滚动条再次切换 |
| 10 | **多点滚动 settle 采样不稳定** | `src/renderer/src/lib/terminal/scroll-intent-settle.ts:65-95` | 4 点采样（microtask + rAF×2 + 80ms）在 80ms 内视口状态不稳定 |
| 11 | **Linkifier hover 缓存清除** | `src/renderer/src/lib/terminal/linkifier-hover-reset-on-write.ts:30-44` | 输出流式时 150ms 节流清除 link 样式，导致链接下划线闪烁 |
| 12 | **Desync 检测器恢复延迟闪烁** | `src/renderer/src/lib/terminal/desync-detector.ts:255-265` | 5-10s 延迟后的 `clearTextureAtlas()` + `refresh()` 意外闪烁 |
| 13 | **OSC 633 分段碎片化** | `XtermTerminal.ts:1700-1740` | 每个 OSC 标记产生独立 `term.write()` 调用，TUI 大量 OSC 序列时多个写操作碎化 |
| 14 | **flush() 轮询导致渲染停顿** | `XtermTerminal.ts:497-530` | 20ms 间隔轮询，最多 100ms 等待，高速输出时造成渲染停顿 |

---

## 二、Orca 的防闪烁策略（学习借鉴）

Orca 采用了 **7 层防闪烁体系**，从底层渲染到顶层 UI 布局全面覆盖：

### 2.1 同步预绘制 fit（消除布局闪烁）

**文件：** `src/constants/terminal.ts` + `src/components/terminal-pane/use-terminal-container-fit-sync.ts`

- 侧边栏开/关等瞬时宽度变化时，通过 `useLayoutEffect`（浏览器绘制**前**）派发 `SYNC_FIT_PANES_EVENT`
- 终端在**同一帧**内同步 fit 到新容器尺寸，消除 ~16ms 的"旧列宽+新容器宽"闪烁
- 连续拖拽（侧边栏拖宽、分栏拖拽）走独立 `ResizeObserver` 150ms 防抖路径

### 2.2 稳定网格 fit（消除 SIGWINCH 抖动）

**文件：** `src/lib/pane-manager/pane-fit-resize-observer.ts`

- `requestStablePaneFit()` 只在前**两帧**提议尺寸一致时才执行 fit
- 最多等待 8 帧（`MAX_STABILITY_FRAMES = 8`），超时后强制 fit
- 已有 grid 匹配提议尺寸时立即跳过，不触发任何操作
- 消除 Windows 侧边栏锚点/滚动条"一列抖动"导致的 SIGWINCH 循环

### 2.3 前台渲染 settle（消除写后视口抖动）

**文件：** `src/lib/pane-manager/pane-terminal-foreground-render-settle.ts`

- 写前捕获视口快照（`captureViewportSnapshot`）
- 写后刷新可见行（`refreshVisibleRows`）
- 如果视口在写期间滚动（baseY/viewportY 变化），调度一次 **rAF settle refresh**
- 双重保障：`requestAnimationFrame` 回退到 `setTimeout(16ms)`
- 使用 `runGuardedWriteCompletionStep` 保护回调，防止异常卡死 WriteBuffer

### 2.4 双 rAF reveal 重绘（消除显隐闪烁）

**文件：** `src/lib/pane-manager/pane-reveal-repaint.ts`

- **重绘路径**（hide→show）：`requestAnimationFrame(() => requestAnimationFrame(...))` — 第一帧等待布局稳定，第二帧执行重绘
- **呈现路径**（纯 refocus）：不清 atlas，只 `terminal.refresh(0, rows-1)` 保留共享纹理图集
- 避免 xterm.js issue 4480 的"页面合并错乱"竞争

### 2.5 输出调度器（消除缓冲区闪烁）

**文件：** `src/lib/pane-manager/pane-terminal-output-scheduler.ts`（~1500 行）

- **前台**：MessageChannel 零延迟 drain，每 tick 最多 8 次写入
- **后台**：50ms 首次延迟，16ms 间隔 drain，每 tick 2 次写入
- **Parse-clock pacer**：xterm 解析完成后才触发下一次 drain，实现 ~30MB/s 吞吐量
- **Drain 时间预算**：8ms/tick，超时 yield 保持主线程响应
- **前台合并**：TUI 同步帧（`ESC[?2026h`…`ESC[?2026l`）在恢复序列完成前保持，防止 Chromium 渲染瞬态光标状态
- **Backlog 上限**：默认 512KB，超过时写入警告并丢弃旧数据

### 2.6 Render pause 释放 + 写管道健康（消除死锁闪烁）

**文件：** `src/lib/pane-manager/pane-terminal-render-pause-release.ts` + `terminal-write-pipeline-health.ts`

- 通过 xterm 内部 `_renderService` 清除 `_isPaused` 和 `_needsFullRefresh` 锁存
- 强制同步 `refreshRows(0, rows-1, true)` 驱动渲染
- 10s 探针认证的死管道检测，发送空探针写，探针也不完成时判定管道死亡

### 2.7 Scroll intent 保持 + 滚动条同步（消除滚动闪烁）

**文件：** `src/lib/pane-manager/terminal-scroll-intent.ts`

- `captureTerminalStructuralScrollIntent` 在 fit 前捕获 intent
- `restoreTerminalStructuralScrollIntent` 在 fit 后恢复
- **不做 scrollbar jiggle** — 不执行 `scrollLines(-1)` + `scrollLines(1)`。
- 通过 `scrollToBottom` 或 `scrollToLine` 直接设置，xterm 6 的滚动条滑块更新由内部机制保证

---

## 三、具体优化/重构计划

### 阶段一：低风险高收益（1-2 天）

#### 1.1 消除 Scrollbar jiggle（P0）

**目标：** 删除 `scrollbar-sync.ts` 中的 `scrollLines(-1)` + `scrollLines(1)` 抖动。

**方案：**
- 在 `XtermTerminal.ts` 中，`_resizeBoth`、`_resizeX`、`_resizeY` 完成后不再调用 `forceTerminalViewportScrollbarSync`
- 观察 xterm 6 实际是否需要滚动条同步。若需要，改为调用 `terminal.scrollToBottom()`（底部时）或 `terminal.scrollToLine(viewportY)`（非底部时），而非 jiggle
- 保留 `safeScrollCall` 为防御性包装

**涉及文件：**
- `src/renderer/src/lib/terminal/scrollbar-sync.ts` — 重写 `forceTerminalViewportScrollbarSync`，移除 jiggle
- `src/renderer/src/components/XtermTerminal.ts` — 搜索 `forceTerminalViewportScrollbarSync` 调用点，移除或替换

#### 1.2 消除 WebGL 图集恢复的 3×多重刷新（P0）

**目标：** `terminal-webgl-atlas-recovery.ts` 的 `clearAndRefreshAtlases` 从 3×250ms 频闪改为单次双 rAF settle。

**方案：**
- 删除 `REFRESH_FRAME_COUNT = 3` 和 `REFRESH_FRAME_INTERVAL_MS = 250` 的多重刷新逻辑
- 改为 Orca 风格的双 rAF settle：`requestAnimationFrame(() => requestAnimationFrame(() => resetFn()))`
- 第一帧等待布局稳定，第二帧执行一次 `clearTextureAtlas()` + `refresh`

**涉及文件：**
- `src/renderer/src/lib/terminal/terminal-webgl-atlas-recovery.ts` — 重写 `clearAndRefreshAtlases`

#### 1.3 消除 Tab 切换双重刷新（P0）

**目标：** `setActive()` 中 `_flushAndRender()` 和 `scheduleTabRevealWebglAtlasRecovery()` 在 100ms 内两次触发全屏闪烁。

**方案：**
- `setActive()` 中移除 `scheduleTabRevealWebglAtlasRecovery()` 调用
- 将 Tab 切换后的图集恢复逻辑内联到 `_flushAndRender()` 中，在 `forceRepaintThroughRenderPause` 之后立即执行一次 `resetWebglTextureAtlas`（若需要）
- 或使用 Orca 的 `schedulePaneRevealPresent` 模式：Tab 切换时只 `refresh` 不清 atlas，仅在真正"隐藏后恢复"时才清 atlas

**涉及文件：**
- `src/renderer/src/components/XtermTerminal.ts` — 修改 `setActive()` 和 `_flushAndRender()`

---

### 阶段二：核心写路径优化（2-3 天）

#### 2.1 对齐 Orca 的写调度器（P1）

**目标：** 当前 `XtermTerminal.ts` 使用 5ms 定时器聚合 + 直接 `term.write()`，而 `src/renderer/src/lib/terminal/output-scheduler.ts` 已存在但未被使用。接入 Orca 风格的调度器。

**方案：**
- `output-scheduler.ts` 已实现前台/后台优先级队列、parse-clock pacer、drain 时间预算、backlog 上限等核心机制
- 将 `XtermTerminal.handleProcessData` 的写路径从 `_flushAggregatedData` → `_segmentByShellIntegration` → `_writeProcessData` 切换到 `output-scheduler.ts` 的 `writeTerminalOutput`
- 移除 `XtermTerminal` 中的 5ms 聚合定时器（`_aggregateTimer`、`_aggregateBuffer`、`_aggregateSize`）
- 保留 `_segmentByShellIntegration` 作为 `beforeWrite` 回调传入调度器
- 保留 `_writeProcessData` 的 ack 逻辑，通过 `ackCredit` 回调接入调度器

**关键设计：**
- 前台写入：`latencySensitive: true` → MessageChannel 零延迟，高优先级
- 前台合并：`coalesce: true` → 检测 `ESC[?2026h`/`ESC[?2026l` 同步帧，保持写入直到恢复序列完成
- 后台写入：`latencySensitive: false` → 50ms 延迟，16ms 间隔 drain
- 保留 `flush()` 的 `await` 能力，通过 `onParsed` 回调跟踪写完成

**涉及文件：**
- `src/renderer/src/components/XtermTerminal.ts` — 重构 `handleProcessData` 写路径
- `src/renderer/src/lib/terminal/output-scheduler.ts` — 可能需要扩展接口以支持 OSC 633 分段和 ack 集成

#### 2.2 前台渲染 settle（P1）

**目标：** 每次前台写入后，确保视口状态正确，消除写后滚动闪烁。

**方案：**
- 移植 Orca 的 `writeForegroundTerminalChunk` 模式：
  - 写前 `captureViewportSnapshot`
  - 写后 `refreshVisibleRows`
  - 视口变化时调度 `scheduleViewportSettleRefresh`（rAF 一次）
- 在 `output-scheduler.ts` 的前台 drain 路径中集成此逻辑

**涉及文件：**
- 新建 `src/renderer/src/lib/terminal/foreground-render-settle.ts`
- 修改 `src/renderer/src/lib/terminal/output-scheduler.ts`

---

### 阶段三：Resize 流程重构（2-3 天）

#### 3.1 同步预绘制 fit（P1）

**目标：** 消除侧边栏开/关等瞬时宽度变化时的 ~16ms 尺寸跳变闪烁。

**方案：**
- 在 React 侧的 `useLayoutEffect` 中，检测侧边栏/分栏等布局变化
- 派发自定义事件 `SYNC_FIT_PANES_EVENT`
- 在 `PaneManager` 或 `XtermTerminal` 中监听该事件，同步执行 `fit.fit()`
- 连续拖拽（侧边栏拖宽、分栏拖拽）走原有的 `ResizeObserver` + 防抖路径

**涉及文件：**
- 新建 `src/renderer/src/constants/terminal.ts` — 定义 `SYNC_FIT_PANES_EVENT`
- 新建 `src/renderer/src/components/use-terminal-container-fit-sync.ts` — React hook
- 修改 `src/renderer/src/components/XtermTerminal.ts` — 添加事件监听

#### 3.2 稳定网格 fit（P1）

**目标：** 消除 resize 过程中因尺寸微小波动导致的 SIGWINCH 循环抖动。

**方案：**
- 移植 Orca 的 `requestStablePaneFit()`
- 在 `ResizeObserver` 回调中，不直接调用 `fit.fit()`，而是启动稳定网格等待
- 连续两帧提议尺寸一致时才执行 fit
- 最多等待 8 帧，超时强制 fit
- 已有 grid 匹配提议尺寸时直接跳过

**涉及文件：**
- 新建 `src/renderer/src/lib/terminal/stable-fit.ts` — 移植 Orca 的稳定网格算法
- 修改 `src/renderer/src/components/XtermTerminal.ts` — 将 `doResize` 的 ResizeObserver 回调改为稳定网格路径

#### 3.3 消除滚动条宽度反馈循环

**目标：** 消除 `scrollbar-width: none` + `overflow-y: auto` 导致的宽度跳动循环。

**方案：**
- 将 xterm 容器的 `overflow-y: auto` 改为 `overflow-y: scroll`（始终显示滚动条区域，即使滚动条本身透明）
- 或使用 `scrollbar-gutter: stable` CSS 属性预留滚动条空间
- 配合 `::-webkit-scrollbar` 定制透明/细滚动条样式

**涉及文件：**
- `src/renderer/src/styles/app.css` — 修改 `.terminal-host` 相关滚动条样式
- 或 `src/renderer/src/components/XtermTerminal.ts` — 在 `mount` 时设置容器样式

---

### 阶段四：渲染器与主题变更优化（1-2 天）

#### 4.1 主题/字号变更的平滑过渡（P1）

**目标：** 消除 `applyTheme`/`applyFontSize` 时的全屏配置闪烁。

**方案：**
- 拆分 `forceRedraw()` 为"清 atlas + 单帧刷新"，而非"清 atlas + 立即 refresh"
- 使用双 rAF settle：第一帧清 atlas，第二帧 refresh
- `applyFontSize` 时，先 `resize` 再清 atlas，避免 resize + atlas clear 交织
- 在 `terminal-registry.ts` 的 `broadcastConfigUpdate` 中，对多个配置变化做 16ms 聚合，避免连续两次 `applyTheme` + `applyFontSize` 触发两次全屏刷新

**涉及文件：**
- `src/renderer/src/components/XtermTerminal.ts` — 重写 `applyTheme`、`applyFontSize`、`forceRedraw`
- `src/renderer/src/lib/terminal-registry.ts` — 添加配置变更聚合

#### 4.2 Render pause 释放优化

**目标：** 消除 `forceRepaintThroughRenderPause` 的直接内部属性访问和同步全屏刷新。

**方案：**
- 保留 `forceRepaintThroughRenderPause` 的 pause 清除能力
- 将同步 `refreshRows(0, rows-1, true)` 改为异步 `refresh()` + 双 rAF settle
- 在 `_flushAndRender()` 中，先 `flush()` 等待所有写完成，然后 `refresh(0, rows-1)`，最后 `forceRepaintThroughRenderPause` 仅清除 pause 状态

**涉及文件：**
- `src/renderer/src/lib/terminal/render-pause-release.ts` — 优化刷新策略
- `src/renderer/src/components/XtermTerminal.ts` — 调整 `_flushAndRender()` 调用顺序

---

### 阶段五：WebGL 渲染器增强（1-2 天）

#### 5.1 WebGL ↔ DOM 切换平滑化（P1）

**目标：** 消除 TUI 检测时渲染器切换的 canvas 替换闪烁。

**方案：**
- 切换前先 `refresh()` 确保 DOM 渲染器准备好
- 使用 `requestAnimationFrame` 在切换前等待一帧
- 切换后立即 `refresh(0, rows-1)` 确保新渲染器立即呈现
- 在 `terminal-renderer-policy.ts` 中添加切换动画抑制

**涉及文件：**
- `src/renderer/src/components/XtermTerminal.ts` — 优化 `enableWebgl()` 和 `disableWebgl()` 流程
- `src/renderer/src/lib/terminal/terminal-renderer-policy.ts` — 添加切换策略

#### 5.2 Desync 检测器优化

**目标：** 消除 desync 检测器恢复时的延迟闪烁。

**方案：**
- 降低检测间隔从 5000ms 到 3000ms
- 恢复时使用双 rAF settle 而非直接 `clearTextureAtlas()` + `refresh()`
- 增加检测阈值：从 2 次连续采样提高到 3 次，减少误报

**涉及文件：**
- `src/renderer/src/lib/terminal/desync-detector.ts` — 优化参数

---

### 阶段六：写管道健康与稳定性（1 天）

#### 6.1 写回调保护（P2）

**目标：** 防止 `term.write()` 回调中抛出的异常卡死 xterm WriteBuffer。

**方案：**
- 移植 Orca 的 `runGuardedWriteCompletionStep` 到所有 `term.write()` 回调
- `XtermTerminal.ts` 中 `_writeProcessData` 和 `_writeProcessDataUnsafe` 的写回调已使用 `runGuardedWriteCompletionStep`，但需要确认所有回调路径都受保护

**涉及文件：**
- `src/renderer/src/components/XtermTerminal.ts` — 审计所有 `term.write()` 回调

#### 6.2 写管道 stall 检测（P2）

**目标：** 检测并恢复写管道死锁。

**方案：**
- `write-pipeline-health.ts` 已实现 10s 探针检测
- 在 `output-scheduler.ts` 的 drain 路径中集成 `armTerminalWriteStallWatch` 和 `settleTerminalWriteStallWatch`
- 管道死亡时发送 `recovery` 事件，由上层（`PaneManager`/`TerminalPane`）决定是否重建 xterm 实例

**涉及文件：**
- `src/renderer/src/lib/terminal/output-scheduler.ts` — 集成 stall 检测
- `src/renderer/src/components/XtermTerminal.ts` — 处理 stall 恢复事件

---

## 四、实施路线图

| 阶段 | 优先级 | 主要收益 | 预估时间 | 风险 |
|------|--------|---------|---------|------|
| **一：低风险高收益** | P0 | 消除最明显的 3 个闪烁源 | 1-2 天 | 低 — 删除/简化代码，不引入新机制 |
| **二：核心写路径** | P1 | 消除写脉冲和写后视口抖动 | 2-3 天 | 中 — 需要重构写路径，需充分测试 |
| **三：Resize 流程** | P1 | 消除布局变化时的尺寸跳变和抖动 | 2-3 天 | 中 — 新算法需验证各平台/场景 |
| **四：渲染器主题** | P1 | 消除配置变化时的全屏闪烁 | 1-2 天 | 低 — 主要是流程优化 |
| **五：WebGL 增强** | P1 | 消除渲染器切换闪烁 | 1-2 天 | 中 — 涉及 WebGL 内部机制 |
| **六：写管道健康** | P2 | 提升稳定性，消除边界情况闪烁 | 1 天 | 低 — 增量改进 |

### 快速验证方法

1. **阶段一验证**：在 dev 模式下拖拽侧边栏、切换 Tab、连续 resize 窗口，观察终端是否有明显闪烁
2. **阶段二验证**：`cat large-file.txt`、`npm install` 等高速输出场景，观察是否平滑无脉冲
3. **阶段三验证**：打开/关闭侧边栏、拖拽分栏、切换 Tab 后立即观察终端尺寸是否跳变
4. **全量验证**：录制终端屏幕，以 60fps 逐帧回放检查是否有闪烁帧

---

## 五、关键技术决策

### 5.1 保留 vs 替换

| 模块 | 决策 | 理由 |
|------|------|------|
| `scrollbar-sync.ts` | **重写** | jiggle 方案有根本缺陷，直接删除滚动微调 |
| `terminal-webgl-atlas-recovery.ts` | **重写** | 3×250ms 频闪方案不合理，改为双 rAF settle |
| `output-scheduler.ts` | **激活** | 已有代码但未使用，接入后替换 5ms 定时器路径 |
| `terminalResizeDebouncer.ts` | **保留 + 改进** | 分轴策略合理，增加稳定网格算法 |
| `scroll-intent.ts` | **保留** | 已对齐 Orca 的设计 |
| `render-pause-release.ts` | **保留** | 必要能力，优化刷新策略 |
| `write-pipeline-health.ts` | **保留** | 已有代码，接入到调度器 |

### 5.2 新模块

| 模块 | 来源 | 说明 |
|------|------|------|
| `foreground-render-settle.ts` | 移植 Orca | 写前快照/写后 settle/视口变化检测 |
| `stable-fit.ts` | 移植 Orca | 稳定网格 fit 算法 |
| `use-terminal-container-fit-sync.ts` | 移植 Orca | React hook，同步预绘制 fit |
| `constants/terminal.ts` | 新建 | 共享事件名常量 |

### 5.3 不做的事

- **不替换 xterm 版本**：当前 xterm 版本已稳定，替换版本引入新风险
- **不引入 WebGPU 渲染器**：xterm 社区尚未成熟支持
- **不重构 React 集成架构**：`XtermTerminal` 的类封装 + React 壳模式可工作，只优化内部实现
- **不修改主进程 PTY 流控**：主进程的 5ms 聚合 + ACK 背压已工作良好，只需优化渲染端消费

---

## 六、测试策略

| 测试类型 | 覆盖范围 | 工具 |
|---------|---------|------|
| **单元测试** | `output-scheduler`、`stable-fit`、`foreground-render-settle`、`scrollbar-sync` | vitest |
| **集成测试** | `XtermTerminal` 的写路径、resize 路径、Tab 切换路径 | Playwright |
| **视觉回归** | 终端渲染前后截图对比 | Playwright screenshot |
| **人工验收** | 各阶段验证清单中的场景 | 手动 |

### 关键测试场景

1. 侧边栏快速开/关 10 次 — 终端不应闪烁
2. 窗口连续拖拽 resize — 终端平滑跟随，无尺寸跳变
3. Tab 快速切换（A→B→A→C）— 每次切换终端内容正确，无闪烁
4. `cat` 大文件输出 — 平滑滚动，无脉冲停顿
5. TUI 程序（vim、htop、npm install）— 渲染正确，无抖动
6. 主题切换 — 平滑过渡，无全屏闪烁
7. 字号切换 — 平滑过渡，无跳动
8. 分栏创建/关闭/拖拽 — 各面板正确 fit，无闪烁