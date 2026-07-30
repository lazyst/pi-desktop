# ADR-0001: 分屏树按 cwd 独立存储

用每个 cwd 独立的分屏树（SplitTree）替代扁平全局 Tab 列表，SplitLeaf 持有自己的 Tab 列表和 activeTabId。

## 背景

原 `tabStore` 使用扁平 `Tab[]` + 全局 `activeTabId` + `cwdActiveTab` 记忆各目录的激活 tab。这种设计在单列 Tab 展示时工作良好，但无法支持分屏——每个分屏窗格需要独立的 Tab 列表和激活状态。

## 决策

- 每个 cwd 拥有一棵独立的分屏树（`SplitTree`），根节点为 `SplitLeaf` 或 `SplitNode`。
- 树节点分两种：`SplitLeaf`（叶子，持有 `tabs: Tab[]` 和 `activeTabId`）和 `SplitNode`（分支，持有 `direction`、`ratios`、`children`）。
- 切换 cwd 时，整个中间区替换为对应 cwd 的分屏树。
- 新建 Tab 始终进入当前活跃的 SplitLeaf。
- 原有的 `tabStore` 功能全部合并到 `splitStore` 中，不再保留全局扁平 Tab 列表。

## 考虑过的方案

1. **保留全局 tabStore，splitStore 引用 tab id**：需要两套状态同步，切换 cwd 时逻辑复杂，且全局 tab 生命周期与分屏 leaf 生命周期耦合。
2. **每个 leaf 共享全局 tab 列表，仅 activeTabId 独立**：无法实现"每个 leaf 拥有独立的 Tab 列表"的需求。

## 后果

- 所有 `openSession`/`openPreview`/`openDiff`/`openTerminal` 等操作需要接收 `leafId` 参数。
- 原有的 `cwdActiveTab` 和 `cwdTabHistory` 机制不再需要——每个 leaf 的 Tab 列表和激活状态是自包含的。
- 切换 cwd 时，中间区整体替换为新的分屏树，现有的 keep-alive 机制（所有 tab 内容永久挂载在 DOM 中）需要调整为按 cwd 切换时卸载/挂载。
- 实现复杂度增加，但数据模型更清晰，每个 cwd 和每个 SplitLeaf 的状态完全自包含。