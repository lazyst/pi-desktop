Status: resolved
Blocked by: system-tray/03

# 隐藏窗口时保持应用存活

当前 `app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); })`。由于关闭按钮改为隐藏（非关闭）窗口，需确保应用不因此退出：

- 由于 `win.hide()` 不触发 `closed`，`window-all-closed` 本不会因关闭按钮触发；但为稳妥，移除/调整该 handler，使托盘常驻时应用始终存活，真正退出只经 `before-quit`（见 issue 03）。
- macOS：`darwin` 分支本就不退出，保持；其余平台也不再因窗口"关闭"（实为隐藏）而退出。

验收：
- 点关闭（默认）后应用仍在运行（托盘在、进程在），不自动退出。
- 仅「退出」/系统关机触发真正退出。

依赖：issue 03（quitting 标志与 before-quit）。

## Comments

- 已实现并提交：`1604fa1`（`window-all-closed` 改为空操作，托盘常驻即入口，仅 `before-quit` 触发真正退出）。
