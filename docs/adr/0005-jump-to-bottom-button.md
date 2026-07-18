# 0005 终端「跳到底部」浮钮（补全未实现的滚动跟随 UI）

e2e `app.spec.ts:163` 断言一个「跳到底部」浮钮（`.jump-bottom.visible`）：用户上滚离底时出现，
点击回到最新输出。但排查发现该浮钮功能此前**从未实现**——渲染端无 `.jump-bottom` 元素、无
scroll 状态跟踪，CSS 还把原生滚动条 `width:0`。本 ADR 补全该功能。

## Status

accepted

## 背景与动机

全屏 TUI 终端在高速输出时视口默认贴底跟随；用户上滚查看历史后，若新数据持续涌入，需一个
显式「跳回最新」入口（对齐 VS Code 终端视口底部的向下箭头按钮）。缺失该功能会导致：
- 上滚看历史时被新输出「顶走」且无回到底部的便捷入口；
- e2e 中该交互的验收项永久失败。

## Considered Options

- **R1 只做滚动状态跟踪、浮钮用原生 scrollTop**：否决。xterm 6.0.0 WebGL 渲染器下
  `.xterm-viewport` 的 `scrollTop` 恒为 0（文本在 `<canvas>` 上、原生 DOM 滚动不驱动），
  原生 scroll 事件也恒不触发，故必须用 xterm buffer API（`viewportY` / `baseY`）判定。
- **R2（本次采用）用 buffer.viewportY/baseY 判贴底 + onScroll 驱动 + FAB**：与 VS Code
  终端判断贴底（`_onScroll` → `viewportY >= baseY`）同源，正确且跨渲染器一致。

## 实现要点

### 渲染端（XtermTerminal.ts）
- 新增 `onScrollState: ((atBottom: boolean) => void) | null` 回调字段，`_initXterm` 内
  `term.onScroll(() => this.notifyScrollState())` 注册；初始 `_lastAtBottom = true`。
- `isAtBottom()`：`buf.viewportY >= buf.baseY - 1`（buffer 缺失时默认贴底，降级安全）。
- `notifyScrollState()`：状态翻转时才回调 `onScrollState`，省去无谓 React 渲染。
- `scrollToBottom()`：调 `term.scrollToBottom()` 后主动 `notifyScrollState()` 更新浮钮。
- 写后锁底（`flushBatched` 内 `atBottomBefore` 为真时 `term.scrollToBottom()` 后）也调
  `notifyScrollState()`，保证锁底后浮钮正确隐藏。

### React 壳（TerminalPane.tsx）
- `useState` 持 `atBottom`；实例创建时 `term.onScrollState = (bottom) => setAtBottom(bottom)`。
- 仅当 `active && !atBottom` 时渲染 `<button class="jump-bottom visible">`，点击调
  `termRef.current?.scrollToBottom()`。非 active 面板不参与滚动态（keep-alive 下隐藏）。

### 样式（app.css）
- `.jump-bottom` 绝对定位右下角，`right:14px` 以错开 xterm-viewport 右侧 10px 原生滚动条，
  满足 e2e「浮钮不与滚动条重叠」约束（Requirement 5）。`visible` 类控制显隐与淡入。

## Consequences

- 用户上滚后可一键回到底部；输入/新输出在贴底时仍自动跟随（xterm 原生 auto-follow）。
- 浮钮不参与非 active 面板的滚动态，keep-alive 多会话下互不影响。
- 单文件薄封装、契约保形等 0002/0003 约束保持；对 main/preload/App 完全透明。

## 验证

- `pnpm test`（vitest）：94 项全过，含新增 scroll-state 回调 + scrollToBottom 共 2 项单测。
- `pnpm test:e2e`（playwright）：6 项全过，`app.spec.ts:163` jump-to-bottom 验收通过。

## 关联

- 依赖 0002/0003 的 XtermTerminal 薄封装与 keep-alive（浮钮挂于 TerminalPane 的 active 面板）。
