# 03 — sessionHandlers.ts + configHandlers.ts 提取

**What to build:** 将 `main/index.ts` 中与会话和配置相关的 IPC handler 提取到独立模块。

**Blocked by:** 01 — ReferenceCountedWatcher

**Status:** completed

- [x] 创建 `src/main/handlers/sessionHandlers.ts`，导出 `registerSessionHandlers(ipcMain, win, sessionFileManager, unifiedPool, sessionsDir)`
- [x] 迁移 `session:list`、`session:readContent`、`session:delete`、`session:deleteMany`、`session:clearDirectory`、`session:debug`、`session:pickDirectory`、`session:saveImage` 以及 `pushIndex` + `fs.watch` 推送
- [x] 创建 `src/main/handlers/configHandlers.ts`，导出 `registerConfigHandlers(ipcMain, win, getConfig, setConfig)`
- [x] 迁移 `config:*` 和 `window:*` handler
- [x] 在 `main/index.ts` 中调用新的 register 函数
- [x] 验证 `pnpm typecheck` 和 `pnpm test` 通过