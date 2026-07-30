# 16 — PtyOwnershipRegistry renderer 端集成

**What to build:** 将 App.tsx 中的 `ptyOwnersRef` 和 `_virtualToPty` 替换为通过 `session:query-owner` IPC 通道查询 `PtyOwnershipRegistry`。

**Blocked by:** 14 — useSidebarState hook, 15 — PtyOwnershipRegistry main

**Status:** completed

- [x] 在 `App.tsx` 中替换 `_virtualToPty` 为 `queryPtyOwner` IPC 查询
- [x] 在 `App.tsx` 中替换 `handleOpen` 中的虚拟 session 路由逻辑为 IPC 查询
- [x] 在 `App.tsx` 中替换 `handleTerminate` 中的虚拟 session 终止逻辑为 IPC 查询
- [x] 移除 `_virtualToPty` 导入
- [x] 验证 `pnpm typecheck` 和 `pnpm test` 通过