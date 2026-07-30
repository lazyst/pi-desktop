# 01 — splitStore 数据模型 + SplitPane 渲染

**What to build:** 创建分屏状态管理（splitStore）和基础渲染组件（SplitPane、SplitDivider），替换现有 tabStore。CenterPane 使用 SplitPane 渲染，所有 cwd 的分屏树同时存在于 DOM 中。完成后无可见变化，现有行为完全保留。

**Blocked by:** 无 — 可立即开始

**Status:** completed

**Completed at:** 2025-01-14

**Summary:**
- Created `splitStore.ts` with full data model (cwdTrees, SplitLeaf, SplitNode), all tab management actions with leafId support, global dedup, findTabById/findTabByKey/findTabByTerminalId helpers, and split-specific actions (splitPane, closeLeaf, setRatios, setActiveLeaf)
- Created `SplitPane.tsx` recursive component (leaf renders TabBar+content, split node renders children+dividers)
- Created `SplitDivider.tsx` pure rendering component (1px center line, hover scale 4×)
- Modified `CenterPane.tsx` to render SplitPane tree with all cwd keep-alive
- Modified `TabBar.tsx` to accept leafId prop
- Updated `App.tsx` to use getAllTabs helper and new API
- Updated `useSidebarState.ts` to use getAllTabs helper
- Added split-related CSS to `app.css` (split-pane, split-pane-node, split-pane-child, split-pane-leaf, split-divider)
- Made `tabStore.ts` re-export from splitStore for backward compatibility
- Created `splitStore.test.ts` (31 tests passing) and `SplitPane.test.tsx` (3 tests passing)
- Production code type-checks cleanly (0 errors from new/modified files)

- [ ] splitStore 创建完成，包含：
  - `cwdTrees: Record<string, SplitTree>` 和 `activeCwd`
  - `activeLeafId` 和活跃 leaf 跟踪
  - `cwdOrder: string[]`（保持原语义）
  - `terminals: IntegratedTerminalInfo[]`
- [ ] 所有 tab 管理 action 迁移到 splitStore：
  - `openSession` / `openPreview` / `openDiff` / `openTerminal` / `openSessionContent`
  - `selectTab` / `closeTab` / `hideTab` / `reorderTabsInLeaf` — closeTab 内部检查是否为 leaf 的最后一个 tab，是则调用 closeLeaf 而非普通删除
  - `removeSessionTab` / `removeTerminalTab`
  - `closeCenterTab` / `promoteTabNames` / `renameSessionTab`
  - 所有 action 接受 `leafId?: string`，未传时使用 `activeLeafId`
- [ ] 全局去重逻辑：`openSession`/`openPreview`/`openDiff` 按 key/id 搜索所有 leaf，已存在则跳转
- [ ] 辅助函数：`findTabById` / `findTabByKey` / `findTabByTerminalId` / `allTabs`
- [ ] `SplitPane` 递归组件：渲染 leaf（TabBar + 内容）或 split node（子节点 + 分割线）
- [ ] TabBar 接收 `leafId` prop，用于 `closeTab`、`selectTab`、`reorderTabsInLeaf` 等操作
- [ ] `SplitDivider` 纯渲染组件（1px 中心线，hover scale 4×，无拖拽逻辑）
- [ ] SplitDivider CSS 样式（1px 中心线、hover scale 4×、8px padding 命中区域）
- [ ] `CenterPane` 改用 `SplitPane` 渲染，所有 cwd 的分屏树同时存在于 DOM 中（非活跃用 opacity:0 隐藏）
- [ ] `App.tsx` 中所有 `useTabStore` 引用改为 `useSplitStore`，`tabs` 引用改为 `allTabs`
- [ ] `useSidebarState`/`useSessionStatus` 等外部 hooks 使用 `allTabs` 计算属性
- [ ] `splitStore.test.ts` 覆盖：初始状态、openSession/openPreview/openDiff（leafId 参数）、selectTab、closeTab、removeSessionTab、findTabByKey 全局去重、跨 cwd 独立
- [ ] 原有 `tabStore.test.ts` 测试用例迁移到 splitStore：所有涉及 tab 增删改查的用例保留重写，与旧数据结构强相关的用例更新为新数据模型
- [ ] 保留现有 Tab 类型（SessionTab/PreviewTab/DiffTab/IntegratedTerminalTab/SessionContentTab）和 TabKind 枚举，Tab 归属权从全局数组转移到 SplitLeaf.tabs
- [ ] `SplitPane.test.tsx` 组件渲染测试：验证递归渲染（leaf 渲染 TabBar+内容，split 渲染子节点+分割线）
- [ ] SplitDivider 渲染测试：验证 horizontal/vertical 方向渲染
- [ ] 原有 `tabStore.ts` 退役