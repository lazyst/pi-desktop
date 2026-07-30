# 09 — 删除 IntegratedTerminalPool

**What to build:** 删除已废弃的 `IntegratedTerminalPool` 文件（生产代码中无引用，仅在测试文件中被引用），更新测试文件引用。

**Blocked by:** 08 — IPtyLike 类型迁移

**Status:** completed

- [x] 确认 `main/index.ts` 和所有生产代码无 `IntegratedTerminalPool` 引用
- [x] 删除 `src/main/integratedTerminalPool.ts`
- [x] 删除 `src/main/__tests__/integratedTerminalPool.logic.test.ts`（已由 `unifiedTerminalPool.test.ts` 覆盖）
- [x] 删除 `src/main/__tests__/integratedTerminalPool.realpty.test.ts`（已由 `unifiedTerminalPool.test.ts` 覆盖）
- [x] 验证 `pnpm typecheck` 和 `pnpm test` 通过