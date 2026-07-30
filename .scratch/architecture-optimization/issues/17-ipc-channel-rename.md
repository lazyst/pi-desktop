# 17 — IPC 通道命名统一：term: → terminal:

**What to build:** 将 `term:data`、`term:exit`、`term:list` 统一重命名为 `terminal:data`、`terminal:exit`、`terminal:list`，消除 `terminal:spawn` vs `term:data` 的不一致。

**Blocked by:** 02, 06, 16

**Status:** ready-for-agent

- [ ] 更新 `src/preload/index.ts` 中的通道名
- [ ] 更新 `src/main/index.ts`（或 handler 模块）中的 `win.webContents.send` 调用
- [ ] 更新 `src/renderer/src/ipc.ts` 中的接口方法名
- [ ] 更新 `src/renderer/src/App.tsx` 中的订阅方法
- [ ] 更新 `src/renderer/src/components/IntegratedPane.tsx` 中的引用
- [ ] 更新 `src/renderer/src/components/XtermTerminal.ts` 中的引用
- [ ] 更新 `src/renderer/src/components/terminalChannel.ts` 中的引用
- [ ] 更新 `src/main/__tests__/integratedTerminalIpc.test.ts` 中的通道名
- [ ] 更新 `src/main/backpressure.ts` 中的注释
- [ ] grep 确认无残留的 `term:data`、`term:exit`、`term:list`（注释除外）
- [ ] 验证 `pnpm typecheck` 和 `pnpm test` 通过