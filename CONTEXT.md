# pi-workbench

Electron 桌面应用，面向 AI 编程工作流的终端管理器与文件编辑器。中间区域（CenterPane）是核心工作区，支持多 Tab 和分屏布局。

## Language

**SplitPane（分屏窗格）**：
中间区中的一个可视区域，拥有自己独立的 Tab 列表和 TabBar。每个 SplitPane 显示一个激活的 Tab 内容。用户可对 SplitPane 进行分屏操作，将其一分为二。
_Avoid_：Panel, Group, Editor Group

**SplitLeaf（分屏叶子）**：
SplitPane 的递归树中的叶子节点，持有 `tabs: Tab[]` 和 `activeTabId`。SplitLeaf 是分屏树的最小单元。
_Avoid_：Leaf, Pane Leaf

**SplitNode（分屏节点）**：
SplitPane 的递归树中的分支节点，持有 `direction`（水平/垂直）、`ratios[]`（子节点比例）、`children[]`（子节点列表）。
_Avoid_：Split, Split Container

**SplitTree（分屏树）**：
每个工作目录（cwd）拥有一棵分屏树，根节点为 SplitLeaf 或 SplitNode。切换 cwd 时，整个中间区替换为对应 cwd 的分屏树。
_Avoid_：Layout Tree, Pane Tree

**SplitDivider（分割线）**：
SplitNode 的子节点之间的可拖拽视觉分隔线。拖拽时更新 SplitNode 的 ratios。
_Avoid_：Splitter, Divider, Resizer

**Tab（标签页）**：
一个内容单元，持有 kind（session/preview/diff/integrated-terminal/session-content）、id、title 等属性。Tab 始终属于某个 SplitLeaf，不存在全局的 Tab 列表。
_Avoid_：TabItem, Editor Tab

**TabBar（标签条）**：
SplitLeaf 头部的水平标签栏，显示该 SplitLeaf 的所有 Tab。用户可点击切换、拖拽重排、关闭 Tab。TabBar 右侧有分屏按钮（左右分屏/上下分屏）。
_Avoid_：Tab Strip, Tab Row

**活跃 SplitLeaf（ActiveLeaf）**：
最近一次用户点击或操作的 SplitLeaf。新建 Tab 时，Tab 默认加入当前活跃的 SplitLeaf。由 `splitStore.activeLeafId` 记录。
_Avoid_：Focused Leaf, Current Leaf

**cwd（工作目录）**：
一个磁盘目录，对应侧边栏的一个分组。每个 cwd 拥有自己的分屏树和 Tab 列表。切换 cwd 时，中间区整个替换为对应 cwd 的分屏布局。
_Avoid_：Workspace, Directory, Workdir

## Rules

- 每个 SplitLeaf 拥有独立的 `tabs: Tab[]` 和 `activeTabId`，不与其他 SplitLeaf 共享。
- 每个 cwd 拥有独立的分屏树，切换 cwd 时中间区整体替换。
- 分屏按钮在 TabBar 右侧，两个按钮分别对应水平分屏（左右）和垂直分屏（上下）。
- 点击分屏按钮时，当前 SplitLeaf 被一分为二，新 SplitLeaf 自动创建一个集成终端 Tab。
- 关闭 SplitLeaf 中最后一个 Tab 时，该 SplitLeaf 被关闭（从分屏树中移除），其兄弟 SplitLeaf 扩展填充空间。
- 若根 SplitLeaf 无 Tab，显示空状态（"新建会话"/"新建终端"按钮）。
- 新建 Tab 默认进入当前活跃的 SplitLeaf。
- Tab 拖拽仅限同 SplitLeaf 内重排，不支持跨 SplitLeaf 拖拽。

**DragOverlay（拖拽幽灵）**：
跨 leaf 拖拽时，被拖拽 Tab 的视觉副本，跟随鼠标移动。源 Tab 在原位保持占位（半透明）。
_Avoid_：Ghost, Drag Preview

**插入指示线（Insertion Indicator）**：
跨 leaf 拖拽时，在目标 TabBar 中显示的一条竖线，指示 Tab 将被插入的位置。
_Avoid_：Drop Indicator, Insertion Line

**跨 Leaf 拖拽（Cross-Leaf Drag）**：
将 Tab 从一个 SplitLeaf 拖拽到同 cwd 下的另一个 SplitLeaf 中。Tab 从源 leaf 的 tabs 中移除，追加到目标 leaf 的 tabs 中。
_Avoid_：Cross-Pane Drag, Tab Migration

## Rules

- 每个 SplitLeaf 拥有独立的 `tabs: Tab[]` 和 `activeTabId`，不与其他 SplitLeaf 共享。
- 每个 cwd 拥有独立的分屏树，切换 cwd 时中间区整体替换。
- 分屏按钮在 TabBar 右侧，两个按钮分别对应水平分屏（左右）和垂直分屏（上下）。
- 点击分屏按钮时，当前 SplitLeaf 被一分为二，新 SplitLeaf 自动创建一个集成终端 Tab。
- 关闭 SplitLeaf 中最后一个 Tab 时，该 SplitLeaf 被关闭（从分屏树中移除），其兄弟 SplitLeaf 扩展填充空间。
- 若根 SplitLeaf 无 Tab，显示空状态（"新建会话"/"新建终端"按钮）。
- 新建 Tab 默认进入当前活跃的 SplitLeaf。
- Tab 拖拽重排分两种：同 leaf 内拖拽重排（reorder）和跨 leaf 拖拽移动（move）。
- 跨 leaf 拖拽仅限同一 cwd 内，不支持跨 cwd 拖拽。
- 跨 leaf 拖拽使用移动语义：Tab 从源 leaf 移除，追加到目标 leaf。
- 跨 leaf 拖拽后，目标 leaf 成为活跃 leaf，被拖拽的 Tab 自动激活。
- 跨 leaf 拖拽时，若目标 leaf 中已存在同一 session/diff/key，拖拽被阻止。
- 跨 leaf 拖拽移走最后一个 Tab 后，源 leaf 自动关闭（closeLeaf）。
- 拖拽回同一 leaf 等同于同 leaf 重排（reorder）。
- 终端 Tab（integrated-terminal）允许跨 leaf 拖拽，同其他 Tab 行为一致。