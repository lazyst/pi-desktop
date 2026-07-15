Status: resolved
Blocked by: config-store/01, config-store/02

# 拦截关闭：按 closeBehavior 决定隐藏或退出

修改 `src/main/index.ts`：

1. 新增模块级 `let quitting = false;`。
2. `win.on('close', (e) => { if (quitting) return; if (getConfig().closeBehavior === 'minimize-to-tray') { e.preventDefault(); win.hide(); } })`。
   - 注意：`win.on('closed')` 当前的 `pool.killAll()` 改为仅在真正退出时执行（见 4）。
3. 托盘「退出」/ 系统级退出：`app.on('before-quit', () => { quitting = true; })`；`win.on('closed')` 内 `if (quitting) pool.killAll();`（或 `before-quit` 中直接 `pool.killAll()`）。
4. 确保 `app.quit()` 真正触发 `before-quit` → killAll → 窗口关闭。

验收：
- 默认（minimize-to-tray）：点关闭窗口消失、进程继续（托盘可恢复）。
- 切到「直接关闭」后点关闭：应用退出、进程被 kill。
- 托盘「退出」：无论设置如何都真正退出并杀进程。

依赖：config-store；与 issue 02 配对。

## Comments

- 已实现并提交：`1604fa1`（模块级 `quitting` 标志；`win.on('close')` 按 `closeBehavior` 决定 `hide()` 或 `app.quit()`；真正退出统一走 `before-quit` → `pool.killAll()`）。
