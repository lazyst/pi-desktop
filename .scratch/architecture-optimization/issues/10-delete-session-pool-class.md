# 10 — 删除 SessionPool 类 + 测试迁移

**What to build:** 删除 `sessionPool.ts` 中的 `SessionPool` 类（已被 `UnifiedTerminalPool` 取代），将相关测试迁移到 `UnifiedTerminalPool` 的测试文件。

**Blocked by:** 08 — IPtyLike 类型迁移

**Status:** completed

- [x] 确认 `main/index.ts` 和所有生产代码无 `SessionPool` 类引用
- [x] 删除 `sessionPool.ts` 整个文件（`SessionPool` 类以及 `SessionStatus`/`SessionInfo`/`SessionGroup` 类型均不再使用）
- [x] 删除 `sessionPool.test.ts` 和 `sessionPool.realpty.test.ts`（已由 `unifiedTerminalPool.test.ts` 覆盖）
- [x] 移除 `splash.test.ts`、`openExternal.test.ts`、`integratedTerminalIpc.test.ts` 中的 `vi.mock('./sessionPool')`
- [x] 验证 `pnpm typecheck` 和 `pnpm test` 通过