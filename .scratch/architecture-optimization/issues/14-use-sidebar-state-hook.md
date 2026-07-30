# 14 — useSidebarState hook 提取

**What to build:** 将 App.tsx 中与侧边栏相关的状态（`disk`、`pinned`、`addedDirs`、`appWorkDir`、`sidebarWidth`、`collapsedGroups`、`liveUnsaved`、`virtualSessions`）提取为 `useSidebarState` hook。

**Blocked by:** 12 — usePanelLayout, 13 — useSessionStatus

**Status:** completed

- [x] 创建 `src/renderer/src/hooks/useSidebarState.ts`
- [x] hook 内部管理侧边栏数据源和 IPC 订阅（`pi.onIndex`、`pi.getConfig`）
- [x] 封装侧边栏数据的派生逻辑（`disk` + `liveUnsaved` + `virtualSessions` + `addedDirs` + `appWorkDir` 的合并）
- [x] 在 App.tsx 中替换对应的状态和 handler
- [x] 验证 `pnpm typecheck` 和 `pnpm test` 通过