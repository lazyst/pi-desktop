# 系统托盘与关闭行为

应用支持后台运行：点击标题条关闭按钮时**默认最小化到系统托盘**（pi 进程继续跑），并在设置面板提供「直接关闭 / 最小化到托盘」切换。托盘**始终常驻**。

来源：`docs/adr/0001`（决策③）。依赖 config-store 的 `config.closeBehavior`。

## 行为
- 托盘：启动时即创建 `Tray`（需图标资源，dev 与 build 路径分别解析）；右键菜单含「显示」「退出」；双击托盘图标显示并聚焦窗口。
- 关闭按钮语义（`config.closeBehavior`）：
  - `minimize-to-tray`（默认）：`win.on('close')` 中 `preventDefault()` + `win.hide()`，不杀进程。
  - `close`：允许关闭 → 真正退出。
- 真正退出：统一走 `before-quit`（置 `quitting` 标志）→ `pool.killAll()` + `app.quit()`。托盘「退出」与系统级 quit 都触发它。
- 生命周期：窗口隐藏（非关闭）时应用保持存活；`app.on('window-all-closed')` 不再因窗口关闭而退出（托盘常驻即入口）。

## 图标资源
- 在 `src/renderer/src/assets/`（或合适位置）放置托盘 PNG（建议 16×16 / 32×32，Windows 亦可 ICO）；`scripts/copy-assets.mjs` 需随构建拷贝；主进程用 `app.isPackaged` 区分 dev / build 路径解析。
