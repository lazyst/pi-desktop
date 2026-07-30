# 01 — ReferenceCountedWatcher 提取 + 替换 3 个 watcher

**What to build:** 将 `main/index.ts` 中 3 份几乎相同的引用计数 watcher 模式（`dirWatchers`、`fileWatchers`、`gitWatchers`）提取为可复用的 `ReferenceCountedWatcher` 类，替换所有 3 处使用。

**Blocked by:** None — can start immediately.

**Status:** completed

- [x] 在 `src/main/shared/ReferenceCountedWatcher.ts` 中创建类，`watch` 回调签名为 `(key: TKey) => () => void`（返回 stop 函数）
- [x] 为 `ReferenceCountedWatcher` 添加单元测试（8 测试全部通过）
- [x] 替换 `main/index.ts` 中的 `dirWatchers` → `ReferenceCountedWatcher`
- [x] 替换 `main/index.ts` 中的 `fileWatchers` → `ReferenceCountedWatcher`
- [x] 替换 `main/index.ts` 中的 `gitWatchers` → `ReferenceCountedWatcher`
- [x] 验证 `pnpm typecheck` 和 `pnpm test` 通过