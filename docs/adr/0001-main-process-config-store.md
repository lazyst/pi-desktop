# 设置与窗口状态统一存于主进程 config.json

pi-desktop 此前把主题、置顶目录等偏好放在渲染进程的 `localStorage`，主进程零配置存储；但"记住最大化状态"和"关闭按钮行为"必须在主进程读取（窗口创建前 / 点击关闭时），`localStorage` 无法作为它们的真源。因此决定将**所有设置**（主题、置顶目录、窗口几何、侧边栏宽度、关闭行为）统一收进主进程的 `config.json`（位于 `app.getPath('userData')`），主进程为唯一真源，设置面板通过新增的 `config:get` / `config:set` IPC 读写。

**Status**: accepted

**Considered Options**
- A（现状 / `localStorage`）：渲染进程存偏好。被否——窗口级偏好主进程读不到，且两套存储易不一致。
- B（`localStorage` + 渲染同步给主进程）：启动时闪默认尺寸、关闭时序竞态，仍双源。被否。
- C（全部迁入主进程 `config.json`，设置面板走 IPC）：采纳。最干净、单一真源，代价是迁移主题/置顶目录的现有读写、改动面最大。

**Consequences**
- `config.json` 形态（节选）：
  ```jsonc
  {
    "theme": "dark",
    "pinnedDirs": ["…"],
    "window": { "maximized": false, "bounds": { "x":…, "y":…, "w":…, "h":… } },
    "sidebarWidth": 280,
    "closeBehavior": "minimize-to-tray"   // 或 "close"
  }
  ```
- 窗口几何用 `win.getNormalBounds()` 取非最大化尺寸 + `maximized` 标志，启动建窗后按需 `maximize()`，并监听 `maximize` / `unmaximize` / `resize` 实时回写。
- 关闭按钮默认 `minimize-to-tray`；`Tray` 始终常驻（右键「显示 / 退出」）。仅当 `closeBehavior` 为 `close` 时关闭按钮才真正退出；真正的退出统一走 `before-quit` 强制 `killAll`。
- 侧边栏宽度夹在 **200px 地板**与**窗口宽 60% 上限**之间，拖拽实时跟手、松手持久化；xterm 靠既有 `ResizeObserver` 自动重排。
- 标题条四按钮改整高、紧贴右缘（关闭按钮独占右上角）；窗口缩放热区在最大化时全隐藏、非最大化时让出右上角。
