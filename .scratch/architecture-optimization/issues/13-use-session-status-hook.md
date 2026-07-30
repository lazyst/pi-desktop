# 13 — useSessionStatus hook 提取

**What to build:** 将 App.tsx 中与会话状态相关的状态（`statusMap`、`liveToDisk`、`ptyOwnersRef`）提取为 `useSessionStatus` hook。

**Blocked by:** None — can start immediately.

**Status:** completed

- [x] 创建 `src/renderer/src/hooks/useSessionStatus.ts`
- [x] hook 内部管理 `statusMap`、`liveToDisk`、`liveToDiskRef`、`ptyOwnersRef` 和 IPC 订阅
- [x] `_virtualToPty` 作为模块级变量在 `useSessionStatus.ts` 中定义并导出，App.tsx 导入使用
- [x] 在 App.tsx 中替换对应的状态、ref 和 IPC 订阅为 hook 调用
- [x] 验证 `pnpm typecheck` 和 `pnpm test` 通过