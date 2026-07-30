# 09 — 删除 IntegratedTerminalPool

**What to build:** 删除已废弃的 `IntegratedTerminalPool` 文件（生产代码中无引用，仅在测试文件中被引用），更新测试文件引用。

**Blocked by:** 08 — IPtyLike 类型迁移

**Status:** ready-for-agent

- [ ] 确认 `main/index.ts` 和所有生产代码无 `IntegratedTerminalPool` 引用
- [ ] 删除 `src/main/integratedTerminalPool.ts`
- [ ] 更新 `src/main/__tests__/integratedTerminalPool.logic.test.ts` 改为引用 `UnifiedTerminalPool`
- [ ] 更新 `src/main/__tests__/integratedTerminalPool.realpty.test.ts` 改为引用 `UnifiedTerminalPool`
- [ ] 验证 `pnpm typecheck` 和 `pnpm test` 通过