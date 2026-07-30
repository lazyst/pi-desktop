# 03 — 拖拽调整比例 + Tab 重排 + closeGuards

**What to build:** 实现 SplitDivider 的鼠标拖拽（mousedown→mousemove→mouseup 更新 ratios）、Tab 在 leaf 内的拖拽重排（`reorderTabsInLeaf`）、以及 PreviewTab 的 dirty 确认拦截器（closeGuards）适配。这是收尾切片，覆盖分屏功能的完整交互体验。

**Blocked by:** 01 — splitStore 数据模型 + SplitPane 渲染

**Status:** ready-for-agent

- [ ] SplitDivider 鼠标拖拽：
  - `mousedown` 记录起始位置，`mousemove` 实时计算 delta → 更新 `setRatios`
  - `mouseup` 结束拖拽
  - 拖拽期间锁定 body cursor（`col-resize` / `row-resize`）
  - 最小 pane 比例约束（6%），防止 pane 被拖拽到不可见
- [ ] `reorderTabsInLeaf(leafId, orderedIds)`：
  - TabBar 传入 `leafId` prop
  - 拖拽结束时调用 `reorderTabsInLeaf(leafId, orderedIds)`
  - 限制在 SplitLeaf 内，不支持跨 leaf 拖拽
- [ ] closeGuards 适配：
  - 保持按 tab id 索引的全局 Map 方案
  - 每个 leaf 的 TabBar 的 `onClose` 回调指向同一个 `requestCloseTab` 函数
- [ ] 拖拽时 body cursor 锁定 CSS（`col-resize` / `row-resize`）
- [ ] 测试覆盖：拖拽分割线更新 ratios、最小比例约束、`reorderTabsInLeaf`