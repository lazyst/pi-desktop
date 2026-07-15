Status: resolved

# 缩放热区随最大化状态开关

修改 `src/renderer/src/components/WindowResizeZones.tsx`：

1. 组件内新增 `maximized` state，由 `pi.onMaximizeChange?.(setMaximized)` 初始化（复用已有 IPC，与 `TitleBar` 一致）。
2. 渲染时：若 `maximized` 为 true，**不渲染任何** `.rz-*` 热区（返回 null 或空 fragment）。
3. 若 `maximized` 为 false，渲染热区但调整 CSS（在 `app.css` 或内联）：
   - 删除 `rz-top-right`。
   - `rz-top`：`right: 36px`（避开最右 36px 的关闭按钮列）。
   - `rz-right`：`top: 34px`（从标题条下方开始，避开右上角那一截）。
   - 其余 `rz-bottom` / `rz-left` / `rz-bottom-left` / `rz-bottom-right` / `rz-top-left` 不变。

验收：
- 非最大化：可拖顶部边（除关闭按钮列）、右边（标题条下方）、各保留角缩放；右上角点关闭不触发缩放。
- 最大化：边缘无任何缩放热区，右上角干净归关闭按钮。

## Comments

- 已实现并提交：`815a5b8`（WindowResizeZones 订阅 onMaximizeChange，最大化返回 null，非最大化渲染 7 个热区并让出右上角）。
