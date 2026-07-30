# 02 — 分屏按钮 + 自动创建终端 + 关闭 pane + 空状态

**What to build:** 在 TabBar 右侧添加分屏按钮，实现 `splitPane` action（一分为二 + 自动创建终端）、`closeLeaf` action（关闭 leaf 合并回兄弟）、以及根 leaf 无 tab 时的空状态。这是第一个可演示的切片：用户可点击分屏按钮看到两个并排 pane。

**Blocked by:** 01 — splitStore 数据模型 + SplitPane 渲染

**Status:** completed

**Completed at:** 2025-01-14

**Summary:**
- TabBar split buttons: added IconSplitHorizontal/IconSplitVertical, render two buttons on right side of tab bar
- `onSplitPane` prop threaded through App → CenterPane → SplitPane → SplitPaneLeaf → TabBar
- `handleSplitPane` in App.tsx: calls `splitPane(leafId, direction)`, then `spawnTerminal` IPC, then `openTerminal` with parent leaf's active tab cwd
- `findLeaf` exported from splitStore for use in App.tsx
- `split-pane-btn` CSS added (matches existing terminal-new-btn style)
- Tests: 8 new tests (splitPane: 4, closeLeaf: 3, empty state: 1)
- 42 total tests passing, production code compiles with zero errors

- [ ] TabBar 右侧添加两个分屏按钮（水平分屏/垂直分屏），图标风格与现有图标一致
- [ ] `splitPane(leafId, direction)` action：
  - 将指定 leaf 替换为 split node（两个 leaf，50/50 比例）
  - 新 leaf 自动调用 `spawnTerminal` IPC 创建集成终端
  - 新终端 cwd 继承 parent leaf 的 active tab 的 cwd（按 tab 类型取 `cwd`/`root`，回退到 `activeCwd`）
- [ ] `closeLeaf(leafId)` action：
  - 在 split node 中移除指定 leaf，返回兄弟节点
  - 兄弟节点是 leaf → 合并回单 leaf
  - 兄弟节点是 split node → 保留
  - 逐层清理：split node 子节点数 < 2 时提升唯一子节点
- [ ] 空状态：根 leaf 的 tabs 为空时，显示"新建会话"/"新建终端"按钮（与当前空状态一致），新建 tab 目标为根 leaf
- [ ] 分屏按钮 CSS 样式
- [ ] 测试覆盖：分屏后树结构正确（两个 leaf 各 50%）、新 leaf 包含终端 tab、关闭 leaf 后合并、连续分屏（嵌套分屏）后树结构正确、嵌套分屏后关闭、空状态显示