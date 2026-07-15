Status: resolved
Blocked by: config-store/02

# 应用持久化的侧边栏宽度

- 在 `App` 挂载时（或 Sidebar 挂载时）异步 `pi.getConfig()` 取 `sidebarWidth`，应用到侧边栏宽度 state（默认 280）。
- 确保终端区随之变化后，既有 `TerminalPane` 的 `ResizeObserver` 自动 `fit()` + `session:resize`（无需新逻辑，仅验收）。

验收：
- 重启后侧边栏宽度等于上次松手时的值。
- 拖动过程中终端文字即时重排、不溢出。

依赖：issue 01（写）配套；ResizeObserver 已存在（见 `TerminalPane.tsx`）。

## Comments

- 已实现并提交：`815a5b8`（含 App 异步读取 config.sidebarWidth 并同步到 `<aside>` 宽度）。
