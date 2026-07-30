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
10. 作为用户，如果拖拽的 session/diff 在目标 SplitLeaf 中已存在，拖拽被阻止（DragOverlay 显示不可拖放标识，且不显示插入位置指示线），以便避免重复 Tab
11. 作为用户，终端 Tab（integrated-terminal）也可以跨 SplitLeaf 拖拽，行为同其他 Tab 一致，以便我可以灵活组织终端布局
12. 作为用户，拖拽范围仅限于同一 cwd 内的 SplitLeaf 之间，不同 cwd 的分屏树不相互影响，以便保持工作目录的语义隔离

## Implementation Decisions

### 1. 架构：单 DndContext + 多 SortableContext

将 DndContext 从 TabBar 提升到 SplitPane 层，新建 `SplitPaneDragProvider` 包装组件。所有 TabBar 共享同一 DndContext，每个 TabBar 持有独立的 SortableContext（`id` 为所属 leafId，`items` 为所属 leaf 的可见 tab id 列表）。利用 @dnd-kit 原生多容器排序支持。

每个 cwd 使用独立的 `SplitPaneDragProvider` 实例（每个 cwd 一棵分屏树，互不干扰）。非活跃 cwd 的 `SplitPaneDragProvider` 不响应拖拽（`pointer-events: none` 已由父容器 CSS 控制）。

### 2. 新增 Store Action：moveTabAcrossLeafs

```typescript
moveTabAcrossLeafs(
  tabId: string,
  sourceLeafId: string,
  targetLeafId: string,
  targetIndex: number,  // 插入位置在目标 leaf 完整 tabs[] 中的索引（含 hidden tab）
): void
```

行为（按顺序执行）：
- 若源 leaf 中包含 session 或 integrated-terminal 类型的 tab，调用 `capturePaneScrollState` 保存其滚动位置（确保后续切换回该 leaf 时滚动位置恢复）
- 将 tab 从 sourceLeaf 的 `tabs[]` 中移除
- 若被移走的 tab 是 sourceLeaf 的 `activeTabId`，调用 `selectNextTabOnClose` 逻辑选择下一个可见 tab 作为新的 activeTabId（若 sourceLeaf 移走后变空则跳过，因为将触发 closeLeaf）
- 若 sourceLeaf 的 `tabs[]` 变为空，自动调用 `closeLeaf`
- 将 tab 插入到 targetLeaf 的 `tabs[]` 中指定索引位置
- 更新 `activeTabId` 为被拖拽的 tab（在目标 leaf 上）
- 更新 `activeLeafId` 为 targetLeafId
- 调用 `pushTabHistory` 将被拖拽 tab 加入历史记录
- 调用 `updateCwdActiveTab` 更新目标 cwd 的 `cwdActiveTab`
- 若目标 leaf 中已存在同一 key（session/diff），不执行任何操作（由调用方阻止 drop，此为防御性检查）

**关于 `targetIndex`**：`targetIndex` 是在目标 leaf 的完整 `tabs[]` 数组中的索引（而非仅 visible tabs）。调用方（`onDragEnd`）从 @dnd-kit 获取 `over` 项的 tab id，在目标 leaf 的完整 `tabs[]` 中找到该 tab 的索引，作为插入位置。如果拖到空白区域，`targetIndex` 为 `tabs[].length`（追加到末尾）。

### 3. 去重检查：canMoveTabToLeaf

在 store 中新增辅助函数，判断指定 tab 是否可以移动到目标 leaf：

```typescript
function canMoveTabToLeaf(
  tab: Tab,
  targetLeaf: SplitLeaf,
  targetCwd: string,      // 目标 leaf 所在 cwd（用于定位）
  cwdTrees: Record<string, SplitTree>,
): boolean
```

- 对 session tab：检查目标 leaf 中是否有同 key 的 session tab
- 对 diff tab：检查目标 leaf 中是否有同 commitHash 的 diff tab
- 对 preview tab：检查目标 leaf 中是否有同 path 的 preview tab
- 对 terminal tab：检查目标 leaf 中是否有同 id 的 terminal tab（防御性检查，虽然理论上终端 id 全局唯一）
- 对 session-content tab：检查目标 leaf 中是否有同 sessionKey 的 session-content tab（防御性检查）
- 若源 leaf 和目标 leaf 不在同一 cwd，返回 false（防御性检查）

### 4. SplitPaneDragProvider 组件

新建 `SplitPaneDragProvider` 组件，负责：
- 持有 DndContext，使用 `closestCorners` 碰撞检测策略（比 `closestCenter` 更适合多容器场景，减少容器边界处的误判）
- 管理 DragOverlay 渲染
- 使用 `useState` 跟踪 `canDrop` 和 `hoveredLeafId`（驱动 DragOverlay 样式和 leaf 高亮），使用 `useRef` 跟踪 `activeDragItem`（仅在 `onDragEnd` 中读取，不直接影响渲染）
- 为每个 leaf 维护一个 `SortableContext` 的 `items` 列表（在 `onDragStart`/`onDragOver`/`onDragEnd` 中动态管理）

**`onDragStart` 处理**：
- 记录拖拽的 tab 信息到 `activeDragItem` ref
- 从源 leaf 的 SortableContext items 中移除该 tab id（源 leaf 不再显示该 tab 的占位符）

**`onDragOver` 处理**：
- 检测当前 `over` 对象所属的 leafId
  - 如果 `over.id` 是 tab id → 通过 `findTabById` 查找该 tab 所属的 leafId
  - 如果 `over.id` 是 leaf 级 droppable id（如 `leaf-{leafId}`）→ 直接提取 leafId
  - 如果 `over.id` 以 `split-divider-` 前缀开头 → 忽略该事件（不更新高亮、不更新 items）
- 若 `over` 的 leafId 与上一个 `hoveredLeafId` 不同（跨 leaf 切换或首次进入）：
  - 从上一个 leaf 的 SortableContext items 中移除拖拽 tab id（如果有）
  - 若 `canDrop` 为 true，将拖拽 tab id 加入新 leaf 的 SortableContext items
- 根据 `canMoveTabToLeaf` 结果设置 `canDrop` state
  - 若 `canDrop` 为 true：将拖拽 tab id 加入目标 leaf 的 SortableContext items，更新高亮状态
  - 若 `canDrop` 为 false：不加入目标 leaf 的 items（阻止插入指示线出现），DragOverlay 显示 `--invalid` 样式，leaf 高亮显示红色边框

**`onDragEnd` 处理**：
- 若 `over === null`（拖拽被取消或拖到有效区域外）：
  - 从所有 leaf 的 SortableContext items 中移除该 tab id，恢复到源 leaf 的 items 中（恢复拖拽前状态）
  - 清理所有临时状态，不执行任何 store action
- 若 `over` 不为 null：
  - 确定目标 leafId（同上：tab id → findTabById / leaf id → 直接提取）
  - 与源 leafId 比较：
    - 同 leaf → 调用 `reorderTabsInLeaf`（已存在的同 leaf 重排逻辑，不受影响）
    - 跨 leaf 且 `canDrop` 为 true → 调用 `moveTabAcrossLeafs`
    - 跨 leaf 且 `canDrop` 为 false → 跳过（去重冲突）
  - 清理所有临时状态（恢复所有 leaf 的 SortableContext items 到拖拽前状态）

**SplitDivider 区域忽略机制**：
- 为每个 SplitDivider 分配一个特殊的 droppable id（如 `split-divider-{leafId}`）
- 在 `onDragOver` 中检查 `over.id` 是否以 `split-divider-` 前缀开头，若是则跳过所有 items 更新和高亮处理
- 或者自定义 `collisionDetection` 函数，排除 SplitDivider 区域

渲染结构：
```
<SplitPaneDragProvider>
  <SplitPane>
    ...
  </SplitPane>
</SplitPaneDragProvider>
```

**非活跃 cwd 处理**：`SplitPaneDragProvider` 检查 `isActive` 属性，如果所在 cwd 不是活跃的，则不渲染 DndContext（或 DndContext 的 `onDragStart` 中直接忽略非活跃 cwd 的拖拽事件）。

### 5. TabBar 改造

- 移除 TabBar 内的 DndContext，保留 SortableContext
- 非 dnd 分支（无 `onReorder`）保留纯展示，不改动
- dnd 分支的 `onDragEnd` 逻辑移到父层 `SplitPaneDragProvider` 的 DndContext 中
- `SortableContext` 的 `items` 为该 leaf 的可见 tab id 列表
- hidden tab 不在 SortableContext items 中，拖拽重排不改变它们的 `order` 值（与现有行为一致）

### 6. DragOverlay 视觉

DragOverlay 渲染被拖拽 Tab 的视觉副本，与 SortableTab 的渲染结构一致：
- 图标 + 标题 + 关闭按钮，但关闭按钮不可交互
- 拖拽过程中源 Tab 位置：在 `onDragStart` 后从源 leaf 的 SortableContext items 中移除，源 leaf 中该 tab 位置空出
- `.drag-overlay` 样式：半透明背景、阴影，跟随鼠标
- `.drag-overlay--invalid` 样式：`canDrop` 为 false 时显示，红色调 + 禁止图标

### 7. 目标 leaf 高亮

通过 CSS class 实现：
- `.split-pane-leaf--drag-over`：`canDrop` 为 true 时，leaf 边框使用 `var(--accent)` 颜色，`border: 2px solid var(--accent)` 或 `box-shadow`
- `.split-pane-leaf--drag-over--invalid`：`canDrop` 为 false 时，leaf 边框显示红色
- 高亮状态由 `hoveredLeafId` state 驱动，拖拽离开或 drop 后移除

### 8. 插入位置指示线

利用 @dnd-kit 的 `SortableContext` 排序反馈：
- 跨 leaf 拖拽且 `canDrop` 为 true 时，目标 leaf 的 SortableContext 自动计算插入位置（通过动态将拖拽 tab id 加入 items）
- 通过 CSS class `.sortable-item--drop-before` 实现视觉指示（左侧竖线）

### 9. 修改模块

- `src/renderer/src/store/splitStore.ts` — 新增 `moveTabAcrossLeafs` action + `canMoveTabToLeaf` 辅助函数
- `src/renderer/src/components/SplitPane.tsx` — 新增 `SplitPaneDragProvider` 组件，包装 SplitPane 渲染树
- `src/renderer/src/components/TabBar.tsx` — 移除 DndContext（dnd 分支），保留 SortableContext
- `src/renderer/src/styles/app.css` — 新增 `.split-pane-leaf--drag-over`、`.split-pane-leaf--drag-over--invalid`、`.drag-overlay`、`.drag-overlay--invalid` 样式

## Testing Decisions

### 测试策略

- 只测试外部行为，不测试实现细节
- 优先使用现有测试 seam（splitStore.test.ts），减少新 seam 的引入

### 测试模块

1. **splitStore.test.ts**（现有 seam，扩展测试用例）：
   - `moveTabAcrossLeafs` 将 tab 从 leaf A 移动到 leaf B（验证 tabs 数组变化）
   - `moveTabAcrossLeafs` 移走最后一个 tab 后源 leaf 被关闭
   - `moveTabAcrossLeafs` 支持指定插入位置（索引 0 / 中间 / 末尾）
   - `moveTabAcrossLeafs` 后目标 leaf 的 activeTabId 更新为被拖拽的 tab
   - `moveTabAcrossLeafs` 后 activeLeafId 更新为目标 leaf
   - `moveTabAcrossLeafs` 移走 activeTabId 时，源 leaf 的 activeTabId 切换到下一个可见 tab
   - `moveTabAcrossLeafs` 后 cwdTabHistory 和 cwdActiveTab 被更新
   - `canMoveTabToLeaf` 返回 true 当目标 leaf 无同 key tab
   - `canMoveTabToLeaf` 返回 false 当目标 leaf 已有同 session key
   - `canMoveTabToLeaf` 返回 false 当目标 leaf 已有同 commitHash diff
   - `canMoveTabToLeaf` 返回 false 当源和目标不在同一 cwd
   - 终端 tab 允许跨 leaf 移动（目标 leaf 无同 id 终端时）
   - 同 leaf 移动（sourceLeafId === targetLeafId）由 reorderTabsInLeaf 处理，不受影响

2. **SplitPane.test.tsx**（新建 seam）：
   - 渲染 SplitPaneDragProvider 后 DndContext 包裹所有 leaf 的 TabBar
   - 拖拽到 leaf 空白区域时触发 leaf 级 droppable

### 不测试

- DragOverlay 的具体渲染内容（jsdom 无法精确测试拖拽叠加层）
- 鼠标事件序列（需要在 e2e 层测试）
- CSS 动画效果
- @dnd-kit 的 SortableContext items 动态更新（属于库内部行为，由 @dnd-kit 自身测试覆盖）

## Out of Scope

- 跨 cwd 拖拽（不同 cwd 的分屏树不同时可见）
- Tab 跨 leaf 复制（拖拽语义为移动，非复制）
- 拖拽过程中 Tab 内容的实时预览（VS Code 的 Editor Group 拖拽也没有此功能）
- 键盘快捷键触发的 Tab 移动（仅限拖拽交互）
- 拖拽到 SplitDivider 区域（仅限拖拽到 TabBar 或 leaf 空白区域；拖拽路径经过 SplitDivider 时自动忽略）
- 撤销/重做 Tab 移动操作

## Further Notes

- 参考 @dnd-kit 官方多容器拖拽示例：https://docs.dndkit.com/presets/sortable/#multiple-containers 中的 `onDragOver` 动态更新 items 模式
- @dnd-kit 版本：`@dnd-kit/core@^6.1.0`、`@dnd-kit/sortable@^8.0.0`、`@dnd-kit/utilities@^3.2.2`
- 与 ADR-0001（分屏树按 cwd 独立存储）和 ADR-0002（跨 SplitLeaf Tab 拖拽）保持一致
- 同 leaf 拖拽重排（`reorderTabsInLeaf`）的现有行为完全保留，不受影响
- hidden tab 不在 SortableContext items 中，拖拽重排不改变它们的 order 值
- `onDragOver` 中使用 `useState` 跟踪 `canDrop` 和 `hoveredLeafId`（驱动 DragOverlay 样式和 leaf 高亮），使用 `useRef` 跟踪 `activeDragItem`（仅在 `onDragEnd` 中读取）