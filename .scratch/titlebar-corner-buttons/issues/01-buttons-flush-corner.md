Status: resolved

# 标题条按钮整高贴右缘

修改 `src/renderer/src/styles/app.css`：

1. `.titlebar`：`padding: 0 var(--sp-2)` → 改为 `padding-left: var(--sp-2); padding-right: 0;`（保留左侧标题内边距，右侧让按钮贴边）。
2. `.titlebar-btn`：`height: 28px` → `height: 34px`（与 `.titlebar` 的 `height: 34px` 一致），其余（width 32px、圆角、hover）保持。
3. 验收：关闭按钮右上角与窗口右上角重合；四按钮等高、紧贴右缘，外观与 VS Code/浏览器标题控件一致。

无外部依赖（纯 CSS）。

## Comments

- 已实现并提交：`815a5b8`（`.titlebar` padding 右归零、`.titlebar-btn` 高度 34px）。
