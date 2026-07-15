Status: resolved
Blocked by: config-store/01, config-store/02

# 持久化并还原窗口几何与最大化

在 `src/main/index.ts` 的 `createWindow()` 中：

1. 读取 `getConfig().window`（默认 `{ maximized:false, bounds:{ width:1100, height:720 } }`）。
2. 用 `bounds` 作为 `new BrowserWindow({ width, height, x, y })` 初始几何（保留 `frame:false` 等现有选项）。
3. 若 `maximized` 为真，建窗后 `win.maximize()`。
4. 监听 `win.on('maximize' | 'unmaximize' | 'resize')`，防抖（~200ms）后 `setConfig({ window: { maximized: win.isMaximized(), bounds: win.getNormalBounds() } })`。

验收：
- 把窗口拖小/挪位后关闭再开，尺寸与位置保持。
- 最大化后关闭再开，仍最大化；还原后回到上次非最大化尺寸。
- 多显示器/越界边界等极端情况可后续处理，本次不强制。

依赖：config-store 的 `getConfig` / `setConfig` 与 `config.window` 形状。

## Comments

- 已实现并提交：`815a5b8`（含 `windowState.ts` 的 `snapshotWindowState` / `initialBoundsOptions` 与 createWindow 中的还原 + 防抖回写）。
