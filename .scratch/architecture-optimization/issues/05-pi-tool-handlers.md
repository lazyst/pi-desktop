# 05 — piToolHandlers.ts 提取

**What to build:** 将 `main/index.ts` 中与 Pi 工具配置相关的 IPC handler 提取到独立模块。这是最大的 handler 模块（~200 行），包含 settings、models、MCP、skills、extensions 的管理。

**Blocked by:** 01 — ReferenceCountedWatcher

**Status:** ready-for-agent

- [ ] 创建 `src/main/handlers/piToolHandlers.ts`，导出 `registerPiToolHandlers(ipcMain, win, piAgentDir)`
- [ ] 迁移 `pi:settings:get/set`、`pi:models:get/set`、`pi:mcp:configs`、`pi:mcp:configs:save`、`pi:mcp:status`
- [ ] 迁移 `pi:skills:list`、`pi:skills:disable/enable/delete`、`pi:skills:refreshCache`、`pi:skills:batchDisable`、`pi:skills:batchDelete`
- [ ] 迁移 `pi:extensions:list`、`pi:extensions:disable/enable/delete`
- [ ] 迁移 `app:openExternal`、`fs:openWithSystem`、`fs:showInFolder`
- [ ] 在 `main/index.ts` 中调用 `registerPiToolHandlers`
- [ ] 验证 `pnpm typecheck` 和 `pnpm test` 通过