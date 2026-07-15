Status: resolved
Blocked by: config-store/02

# 置顶目录迁移到 config（脱离 localStorage）

`src/renderer/src/App.tsx` 当前用 `localStorage`（键 `pi-desktop:pinned-dirs`）存取置顶目录数组。改为存于 `config.pinnedDirs`：

- `readPinned()`：改为从 `pi.getConfig().pinnedDirs` 读取（数组容错，非数组回退 `[]`）。
- `handleTogglePin`：计算 `next` 后 `pi.setConfig({ pinnedDirs: next })` 持久化，移除 `localStorage.setItem`。
- 启动时需先 `await pi.getConfig()` 初始化 `pinned` 状态（或 App 挂载时异步拉取）。

验收：
- 置顶/取消置顶后重启保持。
- 不再读写 `localStorage` 的 pinned 键。

依赖：config-store/02 提供 IPC。

## Comments

- 已实现并提交：\`5a757ad\`（App.tsx 置顶目录脱离 localStorage 走 config IPC）。
