# 记住窗口状态（最大化 + 几何）

启动 pi-desktop 时还原上次的窗口几何与最大化状态，而非永远 1100×720 居中。

来源：`docs/adr/0001`（决策②）。依赖 config-store 的 `config.window`。

## 行为
- 持久化内容：`config.window = { maximized: boolean, bounds: {x,y,width,height} }`，其中 `bounds` 用 `win.getNormalBounds()` 取**非最大化几何**（规避最大化时 `getBounds()` 返回铺满尺寸）。
- 写入时机：监听 `win` 的 `maximize` / `unmaximize` / `resize`，实时（防抖）回写。
- 读取时机：`createWindow()` 内、创建 `BrowserWindow` 时用 `config.window.bounds` 作初始 `width/height/x/y`；若 `maximized` 为真，建窗后调用 `win.maximize()`。

## 默认值
- 无配置时维持现状：1100×720、非最大化（居中由 Electron 默认）。
