# 15 — PtyOwnershipRegistry 类 + main 端集成

**What to build:** 创建 `PtyOwnershipRegistry` 类，替换 `main/index.ts` 中的 `dataRoutes` 和 `ptyOwners` 两个数据结构。

**Blocked by:** 02 — terminalHandlers.ts

**Status:** ready-for-agent

- [ ] 创建 `src/main/ptyOwnershipRegistry.ts`，包含完整 API（`setOwner` 1:1、`addRoute` 1:N、`remove`、`resolveVirtual`、`setVirtual`、`deleteVirtual`）
- [ ] 添加单元测试（现有先例：`sessionPool.test.ts`）
- [ ] 在 `main/index.ts`（或 handler 模块）中实例化并替换 `dataRoutes` + `ptyOwners`
- [ ] 添加 `session:query-owner` IPC handler 供 renderer 查询
- [ ] 验证 `pnpm typecheck` 和 `pnpm test` 通过