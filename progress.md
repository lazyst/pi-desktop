# Progress Log

## 总体状态（2026-07-18 收尾）：全部完成
- 防闪烁 6 个 Phase：全部完成（见下）。
- 预存 e2e 4 项失败：已排查并修复（类1 调试期漏跑 copy-assets；类2 jump-to-bottom 功能从未实现，已补齐）。
- 最终验证：tsc 零报错；vitest 94 项全过；playwright 6 项全过。
- 注：规划钩子反复提示的「0/6 phases done」为会话恢复的陈旧读数，与实际代码/测试/进度文件三者均不符。

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
