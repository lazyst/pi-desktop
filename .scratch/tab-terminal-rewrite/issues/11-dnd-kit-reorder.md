# 11 — @dnd-kit 同 location 拖拽重排

**What to build:** 用 `@dnd-kit/core` + `@dnd-kit/sortable` 为 tab 条加上同 location 内拖拽重排（ADR-0001 的 `TabReorder`）。拖拽仅改 store 中 `order`，不碰渲染实例（keep-alive 不受影响）。editor 与 panel 各自区域内排序。

**Blocked by:** 03 — CenterPane / TabBar / TerminalDrawer 改造为从 store 取数（store 已含 `reorderTabs`）

**Status:** resolved

- [x] `TabBar` 接入 `@dnd-kit/sortable`，拖拽结束后调用 `reorderTabs(location, orderedIds)`（CenterPane 传入 `onReorder` → `reorderTabs('editor', ...)`）
- [x] 拖拽仅更新 `order`，不触发内容组件卸载/重建（内容区以 id 为 key 渲染，reorder 后 key 集合不变，keep-alive 不受影响）
- [x] editor 区与 panel 区（终端 tab）各自独立排序，不跨区（`reorderTabs('editor'|'panel', ...)` 仅作用于同 location）
- [x] 手动验证：拖动 tab 改变顺序并保持；切换/关闭其他 tab 后顺序稳定（order 持久于 store，TabBar 按 order 升序渲染）

## 实现说明

- 新增 `@dnd-kit/utilities` 依赖（sortable 的 CSS transform 工具）。
- `TabBar` / `TerminalTabBar` 以 `onReorder?: (orderedIds: string[]) => void` 为可选开关：传则包进 `DndContext` + `SortableContext`，不传则退化为纯展示（右栏固定 files/git 仍走旧路径）。
- `CenterPane` 按 `order` 升序把可见 editor tab 传给 `TabBar`；`TerminalDrawer` 按 store `tabs.order` 对 `terminals` 排序后展示，二者均订阅 store，`reorderTabs` 后视觉顺序即时跟随。
- 单测：新增 `TabBar.reorder.test.tsx`，并在 `CenterPane.test.tsx` / `TerminalDrawer.test.tsx` 补充顺序跟随 + 内容实例不重建断言。

## Answer

已完成。commit `77e69c7`（feat(issue-11)）。全量测试 357 通过，typecheck 通过。

