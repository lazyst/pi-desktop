# 标题条按钮贴角

标题条四个按钮（设置/最小化/最大化/关闭）改为**整高 34px、紧贴右缘**，使关闭按钮独占窗口右上角——用户甩鼠标到最角即可命中关闭。窗口缩放热区**随最大化状态切换**：最大化时全隐藏（最大化本不能拖边），非最大化时让出右上角。

来源：`docs/adr/0001`（决策⑤）。

## 样式变更（app.css）
- `.titlebar` 去掉右内边距（如 `padding: 0 var(--sp-2)` → 左留、右为 0），使 `.titlebar-actions` 贴右缘。
- `.titlebar-btn` 高度由 28px 改为 34px（与 `.titlebar` 同高），四个按钮视觉与 VS Code/浏览器一致。

## 缩放热区变更
- `WindowResizeZones` 订阅已有的 `onMaximizeChange`：
  - **最大化**：隐藏全部 8 个热区。
  - **非最大化**：保留缩放，但让出右上角——`rz-top` 改 `right: 36px`（停在最右 36px 外）、`rz-right` 改 `top: 34px`（从标题条下方开始）、删除 `rz-top-right`。
  - 其余 top / left / bottom / 左下 / 右下 角热区保留。
