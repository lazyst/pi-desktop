# 08 — IPtyLike 类型迁移到 src/main/types.ts

**What to build:** 将 `IPtyLike` 接口从 `sessionPool.ts` 迁移到 `src/main/types.ts`，更新所有引用点。

**Blocked by:** 07 — sessionUtils.ts

**Status:** completed

- [x] 创建 `src/main/types.ts`，将 `IPtyLike` 接口移入
- [x] 更新 `sessionPool.ts` 删除 `IPtyLike` 定义，改为从 `./types` 导入
- [x] 更新 `main/index.ts` 中 `import type { IPtyLike }` 的路径（从 `./sessionPool` → `./types`）
- [x] 验证 `pnpm typecheck` 和 `pnpm test` 通过（26 sessionPool 测试全部通过）