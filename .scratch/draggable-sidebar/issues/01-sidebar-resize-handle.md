Status: resolved
Blocked by: config-store/02

# 侧边栏拖拽条与实时缩放

在 `src/renderer/src/components/Sidebar.tsx`（或 `App.tsx` 内）实现：

1. 侧边栏容器加 `ref`，宽度由 state `width` 控制（初始 `config.sidebarWidth`，默认 280）。
2. 新增拖拽条 DOM（4px 宽、整高、`cursor: ew-resize`、hover 高亮），位于侧边栏右边框。
3. 拖拽逻辑：`onMouseDown` 记录 `startX` 与 `startWidth`，`document` 上挂 `mousemove`/`mouseup`；`mousemove` 计算 `clamp(startWidth + (e.clientX - startX), 200, Math.max(200, Math.floor(window.innerWidth * 0.6)))`，设置 `width`；`mouseup` 移除监听并 `pi.setConfig({ sidebarWidth: width })`。
4. 确保拖拽条不触发窗口拖拽（侧边栏非标题条拖拽区，一般无需，但显式 `no-drag` 更稳）。

验收：
- 拖动侧边栏右边框可改变宽度；松手后重启保持。
- 宽度被夹在 200px 与窗口宽 60% 之间（窗口过窄时上限取 `max(200, 60%)`，不出现下限>上限）。

依赖：config-store（02 IPC）。

## Comments

- 已实现并提交：`815a5b8`（含 Sidebar 拖拽条与 clamp 逻辑，见三个 spec.md）。
