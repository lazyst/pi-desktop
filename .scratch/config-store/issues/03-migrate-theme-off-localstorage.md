Status: ready-for-agent
Blocked by: config-store/02

# 主题迁移到 config（脱离 localStorage）

`src/renderer/src/theme.ts` 当前用 `localStorage`（键 `pi-desktop:theme`）存取主题。改为：

- 初始主题：启动时经 `pi.getConfig()` 取 `theme`，回退 `'dark'`；保留模块加载即 `paint()` 以避免首屏闪烁（可从 config 同步读取）。
- 切换主题：`setTheme(t)` 仍本地 `paint()`（乐观应用，避免回程闪烁），同时 `pi.setConfig({ theme: t })` 持久化。
- 删除 `localStorage` 相关代码与 `THEME_KEY`。
- 更新 `src/renderer/src/__tests__/theme.test.ts`：原测试断言 `localStorage.getItem('pi-desktop:theme')`，改为断言经 `config:set` 调用（用 mocked `window.pi` 或测试桩）。

验收：
- 切换主题后重启（或重新读取 config）主题保持。
- 主题单测通过，不再依赖 `localStorage`。

依赖：config-store/02 提供 IPC。
