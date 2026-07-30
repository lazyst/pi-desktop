# 15 — PtyOwnershipRegistry 类 + main 端集成

**What to build:** 创建 `PtyOwnershipRegistry` 类，替换 `main/index.ts` 中的 `dataRoutes` 和 `ptyOwners` 两个数据结构。

**Blocked by:** 02 — terminalHandlers.ts

**Status:** completed

- [x] 创建 `src/main/ptyOwnershipRegistry.ts`，包含完整 API（`setOwner` 1:1、`addRoute` 1:N、`remove`、`getVirtual`、`setVirtual`、`deleteVirtual`）
- [x] 添加单元测试（18 个测试全部通过）
- [x] 在 `main/index.ts` 中实例化并替换 `dataRoutes`
- [x] 在 `terminalHandlers.ts` 中替换 `ptyOwners` Map
- [x] 添加 `session:query-owner` IPC handler 供 renderer 查询
- [x] 验证 `pnpm typecheck` 和 `pnpm test` 通过