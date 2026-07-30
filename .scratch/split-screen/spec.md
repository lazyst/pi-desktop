# 中间区 Tab 分屏功能

Status: ready-for-agent

## Problem Statement

当前中间区（CenterPane）只能同时显示一个 Tab 内容，用户无法在同一工作目录下并排查看多个终端或文件。当需要对比两个终端输出、或一边看代码一边看终端时，用户只能切换 Tab 或在两个窗口之间切换，效率低下。

## Solution

为中间区引入分屏功能，允许用户将当前 SplitPane 一分为二，每个 SplitPane 拥有独立的 Tab 列表和 TabBar。每个工作目录（cwd）维护自己的分屏树，切换 cwd 时中间区整体替换。

参考 Ridge 的纯渲染组件 + 外部状态机架构：`SplitTree` 是唯一真相源，组件只做渲染，拖拽分割线时通过 action 更新 ratios。

## 数据模型

```typescript
type SplitDirection = 'horizontal' | 'vertical';

interface SplitLeaf {
  type: 'leaf';
  id: string;
  tabs: Tab[];
  activeTabId: string | null;
}

interface SplitNode {
  type: 'split';
  id: string;
  direction: SplitDirection;
  ratios: number[];
  children: SplitChild[];
}

type SplitChild = SplitLeaf | SplitNode;
type SplitTree = SplitLeaf; // 根节点总是 leaf 或 split

// Store 顶层结构
interface SplitStore {
  cwdTrees: Record<string, SplitTree>;
  activeCwd: string | null;
  activeLeafId: string | null;
  cwdOrder: string[];
  terminals: IntegratedTerminalInfo[];
  // ... actions
}
```

## User Stories

1. 作为用户，我可以在 TabBar 右侧看到两个分屏按钮（水平分屏/垂直分屏），以便快速将当前 SplitPane 一分为二。
2. 作为用户，点击水平分屏按钮时，当前 SplitPane 被左右分割为两个 SplitPane，新 SplitPane 自动创建一个集成终端 Tab。
3. 作为用户，点击垂直分屏按钮时，当前 SplitPane 被上下分割为两个 SplitPane，新 SplitPane 自动创建一个集成终端 Tab。
4. 作为用户，我可以拖拽 SplitPane 之间的分割线来调整两个 SplitPane 的大小比例。
5. 作为用户，每个 SplitPane 拥有独立的 TabBar，显示该 SplitPane 的所有 Tab，我可以点击切换、关闭 Tab。
6. 作为用户，关闭 SplitPane 中的最后一个 Tab 时，该 SplitPane 被关闭，其兄弟 SplitPane 扩展填充空间。
7. 作为用户，关闭一个 SplitPane 后，其兄弟 SplitPane 自动扩展填充释放的空间，布局恢复为单 SplitPane。
8. 作为用户，当根 SplitPane 没有任何 Tab 时，显示空状态（"新建会话"/"新建终端"按钮），与当前未分屏时的行为一致。
9. 作为用户，切换工作目录时，中间区整体替换为对应 cwd 的分屏树和 Tab 列表。
10. 作为用户，从侧边栏点击"新建会话"或文件树打开文件时，新 Tab 自动进入当前活跃的 SplitPane。
11. 作为用户，我可以在 SplitPane 的 TabBar 中拖拽重排 Tab 顺序（仅限同一 SplitPane 内）。
12. 作为用户，分屏后每个 SplitPane 的 Tab 列表独立，互不干扰。


## Implementation Decisions

### 1. splitStore 替代 tabStore

新建 `splitStore.ts`，合并原 `tabStore` 的全部功能。每个 cwd 持有自己的分屏树（`SplitTree`），每个 SplitLeaf 持有自己的 `tabs: Tab[]` 和 `activeTabId`。原 `tabStore` 退役。

### 2. 组件结构

```
SplitPane (递归组件)
  ├─ SplitLeaf 分支
  │   ├─ TabBar（该 leaf 的 tab 列表）
  │   └─ tab 内容区（激活的 tab）
  ├─ SplitNode 分支
  │   ├─ SplitPane (递归)
  │   ├─ SplitDivider (可拖拽分割线)
  │   └─ SplitPane (递归)
```

### 3. SplitDivider 纯渲染组件

参考 Ridge 的 RgSplitter：纯渲染，无内部拖拽状态机。视觉为 1px 中心线，hover/drag 时 scale 4× + 高亮色，宽不可见命中区域（8px padding + 负 margin）。拖拽逻辑由消费者（SplitPane/SplitContainer）通过 `mousedown` → `mousemove` → `mouseup` 更新 `splitStore.setRatios`。

### 4. 分屏按钮

TabBar 右侧新增两个按钮：
- 左右分屏按钮（图标：矩形被竖线分割）
- 上下分屏按钮（图标：矩形被横线分割）

点击时调用 `splitStore.splitPane(leafId, direction)`。

### 5. 新建 SplitPane 自动创建终端

`splitPane` action 创建新 SplitLeaf 后，自动调用 `spawnTerminal` IPC 创建集成终端，并将终端 Tab 添加到新 SplitLeaf 的 tabs 中。

新终端的工作目录继承 parent leaf 的 active tab 的 cwd：
- 若 active tab 是 SessionTab / IntegratedTerminalTab / DiffTab / SessionContentTab，取其 `cwd` 字段
- 若 active tab 是 PreviewTab，取其 `root` 字段
- 若 active tab 不存在或其 cwd 为空，回退到全局 `activeCwd`

### 6. 切换 cwd 时 keep-alive（所有 cwd 分屏树同时存在于 DOM 中）

所有 cwd 的分屏树**同时存在于 DOM 中**，非活跃 cwd 的分屏树用 `opacity:0 + pointer-events:none + position:absolute` 整体隐藏（沿用当前 keep-alive 机制）。

**关键理由**：`SessionPane`/`IntegratedPane` 的 `useEffect` cleanup 中调用 `releasePane(key)` 销毁 xterm 实例。如果切换 cwd 时卸载组件树，所有 xterm 实例会被销毁，切回时 WebGL 需重新初始化导致"闪白"和滚动位置丢失。

**实现方式**：
- 所有 cwd 的 SplitPane 树同时渲染，外层容器用 `display: contents` 或直接渲染
- 非活跃 cwd 的根容器加 `opacity:0 + pointer-events:none + position:absolute + inset:0`
- 活跃 cwd 的根容器加 `opacity:1 + pointer-events:auto + position:relative`
- 这样 `SessionPane`/`IntegratedPane` 的 `useEffect` 不触发 unmount，xterm 实例自然保留

### 7. 活跃 SplitLeaf 跟踪与 leafId 参数

`splitStore.activeLeafId` 记录最近活跃的 SplitLeaf。点击 SplitPane 的 TabBar 或内容区域时，该 SplitLeaf 变为活跃。

所有新建 Tab 的 action（`openSession`/`openPreview`/`openDiff`/`openTerminal`/`openSessionContent`）接受可选的 `leafId?: string` 参数：
- 当 `leafId` 未传时，内部使用 `activeLeafId` 确定目标 leaf
- 当 `leafId` 显式传入时，直接使用指定的 leaf

这样 App.tsx 中大部分现有调用（不传 leafId）无需修改，同时保留显式指定 leafId 的能力。

### 8. Tab 全局去重策略

同一 session/diff/preview 的 tab 全局唯一，不能同时出现在两个 SplitLeaf 中。

- **`openSession`**：按 `key` 全局去重。若 key 已存在于某个 leaf（任意 leaf），则切换活跃 leaf 到该 leaf 并激活该 tab，而非创建副本。
- **`openPreview`**：按 `preview:<root>//<path>` 格式的 id 全局去重。若已存在，切换到所在 leaf 并激活。
- **`openDiff`**：按 `diff:<cwd>//<commitHash>` 格式的 id 全局去重。若已存在，切换到所在 leaf 并激活。
- **`openTerminal`**：按终端 id 全局去重。终端 id 由主进程生成，本身唯一。

**关键约束**：`paneManager` 以 key 为索引管理 xterm 实例，同一 sessionKey 只能对应一个 `XtermTerminal` 实例，该实例只能挂载到一个 host `<div>` 上。全局去重保证了这一点。

### 9. 关闭 SplitPane 的行为

`closeLeaf` action 递归操作：
- 在 SplitNode 中移除指定 SplitLeaf，返回其兄弟节点
- 如果兄弟节点是 SplitLeaf，则合并回单个 SplitLeaf
- 如果兄弟节点是 SplitNode，则保留为 SplitNode
- 从根节点逐层清理：如果 SplitNode 的子节点数 < 2，则提升唯一的子节点取代该 SplitNode

### 10. 最小 SplitPane 比例

拖拽分割线时，任一 SplitPane 的 ratio 不低于 6%（参考 Ridge 的 MIN_PANE_RATIO），防止 SplitPane 被拖拽到不可见。

### 11. Tab 类型保持

保留现有的 Tab 类型（SessionTab, PreviewTab, DiffTab, IntegratedTerminalTab, SessionContentTab）和 TabKind 枚举。Tab 的归属权从全局扁平数组转移到 SplitLeaf 的 `tabs` 字段。

### 12. 辅助函数：findTabLeaf / findTabLeafByKey

在 splitStore 中增加辅助函数，用于在分屏树中搜索 tab：

```typescript
// 遍历所有 cwd 的所有 leaf，返回包含指定 tabId 的 leaf 及其所在 cwd
type TabLocation = { cwd: string; leaf: SplitLeaf; tab: Tab };

function findTabById(tabId: string): TabLocation | null

// 按 session key 搜索（用于全局去重和 IPC 事件）
function findTabByKey(key: string): TabLocation | null

// 按终端 id 搜索（用于 removeTerminalTab）
function findTabByTerminalId(id: string): TabLocation | null
```

**说明**：`tabId` 和 `key` 是不同的概念。`SessionTab.id` 格式为 `session:<sessionKey>`，而 `key` 是原始 session key（如 `/a/session.jsonl`）。全局去重和 IPC 事件需要使用按 `key` 搜索的变体。

用于以下场景：
- `removeSessionTab(key)` / `removeTerminalTab(id)` — IPC 事件触发的 tab 移除，需要在所有 cwd 和 leaf 中查找
- `openSession`/`openPreview`/`openDiff` 的全局去重
- `allTabs` 计算属性（遍历所有 leaf 收集所有 tab，供 `useSidebarState`/`useSessionStatus` 等外部 hooks 使用）

### 13. reorderTabs 作用域

Tab 拖拽重排限制在 SplitLeaf 内，不支持跨 leaf 拖拽。改为：

```typescript
reorderTabsInLeaf(leafId: string, orderedIds: string[]): void
```

`TabBar` 组件传入所在 leaf 的 id，拖拽结束时调用 `reorderTabsInLeaf(leafId, orderedIds)`。

### 14. closeGuards 机制适配

`closeGuards`（PreviewTab 的 dirty 确认拦截器）保持按 tab id 索引的全局 Map 方案不变。每个 leaf 的 TabBar 的 `onClose` 回调指向同一个 `requestCloseTab` 函数，该函数从 CenterPane 的 `closeGuards` ref 中查找拦截器。

### 15. 文件结构

新建：
- `src/renderer/src/store/splitStore.ts` — 分屏状态管理（替代 tabStore）
- `src/renderer/src/components/SplitPane.tsx` — 递归分屏渲染组件
- `src/renderer/src/components/SplitDivider.tsx` — 可拖拽分割线

修改：
- `src/renderer/src/components/TabBar.tsx` — 添加分屏按钮
- `src/renderer/src/components/CenterPane.tsx` — 集成 SplitPane
- `src/renderer/src/App.tsx` — 所有 tab 操作指向 splitStore
- `src/renderer/src/styles/app.css` — 添加分屏相关 CSS

## Testing Decisions

### 测试策略

- **splitStore 纯逻辑测试**：与现有 `tabStore.test.ts` 相同模式，纯单元测试，`vi.mock` 掉 `paneManager` 依赖。覆盖分屏树的创建、拆分、合并、关闭、Tab 操作等核心逻辑。
- **SplitDivider 渲染测试**：测试渲染方向（horizontal/vertical）和拖拽回调。
- **SplitPane 渲染测试**：验证递归渲染正确性（leaf 渲染 TabBar + 内容，split 渲染子节点 + 分割线）。

### 测试模块

- `src/renderer/src/store/__tests__/splitStore.test.ts` — 主测试文件，继承现有 tabStore 测试用例并扩展分屏用例
- `src/renderer/src/__tests__/SplitPane.test.tsx` — 组件渲染测试

### 测试用例（splitStore）

参考现有 `tabStore.test.ts` 的模式：
- 初始状态为单 leaf
- 分屏一个 leaf 后变为 split node，两个 leaf 各占 50%
- 分屏后新 leaf 包含一个集成终端 tab（验证 cwd 继承）
- 关闭 leaf 后合并回单 leaf
- 连续分屏（嵌套分屏）
- 在 leaf 中 openSession/openPreview/openDiff（不传 leafId 时使用 activeLeafId）
- 切换 leaf 的 activeTab
- 关闭 leaf 中的 tab
- 关闭 leaf 中的最后一个 tab（leaf 被关闭）
- 拖拽分割线更新 ratios
- 全局去重：同一 session key 在另一 leaf 中已存在时，跳转到该 leaf
- 跨 cwd 切换：cwdA 有分屏树，切到 cwdB（单 leaf），再切回 cwdA — 分屏树完整恢复
- 嵌套分屏后关闭：水平分屏 → 右 leaf 垂直分屏 → 关闭右 leaf → 恢复为水平分屏
- IPC 触发的 tab 移除：`removeSessionTab` 在嵌套分屏树中移除 tab
- 分屏后关闭所有 leaf 的 tab → 根 leaf 显示空状态
- 跨 cwd 独立（cwdA 分屏不影响 cwdB）

## Out of Scope

- Tab 跨 SplitPane 拖拽移动（第一阶段不支持）
- 工作区层级的分屏状态持久化（第一阶段不持久化，重启后恢复为单 leaf）
- 分屏树的撤销/重做
- 通过快捷键分屏
- 分割线双击重置为 50/50
- 4-way junction 正交联动拖拽（ridge 的高级特性，暂不实现）

## Further Notes

- 参考 Ridge 的 `@ridge/split` 包设计（RgSplit/RgPane/RgSplitter），但使用 React 实现
- 拖拽分割线时锁定 body cursor（`col-resize` / `row-resize`），避免拖拽过程中鼠标 hover 到其他元素时 cursor 变化
- 分屏按钮的图标可复用现有 icon 组件的风格