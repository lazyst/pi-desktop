# 06 — updateHandlers.ts 提取 + main/index.ts 瘦身完成

**What to build:** 提取更新相关的 IPC handler，清理 `main/index.ts` 中剩余的所有 inline handler 注册，使 `main/index.ts` 从 ~1568 行缩减到 ~300 行。

**Blocked by:** 02, 03, 04, 05

**Status:** ready-for-agent

- [ ] 创建 `src/main/handlers/updateHandlers.ts`，导出 `registerUpdateHandlers(ipcMain, win)`
- [ ] 迁移 `update:check`、`update:get-status`、`update:get-current-version`、`update:download`、`update:install`、`update:cancel-download`、`onDownloadProgress`
- [ ] 清理 `main/index.ts` 中所有剩余的 inline handler（确保 `createWindow` 中只有 `register*` 调用）
- [ ] 验证 `pnpm typecheck` 和 `pnpm test` 通过
- [ ] 确认 `main/index.ts` 行数缩减到 ~300 行