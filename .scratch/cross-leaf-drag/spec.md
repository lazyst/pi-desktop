# 跨 SplitLeaf Tab 拖拽功能

Status: ready-for-agent

## Problem Statement

当前中间区支持分屏（SplitPane），每个 SplitLeaf 拥有独立的 Tab 列表和 TabBar。但 Tab 只能在同一 SplitLeaf 内拖拽重排，无法在不同 SplitLeaf 之间移动。当用户需要将一个 Tab 从左侧分屏移到右侧分屏时，只能关闭 Tab 后在目标分屏中重新打开，操作繁琐且丢失上下文（如终端会话状态）。

## Solution

为 Tab 引入跨 SplitLeaf 拖拽移动功能。用户可以将 Tab 从一个 SplitLeaf 拖拽到同一 cwd 下的另一个 SplitLeaf 中。Tab 从源 leaf 的 tabs 列表中移除，追加到目标 leaf 的 tabs 列表中。拖拽过程中提供完整的视觉反馈：DragOverlay（幽灵拖拽副本）、目标 leaf 边框高亮、插入位置指示线。

## User Stories

1. 作为用户，我可以在一个 SplitLeaf 中按住 Tab 并拖拽到另一个 SplitLeaf 的 TabBar 中，以便将 Tab 移动到目标分屏
2. 作为用户，拖拽过程中可以看到被拖拽 Tab 的视觉副本（DragOverlay）跟随鼠标移动，以便知道我正在拖拽哪个 Tab
3. 作为用户，拖拽悬停在目标 SplitLeaf 的 TabBar 上时，可以看到该 leaf 边框高亮，以便知道目标分屏是哪个
4. 作为用户，拖拽悬停在目标 SplitLeaf 的 TabBar 中时，可以在 Tab 之间看到插入位置指示线，以便知道 Tab 将被插入到哪个位置
5. 作为用户，将 Tab 拖到目标 SplitLeaf 的 TabBar 空白区域时，Tab 被追加到该 leaf 的 tabs 列表末尾，以便快速移动到末尾
6. 作为用户，将 Tab 拖到目标 SplitLeaf 的特定 Tab 上时，Tab 被插入到该 Tab 前面，以便精确控制 Tab 顺序
7. 作为用户，将 Tab 拖拽回同一个 SplitLeaf 时，Tab 按拖拽位置重排（同 leaf 内重排），以便我可以在同一 leaf 中调整 Tab 顺序
8. 作为用户，当我拖拽移走一个 SplitLeaf 中的最后一个 Tab 时，该 SplitLeaf 被自动关闭（合并回兄弟），以便我不需要手动清理空分屏
9. 作为用户，拖拽结束后，目标 SplitLeaf 成为活跃 leaf，被拖拽的 Tab 自动激活，以便我可以立即开始使用该 Tab
10. 作为用户，如果拖拽的 session/diff 在目标 SplitLeaf 中已存在，拖拽被阻止（DragOverlay 显示不可拖放标识），以便避免重复 Tab
11. 作为用户，终端 Tab（integrated-terminal）也可以跨 SplitLeaf 拖拽，行为同其他 Tab 一致，以便我可以灵活组织终端布局
12. 作为用户，拖拽范围仅限于同一 cwd 内的 SplitLeaf 之间，不同 cwd 的分屏树不相互影响，以便保持工作目录的语义隔离

## Implementation Decisions

### 1. 架构：单 DndContext + 多 SortableContext

将 DndContext 从 TabBar 提升到 SplitPane 层，新建 `SplitPaneDragProvider` 包装组件。所有 TabBar 共享同一 DndContext，每个 TabBar 持有独立的 SortableContext（`id` 为所属 leafId，`items` 为可见 tab id 列表）。利用 @dnd-kit 原生多容器排序支持。

### 2. 新增 Store Action：moveTabAcrossLeafs

```typescript
moveTabAcrossLeafs(
  tabId: string,
  sourceLeafId: string,
  targetLeafId: string,
  targetIndex: number,  // 插入位置在目标 leaf 可见 tabs 中的索引
): void
```

行为：
- 将 tab 从 sourceLeaf 的 `tabs[]` 中移除
- 若 sourceLeaf 的 `tabs[]` 变为空，自动调用 `closeLeaf`
- 将 tab 插入到 targetLeaf 的 `tabs[]` 中指定位置
- 更新 `activeTabId` 为被拖拽的 tab（在目标 leaf 上）
- 更新 `activeLeafId` 为 targetLeafId
- 若目标 leaf 中已存在同一 key（session/diff），不执行任何操作（由调用方阻止 drop）

### 3. 去重检查：canMoveTabToLeaf

在 store 中新增辅助函数，判断指定 tab 是否可以移动到目标 leaf：

```typescript
function canMoveTabToLeaf(
  tab: Tab,
  targetLeaf: SplitLeaf,
  cwdTrees: Record<string, SplitTree>,
): boolean
```

- 对 session tab：检查目标 leaf 中是否有同 key 的 session tab
- 对 diff tab：检查目标 leaf 中是否有同 commitHash 的 diff tab
- 对 preview tab：检查目标 leaf 中是否有同 path 的 preview tab
- 对 terminal tab：始终允许（终端 id 全局唯一）
- 对 session-content tab：始终允许（基于 sessionKey，也全局唯一）

### 4. SplitPaneDragProvider 组件

新建 `SplitPaneDragProvider` 组件，负责：
- 持有 DndContext
- 管理 DragOverlay 渲染
- 处理 `onDragStart`（记录拖拽的 tab 信息）
- 处理 `onDragOver`（检测进入/离开目标 leaf，更新高亮状态）
- 处理 `onDragEnd`（判断同 leaf / 跨 leaf，调用对应 action）
- 提供 leaf 级 droppable 区域检测（拖到 TabBar 空白区域时定位到 leaf 容器）

渲染结构：
```
<SplitPaneDragProvider>
  <SplitPane>
    ...
  </SplitPane>
</SplitPaneDragProvider>
```

### 5. TabBar 改造

- 移除 TabBar 内的 DndContext，保留 SortableContext
- 非 dnd 分支（无 `onReorder`）保留纯展示，不改动
- dnd 分支的 `onDragEnd` 逻辑移到父层 `SplitPaneDragProvider` 的 DndContext 中
- `SortableContext` 的 `items` 为该 leaf 的可见 tab id 列表
- 新增 `onDragOver` 事件冒泡（通过 @dnd-kit 的 `DndContext` 自动处理）

### 6. DragOverlay 视觉

DragOverlay 渲染被拖拽 Tab 的视觉副本，与 SortableTab 的渲染结构一致：
- 图标 + 标题 + 关闭按钮，但关闭按钮不可交互
- 拖拽过程中源 Tab 位置保持占位（半透明）

### 7. 目标 leaf 高亮

通过 CSS class `.split-pane-leaf--drag-over` 实现：
- 拖拽悬停时 leaf 边框使用 `var(--accent)` 颜色
- 使用 `border: 2px solid var(--accent)` 或 `box-shadow` 实现
- 拖拽离开或 drop 后移除

### 8. 插入位置指示线

利用 @dnd-kit 的 `SortableContext` 排序反馈：
- 跨 leaf 拖拽时，目标 leaf 的 SortableContext 自动计算插入位置
- 通过 CSS class `.sortable-item--drop-before` 实现视觉指示

### 9. 去重冲突视觉

当 `canMoveTabToLeaf` 返回 false 时：
- `onDragOver` 中检测并设置 `canDrop: false` 状态
- DragOverlay 添加 `.drag-overlay--invalid` class（红色调或禁止图标）
- 松开鼠标时不执行任何操作（`onDragEnd` 中跳过）

### 10. 修改模块

- `src/renderer/src/store/splitStore.ts` — 新增 `moveTabAcrossLeafs` action + `canMoveTabToLeaf` 辅助函数
- `src/renderer/src/components/SplitPane.tsx` — 新增 `SplitPaneDragProvider` 组件，包装 SplitPane 渲染树
- `src/renderer/src/components/TabBar.tsx` — 移除 DndContext（dnd 分支），保留 SortableContext
- `src/renderer/src/styles/app.css` — 新增 `.split-pane-leaf--drag-over`、`.drag-overlay`、`.drag-overlay--invalid` 样式

## Testing Decisions

### 测试策略

- 只测试外部行为，不测试实现细节
- 优先使用现有测试 seam（splitStore.test.ts），减少新 seam 的引入

### 测试模块

1. **splitStore.test.ts**（现有 seam，扩展测试用例）：
   - `moveTabAcrossLeafs` 将 tab 从 leaf A 移动到 leaf B
   - `moveTabAcrossLeafs` 移走最后一个 tab 后源 leaf 被关闭
   - `moveTabAcrossLeafs` 支持指定插入位置（索引 0 / 中间 / 末尾）
   - `moveTabAcrossLeafs` 后目标 leaf 的 activeTabId 更新为被拖拽的 tab
   - `moveTabAcrossLeafs` 后 activeLeafId 更新为目标 leaf
   - `canMoveTabToLeaf` 返回 true 当目标 leaf 无同 key tab
   - `canMoveTabToLeaf` 返回 false 当目标 leaf 已有同 session key
   - `canMoveTabToLeaf` 返回 false 当目标 leaf 已有同 commitHash diff
   - 终端 tab 始终允许跨 leaf 移动
   - 同 leaf 移动（sourceLeafId === targetLeafId）由 reorderTabsInLeaf 处理，不受影响

2. **SplitPane.test.tsx**（现有 seam，扩展）：
   - 渲染 SplitPaneDragProvider 后 DndContext 包裹所有 leaf 的 TabBar
   - 拖拽到 leaf 空白区域时触发 leaf 级 droppable

### 不测试

- DragOverlay 的具体渲染内容（jsdom 无法精确测试拖拽叠加层）
- 鼠标事件序列（需要在 e2e 层测试）
- CSS 动画效果

## Out of Scope

- 跨 cwd 拖拽（不同 cwd 的分屏树不同时可见）
- Tab 跨 leaf 复制（拖拽语义为移动，非复制）
- 拖拽过程中 Tab 内容的实时预览（VS Code 的 Editor Group 拖拽也没有此功能）
- 键盘快捷键触发的 Tab 移动（仅限拖拽交互）
- 拖拽到 SplitDivider 区域（仅限拖拽到 TabBar 或 leaf 空白区域）
- 撤销/重做 Tab 移动操作

## Further Notes

- 参考 @dnd-kit 官方多容器拖拽示例：https://docs.dndkit.com/presets/sortable/#multiple-containers
- @dnd-kit 版本：`@dnd-kit/core@^6.1.0`、`@dnd-kit/sortable@^8.0.0`、`@dnd-kit/utilities@^3.2.2`
- 与 ADR-0001（分屏树按 cwd 独立存储）和 ADR-0002（跨 SplitLeaf Tab 拖拽）保持一致
- 同 leaf 拖拽重排（`reorderTabsInLeaf`）的现有行为完全保留，不受影响