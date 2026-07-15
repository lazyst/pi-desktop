Status: resolved
Blocked by: config-store/02

# 关闭行为设置项（设置面板）

在设置面板暴露「关闭按钮行为」切换，写 `config.closeBehavior`（默认 `minimize-to-tray`）：

- `src/renderer/src/components/SettingsPanel.tsx`：新增一行「关闭按钮」+ 分段控件（`直接关闭` / `最小化到托盘`），当前值取 `pi.getConfig().closeBehavior`，切换时 `pi.setConfig({ closeBehavior })`。
- 类型：在 `AppConfig` 中 `closeBehavior: 'close' | 'minimize-to-tray'`，默认 `'minimize-to-tray'`。

验收：
- 设置面板可切到「直接关闭」并持久化；重启后保持。
- 切到「直接关闭」后，点击关闭按钮真正退出（配合 issue 03）。

依赖：config-store（02 IPC）；与 issue 03 配对生效。

## Comments

- 已实现并提交：`1604fa1`（SettingsPanel 新增「关闭按钮」分段控件，经 `pi.getConfig()/setConfig` 读写字 `config.closeBehavior` 并持久化）。
