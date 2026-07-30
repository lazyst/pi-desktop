# ADR-0002: 跨 SplitLeaf Tab 拖拽（移动语义）

用单 DndContext + 多 SortableContext 架构替代 TabBar 内独立 DndContext，实现 Tab 在 SplitLeaf 间拖拽移动。

## 背景

Phase 1 实现了分屏（SplitPane）和同 leaf 内 Tab 拖拽重排，但 Tab 不能在不同 SplitLeaf 之间移动。用户需要将 Tab 从一个分屏窗格拖拽到另一个窗格，以灵活组织工作区布局（类似 VSCode Editor Group 间拖拽）。

## 决策

### 架构

- 将 DndContext 从 TabBar 提升到 SplitPane 层（新建 `SplitPaneDragProvider` 包装组件），所有 TabBar 共享同一 DndContext。
- 每个 TabBar 持有独立的 SortableContext，`id` 为所属 leaf 的 id，`items` 为该 leaf 的可见 tab id 列表。
- 利用 @dnd-kit 原生多容器排序支持，`onDragEnd` 中判断源容器和目标容器是否相同。

### 交互语义

- **移动语义**：Tab 从源 leaf 的 `tabs[]` 移除，追加到目标 leaf 的 `tabs[]`（非复制）。
- **同 leaf 拖回**：对 `reorderTabsInLeaf` 的现有行为无影响，视为同 leaf 重排。
- **源 leaf 空后**：移走 leaf 中最后一个 Tab 时，自动调用 `closeLeaf` 关闭源 leaf。
- **活跃状态**：目标 leaf 设为 `activeLeafId`，被拖拽 Tab 自动激活（`activeTabId`）。
- **去重冲突**：若目标 leaf 中已存在同一 session/diff/key，阻止 drop（`DragOverlay` 显示不可拖放标识）。
- **终端拖拽**：`integrated-terminal` Tab 允许跨 leaf 拖拽，行为同其他 Tab。

### 视觉反馈

- **DragOverlay**：拖拽时显示被拖拽 Tab 的视觉副本，跟随鼠标移动。
- **目标 leaf 高亮**：拖拽悬停在目标 leaf 上时，leaf 边框高亮。
- **插入指示线**：在目标 TabBar 中显示竖线指示插入位置。
- **不可拖放标识**：去重冲突时，DragOverlay 改变颜色/图标。

### 新增 Store Action

```typescript
moveTabAcrossLeafs(
  tabId: string,
  sourceLeafId: string,
  targetLeafId: string,
  targetIndex: number,  // 插入位置在目标 leaf 可见 tabs 中的索引
): void
```

### 范围限制

- 仅限同一 cwd 内的 leaf 之间拖拽。不同 cwd 的分屏树不同时可见，技术上不支持跨 cwd 拖拽。
- 仅限同一 cwd 的 SplitLeaf——DndContext 作用域限定在单个 SplitTree 内。

## 考虑过的方案

1. **保留 TabBar 内独立 DndContext，额外注册 leaf 为 Droppable**：@dnd-kit 不推荐嵌套 DndContext，且两个 DndContext 需要手动协调，状态管理复杂。
2. **纯原生 HTML5 Drag and Drop**：失去 @dnd-kit 的 Sortable 动画和触摸支持，需要手动实现插入位置计算和拖拽反馈。
3. **分步实现（先 store action，再组件改造，后视觉）**：store action 和组件改造耦合度高（DndContext 提升影响 TabBar 渲染结构），拆开成本大于收益。

## 后果

- TabBar 不再拥有自己的 DndContext，改为接收来自父层的 DndContext 上下文。
- 新建 `SplitPaneDragProvider` 组件，包装 `SplitPane` 树。
- 同 leaf 重排的 `onReorder` 回调不变，跨 leaf 移动由 `onDragEnd` 统一处理。
- 需要新增 `moveTabAcrossLeafs` 的测试覆盖（去重冲突、源 leaf 关闭、位置索引等）。
- @dnd-kit 的 `DragOverlay` 需要渲染 Tab 内容的副本，与 `SortableTab` 的渲染逻辑共享。