# 12 — usePanelLayout hook 提取

**What to build:** 将 App.tsx 中与面板布局相关的状态（`sidebarWidth`、`rightPanelWidth`、`sidebarCollapsed`、`rightPanelCollapsed`）提取为 `usePanelLayout` hook。

**Blocked by:** None — can start immediately.

**Status:** completed

- [x] 创建 `src/renderer/src/hooks/` 目录
- [x] 创建 `src/renderer/src/hooks/usePanelLayout.ts`，包含面板宽度和折叠状态的管理
- [x] hook 提供 `initFromConfig` 从 config 初始化
- [x] 在 App.tsx 中替换对应的 4 个 useState + 4 个 handler 为 hook 调用
- [x] 验证 `pnpm typecheck` 和 `pnpm test` 通过