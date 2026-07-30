# 16 — PtyOwnershipRegistry renderer 端集成

**What to build:** 将 App.tsx 中的 `ptyOwnersRef` 和 `_virtualToPty` 替换为通过 `session:query-owner` IPC 通道查询 `PtyOwnershipRegistry`。

**Blocked by:** 14 — useSidebarState hook, 15 — PtyOwnershipRegistry main

**Status:** ready-for-agent

- [ ] 在 App.tsx 中替换 `ptyOwnersRef` 为通过 IPC 查询 `PtyOwnershipRegistry`
- [ ] 替换 `_virtualToPty` 模块级 Map 的引用为 IPC 查询
- [ ] 更新 `handleOpen` 中的虚拟 session 路由逻辑
- [ ] 更新 `handleTerminate` 中的虚拟 session 终止逻辑
- [ ] 更新 `onExit` 和 `onNewFromPi` 中的 PTY 清理逻辑
- [ ] 验证 `pnpm typecheck` 和 `pnpm test` 通过