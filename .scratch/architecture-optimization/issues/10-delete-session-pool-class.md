# 10 — 删除 SessionPool 类 + 测试迁移

**What to build:** 删除 `sessionPool.ts` 中的 `SessionPool` 类（已被 `UnifiedTerminalPool` 取代），将相关测试迁移到 `UnifiedTerminalPool` 的测试文件。

**Blocked by:** 08 — IPtyLike 类型迁移

**Status:** ready-for-agent

- [ ] 确认 `main/index.ts` 和所有生产代码无 `SessionPool` 类引用
- [ ] 删除 `sessionPool.ts` 中的 `SessionPool` 类（保留 `SessionStatus`/`SessionInfo`/`SessionGroup` 如果被引用，否则一并删除）
- [ ] 迁移 `sessionPool.test.ts` 中与 `SessionPool` 类相关的测试 → `unifiedTerminalPool.test.ts`
- [ ] 迁移 `sessionPool.test.ts` 中与工具函数相关的测试 → `sessionUtils.test.ts`
- [ ] 迁移 `sessionPool.realpty.test.ts` 中与 `SessionPool` 类相关的测试 → `unifiedTerminalPool.realpty.test.ts`
- [ ] 验证 `pnpm typecheck` 和 `pnpm test` 通过