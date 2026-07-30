# 07 — sessionUtils.ts 提取 + 替换重复函数

**What to build:** 将从 `sessionFileManager.ts` 和 `sessionPool.ts` 中重复的 5 个工具函数提取到 `src/main/sessionUtils.ts`。

**Blocked by:** None — can start immediately.

**Status:** completed

- [x] 创建 `src/main/sessionUtils.ts`，包含 5 个纯函数
- [x] 为 `sessionUtils.ts` 添加单元测试（15 测试全部通过）
- [x] 更新 `sessionFileManager.ts` 删除重复函数，改为导入 `sessionUtils`
- [x] 更新 `sessionPool.ts` 删除重复函数，改为导入 `sessionUtils`
- [x] 更新 `unifiedTerminalPool.ts` 改为导入 `sessionUtils`
- [x] 验证 `pnpm typecheck` 和 `pnpm test` 通过