# 01-跨 leaf 拖拽实现

## Problem

Tab 只能在同一 SplitLeaf 内拖拽重排，无法在不同 SplitLeaf 之间移动。用户需要将 Tab 从一个分屏窗格拖拽到另一个窗格以灵活组织工作区布局。

## Solution

一次性完整实现跨 SplitLeaf Tab 拖拽移动功能，包括：store action、DndContext 架构改造、视觉反馈。

## Implementation Checklist

### 1. Store：moveTabAcrossLeafs action

- [ ] 新增 `moveTabAcrossLeafs(tabId, sourceLeafId, targetLeafId, targetIndex)` action
- [ ] 从 sourceLeaf 的 tabs 中移除 tab
- [ ] 若 sourceLeaf 的 tabs 变为空，自动调用 `closeLeaf`
- [ ] 将 tab 插入到 targetLeaf 的 tabs 中指定索引位置
- [ ] 更新 `activeTabId` 为被拖拽的 tab
- [ ] 更新 `activeLeafId` 为 targetLeafId
- [ ] 新增 `canMoveTabToLeaf(tab, targetLeaf, cwdTrees)` 辅助函数
- [ ] session/diff/preview 在目标 leaf 中已存在时返回 false
- [ ] terminal/session-content 始终返回 true

### 2. 组件：SplitPaneDragProvider

- [ ] 新建 `SplitPaneDragProvider` 组件，持有 DndContext
- [ ] 包装 SplitPane 渲染树
- [ ] 处理 `onDragStart`：记录拖拽的 tab 信息
- [ ] 处理 `onDragOver`：检测进入/离开目标 leaf，检测去重冲突
- [ ] 处理 `onDragEnd`：同 leaf → reorderTabsInLeaf；跨 leaf → moveTabAcrossLeafs；去重冲突 → 跳过
- [ ] 渲染 DragOverlay（Tab 视觉副本）

### 3. 组件：TabBar 改造

- [ ] 移除 dnd 分支中的 DndContext
- [ ] 保留 SortableContext，`id` 为 leafId，`items` 为可见 tab id 列表
- [ ] 非 dnd 分支不改动（纯展示模式）

### 4. 视觉反馈

- [ ] DragOverlay 渲染 Tab 副本（图标 + 标题 + 关闭按钮占位）
- [ ] `.split-pane-leaf--drag-over` CSS：目标 leaf 边框高亮
- [ ] `.drag-overlay` CSS：DragOverlay 样式
- [ ] `.drag-overlay--invalid` CSS：去重冲突时 DragOverlay 红色调
- [ ] 去重冲突时 DragOverlay 显示禁止图标

### 5. 测试

- [ ] `moveTabAcrossLeafs` 将 tab 从 leaf A 移动到 leaf B（验证 tabs 变化）
- [ ] `moveTabAcrossLeafs` 移走最后一个 tab 后源 leaf 被关闭
- [ ] `moveTabAcrossLeafs` 支持指定插入位置（索引 0 / 中间 / 末尾）
- [ ] `moveTabAcrossLeafs` 后 activeTabId 和 activeLeafId 更新
- [ ] `canMoveTabToLeaf` 返回 true/false 的逻辑
- [ ] 终端 tab 始终允许跨 leaf 移动
- [ ] 同 leaf 移动不影响 reorderTabsInLeaf

## Testing

- splitStore.test.ts 扩展测试用例
- SplitPane.test.tsx 扩展渲染测试

## Out of Scope

- 跨 cwd 拖拽
- 键盘快捷键触发的 Tab 移动
- 撤销/重做