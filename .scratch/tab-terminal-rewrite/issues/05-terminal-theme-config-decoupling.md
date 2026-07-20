# 05 — 终端主题与配置解耦（参考 orca）

**What to build:** 在**保持 xterm 6.0 引擎不变**的前提下，按 orca 思路重配终端配置。抽出 `terminal-themes`（对齐 orca `lib/terminal-themes`），主题切换经统一 `onThemeChange` 刷新 xterm 并 `forceRedraw` 清 WebGL 纹理残留；全局字号 `onFontSizeChange` 同步 `term.options.fontSize` + `doResize` + `forceRedraw`。消除现有散落在 `XtermTerminal` 内的主题/字号响应逻辑。

**Blocked by:** 03 — CenterPane / TabBar / TerminalDrawer 改造为从 store 取数

**Status:** ready-for-agent

- [x] 新建终端主题模块，导出 dark/light 主题对象
- [x] 主题切换统一经 `onThemeChange` 回调刷新所有存活终端实例并 `forceRedraw`
- [x] 字号变化经 `onFontSizeChange` 同步 fontSize + resize + forceRedraw
- [x] 手动验证：切换明暗主题 / 调整全局字号，终端配色与字形纹理无残留闪烁（xterm 引擎不变，逻辑解耦）

## 实现说明

- 新建 `src/renderer/src/lib/terminal-themes.ts`（对齐 orca `lib/terminal-theme.ts` /
  `terminal-themes-data.ts`）：抽出 16 色 ANSI + 选区 + 滚动条滑块的 GitHub 官方暗/亮调色板，
  提供 `getTermTheme(theme)` / `TERM_THEMES` / `resolveTerminalBackground` / `resolveTerminalForeground`，
  背景/前景运行时从容器 `--bg-app` / `--text` 读取（保持「背景跟随容器」语义）。
- 新建 `src/renderer/src/lib/terminal-registry.ts`：单点订阅 `onThemeChange` / `onFontSizeChange`，
  统一经存活实例的 `applyTheme` / `applyFontSize` 刷新所有 live 终端并 `forceRedraw`，
  避免 N 个实例各自订阅。`XtermTerminal` 在 `mount` 时 `registerTerminal`、
  `unmount` 时 `unregisterTerminal`；`applyTheme`/`applyFontSize` 实现 `LiveTerminal` 接口。
- `XtermTerminal` 移除原先散落的 `offTheme` / `offFontSize` 字段与内联订阅，
  改为 registry 驱动；构造期仍取当前主题/字号作为初始值。
- `theme.ts` 改为委托导出 `getTermTheme` / `TERM_THEMES`（向后兼容），不再重复维护调色板。
- 测试：`lib/__tests__/terminal-themes.test.ts`（与 tokens.css 同源守护）、
  `lib/__tests__/terminal-registry.test.ts`（单点订阅批量刷新、注销后不再刷新）。
