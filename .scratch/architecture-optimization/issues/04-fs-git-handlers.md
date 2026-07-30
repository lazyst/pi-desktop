# 04 — fsHandlers.ts + gitHandlers.ts 提取

**What to build:** 将 `main/index.ts` 中与文件系统和 Git 相关的 IPC handler 提取到独立模块。

**Blocked by:** 01 — ReferenceCountedWatcher

**Status:** completed

- [x] 创建 `src/main/handlers/fsHandlers.ts`，导出 `registerFsHandlers(ipcMain, win)`
- [x] 迁移 `fs:listDir`、`fs:readFile`、`fs:writeFile`、`fs:stat`、`fs:mkdir`、`fs:createFile`、`fs:rename`、`fs:remove`、`fs:copy`、`fs:listNames`、`fs:uniqueName`、`fs:openWithSystem`、`fs:showInFolder`、`fs:watch`/`unwatch`、`fs:watchFile`/`unwatchFile`、`app:openExternal`
- [x] 创建 `src/main/handlers/gitHandlers.ts`，导出 `registerGitHandlers(ipcMain, win)`
- [x] 迁移 `git:status`、`git:log`、`git:diff`、`git:fileStatusMap`、`git:ignoredPaths`、`git:watch`/`unwatch`
- [x] 在 `main/index.ts` 中调用新的 register 函数
- [x] 验证 `pnpm typecheck` 和 `pnpm test` 通过