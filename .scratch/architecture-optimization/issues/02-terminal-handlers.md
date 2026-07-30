# 02 — terminalHandlers.ts 提取

**What to build:** 将 `main/index.ts` 中与终端相关的 IPC handler 注册（`terminal:spawn`、`terminal:input`、`terminal:resize`、`terminal:ack`、`terminal:destroy`、`terminal:list`、`terminal:listProfiles`、`terminal:create`、`terminal:createInAppWorkDir`、`session:terminate`、`session:register-pty-owner`、`terminal:saveBuffer`、`terminal:loadBuffer`、`terminal:updateCwd`）提取到 `src/main/handlers/terminalHandlers.ts`。

**Blocked by:** 01 — ReferenceCountedWatcher

**Status:** completed

- [x] 创建 `src/main/handlers/` 目录
- [x] 创建 `src/main/handlers/terminalHandlers.ts`，导出 `registerTerminalHandlers(ipcMain, win, unifiedPool, pushTerminalList, ensureAppWorkDir)`
- [x] 将 `main/index.ts` 中 terminal:* 相关的 IPC handler 注册移到新文件
- [x] 在 `main/index.ts` 的 `createWindow()` 末尾调用 `registerTerminalHandlers`
- [x] 验证 `pnpm typecheck` 和 `pnpm test` 通过