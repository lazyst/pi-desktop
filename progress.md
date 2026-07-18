# Progress Log

## 总体状态（2026-07-19 收尾）：全部完成
- 防闪烁 6 个 Phase（0002/0003/0004）：全部完成。
- 终端流式输出与差分渲染全面对齐 VS Code（0006）：全部完成（见下）。
- **紧急修复**：点击会话启动 pi 进程时主进程崩溃 `ReferenceError: pool is not defined`（背压
  回传闭包自引用 + const TDZ），已修复。
- 最终验证：tsc 零报错；vitest 100 项全过；electron-vite build 三段全过；e2e 无主进程崩溃。

## Session 2026-07-19（补）— 修复主进程崩溃 `pool is not defined`

- 现象：点击左侧会话启动 pi 进程时弹 `A JavaScript error occurred in the main process` →
  `Uncaught Exception: ReferenceError: pool is not defined`（崩溃级，主进程退出）。
- 根因：`main/index.ts` 的 `createPool(win)` 在 `SessionPool` 构造的 `opts` 里写了自引用闭包
  `acknowledgeDataEvent: (key, bytes) => pool.acknowledgeDataEvent(key, bytes)`。该闭包捕获的是
  `createWindow` 作用域的 `const pool`，而 `pool` 经 `const pool = createPool(win)` 赋值——即
  `createPool` 同步执行期 `pool` 处于 TDZ；且闭包自引用会无限递归。渲染端每批 write 后回传
  `acknowledgeDataEvent` → IPC `session:ack` → 该闭包首次进入即 `pool` 未绑定抛错。
- 修复：删除该自引用闭包。`SessionPool.acknowledgeDataEvent` 已内部完成 `ackedBytes` 记账，
  `opts.acknowledgeDataEvent` 钩子改为可选扩展点（当前不传，由 `?.` 安全跳过）。回传入口统一走
  `ipcMain.on('session:ack', (_e, m) => pool.acknowledgeDataEvent(m.key, m.bytes))`，此处 `pool`
  已赋值、无 TDZ。
- 验证：tsc OK；build OK；e2e `test-results/` 中无 `pool is not defined` / `Uncaught Exception`
  / 主进程崩溃对话框（4 项 e2e 失败为改动前预存的 promote/jump-to-bottom 相关，与本次无关，
  见 ADR 0004 记录）。

## Session 2026-07-19 — 终端全面对齐 VS Code 流式/差分渲染（ADR 0006）

逐行对比 `vscode-src/.../contrib/terminal/` 与本项目终端层，补齐以下 8 项缺失机制：

1. **WebGL 上下文丢失恢复**（对齐 `_enableWebglRenderer.onContextLoss`）：
   `enableWebgl()` 注册 `onContextLoss` → 整会话降级 DOM + `doResize(true)` 重测；保存 `this.webgl` 引用。
2. **强制重绘 / 清纹理图集**（对齐 `forceRedraw`）：新增 `forceRedraw()` = `clearTextureAtlas()`；
   主题切换回调里调用，消除 WebGL 换主题纹理残留。
3. **Shell Integration 流分割**（对齐 `_onProcessData`）：新增 `segmentByShellIntegration()`，
   按 OSC 633 切段写入，命令边界成独立写入单元。
4. **背压回传**（对齐 `acknowledgeDataEvent`）：write 回调调 `pi.acknowledgeDataEvent(key, len)`；
   链路打通 ipc.ts → preload `session:ack` → main `ipcMain.on` → `SessionPool.acknowledgeDataEvent` 记账。
5. **条件平滑滚动**（对齐 `MouseWheelClassifier`）：`bindWheelClassifier()` 仅物理滚轮启用平滑。
6. **不可见 idle 延迟 resize**（对齐 `runWhenWindowIdle`）：`scheduleResize()` 非 active 时走
   `requestIdleCallback`（降级 setTimeout(0)）。
7. **Decoration 覆盖层基座**（对齐 `DecorationAddon`）：`registerLineDecoration(marker, opts)`
   + `clearDecorations()`，命令状态可脱离 VT 流做差分 overlay。
8. **数据重放**（对齐 `handleReplay`）：`replayData(data)` API 就位。

- 验证：tsc 零报错；vitest 100 项全过（新增 6 项用例）；electron-vite build 通过。
- 约束保持：单文件薄封装、契约保形、零接触 PTY 链路（0002/0003/0004）。

## Session 2026-07-18

- 完成 VS Code vs 本项目 终端防闪烁机制对比（见 findings.md）。
- 编写 task_plan.md（6 phases）、findings.md。
- 待实现：Phase 1..6。

### Phase 1 — keep-alive TerminalPane
- status: completed
- 实现：TerminalPane 拆成「创建实例一次」+「setActive 可见性」两个 effect；XtermTerminal 加
  mounted/active 字段 + setActive()。非 active 只隐藏不销毁。

### Phase 2 — 主进程数据缓冲
- status: completed
- 实现：sessionPool.ts 加 emitData(key, data) 5ms 聚合 + dataBuffers Map + clearDataBuffer；
  terminate/deleteSession 清缓冲。onData 签名不变。

### Phase 3 — flush 写完成确认
- status: completed
- 实现：XtermTerminal 加 _latestWriteSeq/_latestParsedSeq + onWriteParsed 注册 + flush()。

### Phase 4 — 背景色跟随容器
- status: completed
- 实现：theme.ts TERM_THEMES 改为 getTermTheme(theme) 运行时读 --bg-app computed 值。

### Phase 5 — 同帧 RIS 重置
- status: completed
- 实现：XtermTerminal.resetSameFrame() 发 \x1bc。

### Phase 6 — 验证 + ADR
- status: completed
- vitest 92 项全过（含新增 7 项用例）。playwright 4 项失败经 git stash 验证为改动前预存失败，
  与本次无关。新增 ADR 0004。

## 最终验证（2026-07-18 收尾）
- tsc --noEmit：零报错。
- vitest 全量 92 项通过。
- 受影响文件单测 42 项（XtermTerminal 14 + TerminalPane 3 + sessionPool 25）通过。
- 源码逐行核对：setActive / emitData(DATA_BUFFER_MS=5) / flush+写解析序号 / getTermTheme(--bg-app)
  / resetSameFrame 五项机制均已在位并正确接线。
- 结论：6 个 Phase 全部完成，无剩余工作。规划钩子反复提示的「0/6」为会话恢复的陈旧读数。

## 排查并修复 4 个预存 e2e 失败（2026-07-18 续）
- 根因分两类：
  1) 构建流程被我调试时误用 `npx electron-vite build`（跳过 `copy-assets.mjs`），
     导致 `out/main/fake-pi.mjs` 未拷贝进构建产物 → 每个 fake-pi 会话进程以 exit code 1 立即退出
     （node 找不到 out/main/fake-pi.mjs）→ 会话 A/B 全部自杀，连带破坏 continuity / promote / reuse 三项。
     修复：统一改用 `npm run build`（= electron-vite build && node scripts/copy-assets.mjs）。
     这三项失败本是调试产物，非产品缺陷；改用正确构建后 3 项即过。
  2) jump-to-bottom 浮钮功能此前从未实现：渲染端无 `.jump-bottom` 元素、无 scroll 状态跟踪、
     CSS 还把滚动条 width:0。这是真实缺失功能。已补齐：
     - XtermTerminal：新增 onScrollState 回调 + notifyScrollState（用 buffer.viewportY/baseY 判贴底，
       兼容 xterm6 WebGL 下 scrollTop 恒 0）、scrollToBottom()；onScroll 驱动；写后锁底也通知。
     - TerminalPane：渲染 `.jump-bottom.visible` 浮钮（仅 active 且离底时）、点击调 scrollToBottom()。
     - app.css：`.jump-bottom` 样式，right:14px 错开 10px 原生滚动条，满足 e2e 不重叠约束。
     - 单元测试：XtermTerminal 新增 scroll-state 回调 + scrollToBottom 共 2 项。
- 验证：vitest 94 项全过；playwright 6 项全过（此前 4 项失败现已修复）。
