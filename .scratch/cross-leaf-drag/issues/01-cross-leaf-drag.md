# 01-跨 leaf 拖拽实现

## Problem

Tab 只能在同一 SplitLeaf 内拖拽重排，无法在不同 SplitLeaf 之间移动。用户需要将 Tab 从一个分屏窗格拖拽到另一个窗格以灵活组织工作区布局。

## Solution

一次性完整实现跨 SplitLeaf Tab 拖拽移动功能，包括：store action、DndContext 架构改造、视觉反馈。

## Implementation Checklist

### 1. Store：moveTabAcrossLeafs action

- [ ] 新增 `moveTabAcrossLeafs(tabId, sourceLeafId, targetLeafId, targetIndex)` action
  - `targetIndex` 为完整 `tabs[]` 数组中的索引（含 hidden tab）
- [ ] 移动前保存 session/terminal tab 的滚动位置（`capturePaneScrollState`）
- [ ] 从 sourceLeaf 的 tabs 中移除 tab
- [ ] 若移走的 tab 是 sourceLeaf 的 `activeTabId`，调用 `selectNextTabOnClose` 选择下一个可见 tab
- [ ] 若 sourceLeaf 的 tabs 变为空，自动调用 `closeLeaf`
- [ ] 将 tab 插入到 targetLeaf 的 tabs 中指定索引位置
- [ ] 更新 `activeTabId` 为被拖拽的 tab（目标 leaf）
- [ ] 更新 `activeLeafId` 为 targetLeafId
- [ ] 调用 `pushTabHistory` 更新历史记录
- [ ] 调用 `updateCwdActiveTab` 更新 cwdActiveTab
- [ ] 新增 `canMoveTabToLeaf(tab, targetLeaf, targetCwd, cwdTrees)` 辅助函数
- [ ] session/diff/preview 在目标 leaf 中已存在时返回 false
- [ ] terminal/session-content 在目标 leaf 中已存在时也返回 false（防御性检查）
- [ ] 源和目标不在同一 cwd 时返回 false（防御性检查）

### 2. 组件：SplitPaneDragProvider

- [ ] 新建 `SplitPaneDragProvider` 组件，持有 DndContext（每个 cwd 一个独立实例）
- [ ] 使用 `closestCorners` 碰撞检测策略
- [ ] 包装 SplitPane 渲染树
- [ ] 使用 `useState` 跟踪 `canDrop` 和 `hoveredLeafId`（驱动 DragOverlay 样式和 leaf 高亮）
- [ ] 使用 `useRef` 跟踪 `activeDragItem`（仅在 onDragEnd 中读取）
- [ ] 处理 `onDragStart`：记录拖拽的 tab 信息，从源 leaf 的 SortableContext items 中移除
- [ ] 处理 `onDragOver`：
  - 检测 `over` 对象所属 leafId（tab id → findTabById / leaf id → 直接提取 / split-divider- 前缀 → 忽略）
  - 跨 leaf 切换时，从上一个 leaf 的 items 中移除拖拽 tab id，如有必要再加入新 leaf 的 items
  - `canDrop` 为 false 时不加入目标 leaf 的 items（阻止插入指示线）
  - 忽略 SplitDivider 区域的 hover 事件（通过 droppable id 前缀 `split-divider-` 检测）
- [ ] 处理 `onDragEnd`：
  - `over === null`（取消拖拽）：恢复所有 leaf 的 items 到拖拽前状态，不执行 store action
  - 同 leaf → reorderTabsInLeaf
  - 跨 leaf + canDrop → moveTabAcrossLeafs
  - 跨 leaf + !canDrop → 跳过（去重冲突）
  - 清理所有临时状态
- [ ] 渲染 DragOverlay（Tab 视觉副本，根据 `canDrop` state 切换 `--invalid` 样式）
- [ ] 非活跃 cwd 不响应拖拽（isActive 检查）

### 3. 组件：TabBar 改造

- [ ] 移除 dnd 分支中的 DndContext
- [ ] 保留 SortableContext，`id` 为 leafId，`items` 为可见 tab id 列表
- [ ] 非 dnd 分支不改动（纯展示模式）

### 4. 视觉反馈

- [ ] DragOverlay 渲染 Tab 副本（图标 + 标题 + 关闭按钮占位，关闭按钮不可交互）
- [ ] `.split-pane-leaf--drag-over` CSS：目标 leaf 边框高亮（accent 色）
- [ ] `.split-pane-leaf--drag-over--invalid` CSS：去重冲突时红色边框
- [ ] `.drag-overlay` CSS：DragOverlay 样式（半透明背景、阴影）
- [ ] `.drag-overlay--invalid` CSS：去重冲突时 DragOverlay 红色调 + 禁止图标

### 5. 测试

- [ ] `moveTabAcrossLeafs` 将 tab 从 leaf A 移动到 leaf B（验证 tabs 变化）
- [ ] `moveTabAcrossLeafs` 移走最后一个 tab 后源 leaf 被关闭
- [ ] `moveTabAcrossLeafs` 支持指定插入位置（索引 0 / 中间 / 末尾）
- [ ] `moveTabAcrossLeafs` 后 activeTabId 和 activeLeafId 更新
- [ ] `moveTabAcrossLeafs` 移走 activeTabId 时，源 leaf 切换到下一个可见 tab
- [ ] `moveTabAcrossLeafs` 后 cwdTabHistory 和 cwdActiveTab 被更新
- [ ] `canMoveTabToLeaf` 返回 true/false 的逻辑（含防御性检查：同 cwd、去重）
- [ ] 终端 tab 允许跨 leaf 移动
- [ ] 同 leaf 移动不影响 reorderTabsInLeaf

## Testing

- splitStore.test.ts 扩展测试用例（现有 seam）
- 新建 SplitPane.test.tsx 测试 seam

## Out of Scope

- 跨 cwd 拖拽
- 键盘快捷键触发的 Tab 移动
- 撤销/重做