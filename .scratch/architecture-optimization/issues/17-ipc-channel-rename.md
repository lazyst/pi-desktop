# 17 — IPC 通道命名统一：term: → terminal:

**What to build:** 将 `term:data`、`term:exit`、`term:list` 统一重命名为 `terminal:data`、`terminal:exit`、`terminal:list`，消除 `terminal:spawn` vs `term:data` 的不一致。

**Blocked by:** 02, 06, 16

**Status:** completed

- [x] 更新 `src/preload/index.ts` 中的通道名
- [x] 更新 `src/main/index.ts` 中的 `win.webContents.send` 调用
- [x] 更新 `src/main/backpressure.ts` 中的注释
- [x] 更新 `src/main/__tests__/integratedTerminalIpc.test.ts` 中的通道名和注释
- [x] 更新 `src/renderer/src/App.tsx` 中的注释
- [x] grep 确认无残留的 `'term:data'`、`'term:exit'`、`'term:list'`（注释除外）
- [x] 验证 `pnpm typecheck` 和 `pnpm test` 通过