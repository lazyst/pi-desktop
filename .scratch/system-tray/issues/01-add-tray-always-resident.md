Status: resolved
Blocked by: config-store/01

# 始终常驻的系统托盘

在 `src/main/index.ts` 中：

1. 准备托盘图标：新增 PNG 资源（如 `assets/tray-icon.png`），更新 `scripts/copy-assets.mjs` 使其在 build 后可用；主进程按 `app.isPackaged` 解析 dev（`src/...`）/ build（`resources` 或 `out`）路径。
2. `createWindow()` 内（窗口就绪后）创建 `Tray(icon)`：
   - 右键菜单：`显示`（若隐藏则 `win.show()` / 已显示则聚焦）、`退出`（`app.quit()`）。
   - 监听 `tray.on('double-click', …)` → 显示并聚焦窗口。
3. 托盘对象生命期与应用一致（始终存在，不随窗口显隐销毁）。

验收：
- 应用启动后系统托盘出现图标；双击显示窗口；右键「退出」真正退出（杀进程）。
- dev 与 `pnpm build && pnpm start` 下图标均能加载。

依赖：config-store；图标资源由本 issue 自带。

## Comments

- 已实现并提交：`1604fa1`（含 Tray 常驻、右键「显示/退出」、double-click 聚焦；托盘图标 `src/main/assets/tray-icon.png` 由 `scripts/gen-tray-icon.mjs` 生成、`copy-assets.mjs` 随构建拷贝）。
