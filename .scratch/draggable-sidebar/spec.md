# 可拖拽侧边栏宽度

侧边栏右边框提供 4px 拖拽条，实时调整宽度并持久化；xterm 终端靠既有 `ResizeObserver` 自动重排（无需额外处理）。

来源：`docs/adr/0001`（决策④）。依赖 config-store 的 `config.sidebarWidth`。

## 行为
- 宽度区间：**下限 200px（绝对地板）**，**上限 = 窗口宽度的 60%**。
- 拖拽：mousedown 记录起点与起始宽度，mousemove 计算 `startWidth + dx` 并 clamp 到区间，实时设置侧边栏宽度；mouseup 时 `setConfig({ sidebarWidth })` 持久化。
- 初始化：挂载时读取 `config.sidebarWidth`（默认 280）应用到 `.sidebar` 的 `width`。
- 与最大化无关：侧边栏宽度是固定像素，最大化窗口不改变它（类似 VS Code）。

## 样式
- 新增拖拽条元素（4px 宽、整高、`cursor: ew-resize`、hover 淡淡高亮成强调色）；位于侧边栏右边框，与窗口右缘的 `rz-right` 缩放热区不冲突（后者在窗口最右 4px，侧边栏在其左侧）。
