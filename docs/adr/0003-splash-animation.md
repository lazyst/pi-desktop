# ADR-0003: 启动动画（Splash）实现方式

## 状态
已采纳（2025）

## 背景
无边框窗口（`frame: false`）在内容异步加载时，若 `show: true` 创建会先闪一下白框再显示
React 首屏。用户希望加一个启动动画，且要求：
- 主进程就绪前即显示（方案 B，非纯渲染层 overlay）
- 极简风格：居中 π logo + 脉冲点（方案 a）
- 仅在「真冷启动」显示，托盘恢复/二次显示不重播
- 尊重 `prefers-reduced-motion`

## 决策
1. **窗口 `show: false` 创建**，`ready-to-show` 不自动显示；由 renderer 首屏就绪后经
   `splash:done` IPC 通知主进程 `win.show()`，规避无边框白闪。
2. **splash 为 `index.html` 中的静态 DOM overlay**（`#splash`），内联 CSS，浏览器解析即渲染，
   **无需等待 React 挂载**——满足「主进程就绪前显示」且零独立窗口、零二次 `load`。
3. **首屏就绪判定 = App 挂载即就绪**：`App` 的 `useEffect` 末尾（rAF 后）给 `#splash` 加
   `.splash--hidden` 触发 CSS 淡出，并调 `pi.splashDone()`。不等待 sessions 数据回填。
4. **仅冷启动显示**：splash 逻辑只在 `createWindow` 的冷启动路径触发；托盘恢复走
   `showWindow()`（`win.show()`），不重播；splash DOM 在首次淡出后被 `remove()`，二次显示无遮挡。
5. **兜底**：若渲染进程 3s 内未通知（异常/未挂载），强制 `win.show()`，避免窗口永远不可见。
6. **无障碍**：splash 的动画/过渡复用全局 `prefers-reduced-motion` 规则（CSS `@media` 已禁用
   transition/animation），reduced-motion 下 splash 直接隐藏、无动画。
7. **主题一致**：splash 用 `var(--bg-app)` / `var(--accent)` 等 CSS 变量，随 dark/light 主题自动适配。

## 影响
- 主进程：`createWindow` 增加 `show: false` + `ipcMain.on('splash:done')` + 3s 兜底。
- 渲染：`index.html` 增加 `#splash` 静态节点；`App.tsx` 挂载后淡出并通知；`ipc.ts`/`preload` 增加 `splashDone`。
- 测试：`App.test.tsx` 验证挂载后调用 `splashDone` 且 `#splash` 获得隐藏类；`splash.test.ts` 验证
  `show:false` 创建 + `splash:done` → `show()` 且仅一次。
