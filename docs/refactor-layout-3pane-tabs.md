# 重构方案：三栏布局 + 通用 Tab 框架

> 本方案经一轮 `/grilling` 会话逐点确认，所有布局决策已钉死。
> 灵感来自 orca-src 的"三栏 + Tab"方向，但**不复制 orca 具体 UI**，
> 完全基于 pi-desktop 现有组件重写布局容器。

## 1. 目标布局（最终形态）

```
┌──────────────────────────────────────────────────────────────────┐
│ TitleBar（应用名 + 最小化/最大化/关闭，保持现状）                     │
├────────────┬────────────────────────────────────────┬────────────┤
│ 左：Sidebar │ 中：统一 Tab 区                          │ 右：Tab 栏  │
│ 会话目录    │ 顶部 Tab 条（session / preview / diff）  │ 文件树 | Git│
│ 分组+绿点   │ ┌────────────────────────────────────┐ │            │
│ 保留现状    │ │ 当前 active tab 内容                 │ │            │
│            │ ├────────────────────────────────────┤ │            │
│            │ │ 集成终端抽屉（底部，仅跨中栏）       │ │            │
│            │ └────────────────────────────────────┘ │            │
└────────────┴────────────────────────────────────────┴────────────┘
```

三栏宽度均可拖拽（复用现有 `Sidebar` 宽度 / `FilePanel` 宽度的拖拽逻辑，
新增右侧栏宽度持久化到 `config`，字段建议 `rightPanelWidth`）。

## 2. 已确认的决策（grilling 结论）

| # | 决策点 | 结论 |
|---|--------|------|
| D1 | 重构范围 | 只动 renderer 布局 + 状态模型，**同步改对应单元测试**；不动 main 进程 / IPC / 集成终端逻辑 |
| D2 | orca 关系 | 不抄 orca 具体 UI，仅借"三栏 + Tab"方向 |
| D3 | 中间区 Tab 模型 | **统一 Tab 条**：session / 预览 / diff 混排在同一 Tab 条 |
| D4 | 右侧栏 | **Tab 切换**：文件树 | Git |
| D5 | 集成终端位置 | **解读 A**：抽屉渲染在中间 `main` 区内部底部，仅跨中栏；逻辑复用现有 `TerminalDrawer`，只改挂载容器与 CSS |
| D6 | Tab 保活 | **keep-alive**：所有 tab 内容都渲染，非 active 的 `display:none` 隐藏，不卸载（对齐现有 `TerminalPane` / `IntegratedTerminalPane`）|
| D7 | Sidebar ↔ 中间 Tab | Sidebar 点击会话 → 中间区新增/激活该会话 tab（**复用现有 `open` / `activeKey` 逻辑**，仅渲染位置从主区搬到中间 Tab 容器）|
| D8 | 预览/diff 成 tab | 点击文件 → 中间区新增预览 tab；点击 git diff → 新增 diff tab；均为**真实 tab**，进 keep-alive 列表 |
| D9 | 现有抽屉命运 | `FileDrawer` / `GitDiffDrawer` **删除**，功能迁移进中间区统一 Tab；`TerminalDrawer` **保留逻辑**，仅改挂载位置（D5）|

## 3. 核心数据结构变更（最关键）

把 `App.tsx` 里现有的"只装会话"的 `open: OpenSession[]` + `activeKey` 扩展为
**通用 tab 模型**：

```ts
type TabKind = 'session' | 'preview' | 'diff';

interface BaseTab { id: string; kind: TabKind; active: boolean; }

interface SessionTab extends BaseTab {
  kind: 'session';
  key: string;      // sessionKey（.jsonl 路径 / live-<uuid>）
  cwd: string;
  name: string;
}
interface PreviewTab extends BaseTab {
  kind: 'preview';
  root: string;     // 仓库根
  path: string;     // 相对路径（来自现有 DrawerFile）
}
interface DiffTab extends BaseTab {
  kind: 'diff';
  cwd: string;
  commitHash: string | null;  // null = 工作区 diff
}

type AnyTab = SessionTab | PreviewTab | DiffTab;
```

- `open: OpenSession[]` → 由 `tabs: AnyTab[]` 中的 `kind==='session'` 项派生（或合并进同一状态）。
- `activeKey` → `activeTabId: string`。
- 现有所有 `handleOpen` / `setActiveKey` / `onExit` 逻辑保留，改为操作 `tabs`。

> ⚠️ 这是整个重构**最易写崩**处：必须保证 `open` 里的 keep-alive / 进程 reconcile /
> 绿点状态流转在新 tab 模型下完全等价。建议先让 `tabs` 与 `open` 并存一个过渡期，
> 确认行为一致后再删 `open`。

## 4. 组件改动清单

### 4.1 新增
- `components/TabBar.tsx` — 通用 Tab 条，支持三种 tab 类型的图标/标题/关闭按钮。
  （可参考现有 `TerminalTabBar.tsx` 的接口，扩展 `TabItem` 支持 `kind`。）
- `components/CenterPane.tsx` — 中间区容器：渲染 Tab 条 + active tab 内容 + 底部集成终端抽屉。
- `components/RightPanel.tsx` — 右侧栏容器：Tab 切换（文件树 | Git），复用 `FileTree` + `GitView`。
- `components/PreviewTab.tsx` — 文件预览内容（现有 `FileDrawer`/`ImagePreview`/`CodePreview`/`SplitDiffView` 的 keep-alive 包装）。
- `components/DiffTab.tsx` — git diff 内容（现有 `GitDiffDrawer` 内部逻辑提取）。

### 4.2 修改
- `App.tsx` — DOM 结构改为三栏；状态模型改为通用 tab（§3）；删除 `FileDrawer` / `GitDiffDrawer` 的 state，改为向 `tabs` 追加 preview/diff tab；把 `TerminalDrawer` 从窗口底部挪到 `CenterPane` 内部。
- `FilePanel.tsx` → 重构为 `RightPanel.tsx`：移除内部 `tab` state（或保留），作为右栏内容；`onOpenFile` 改为"追加 preview tab"，`onOpenWorkDiff`/`onOpenCommit` 改为"追加 diff tab"。
- `GitView.tsx` — 不动内部逻辑，仅 `onOpenWorkDiff` / `onOpenCommit` 接线改指中间区 diff tab。
- `styles/app.css` / `tokens.css` — 新增三栏 grid 布局、`right-panel` 样式、集成终端抽屉"仅跨中栏"的 CSS。

### 4.3 删除
- `FileDrawer.tsx` — 功能并入 `PreviewTab`。
- `GitDiffDrawer.tsx` — 功能并入 `DiffTab`。
- （`TerminalDrawer.tsx` 保留，仅改挂载位置。）

## 5. 集成终端（D5，低风险）

`TerminalDrawer` 的 `TerminalTabBar` + `IntegratedTerminalPane` + keep-alive 逻辑
**完全复用**。唯一改动：
- `App.tsx` 中把 `<TerminalDrawer>` 从 `.app-shell` 外的 `main` 下方，移到 `CenterPane` 内部、
  中间 Tab 内容之下。
- CSS：`.terminal-drawer` 宽度改为 `100%` 中栏宽度（不再横跨右栏）。
- `App` 里 `drawerOpen` / `terminals` / `activeTermId` / `drawerHeight` 等 state 与 handler 全部保留。

## 6. 测试改动（D1，必须同步）

现有测试中会因 DOM 结构大变而失败的（至少）：
- `App.test.tsx`、`App.terminal.test.tsx` — 断言 `.main` / `.terminal-area` / `.terminal-drawer` 位置。
- `FilePanel.test.tsx` — 中间栏文件树断言 → 改为右栏。
- `FileDrawer.test.tsx`、`GitDiffDrawer.test.tsx` — 删除或改为 preview/diff tab 测试。
- `Sidebar.test.tsx` — 点击会话展开终端的断言（位置变了，逻辑不变）。
- `TerminalDrawer.test.tsx` — 抽屉位置断言（跨中栏而非跨窗）。
- `sidebarGeometry.test.tsx` — 可能需新增右栏宽度几何。

建议：**先让组件级测试通过，再修 App 集成测试**；用 keep-alive 等价性作为回归红线。

## 7. 执行顺序（建议）

1. 抽 `TerminalTabBar` 通用化为 `TabBar`，支持 `kind`。
2. `App.tsx` 引入 `tabs` 状态模型（先与 `open` 并存）。
3. 新增 `CenterPane`，把现有 main 区 + TerminalDrawer 搬进去。
4. 把 `FilePanel` 改成 `RightPanel`（右栏 + Tab），接线改为追加 tab。
5. 提取 `PreviewTab` / `DiffTab`，删除 `FileDrawer` / `GitDiffDrawer`，接线改追 tab。
6. 删除并行的 `open` 状态，统一到 `tabs`。
7. 三栏 CSS grid + 拖拽宽度（新增 `rightPanelWidth` 持久化）。
8. 修测试。

## 8. 不在本次范围

- main 进程 / IPC 契约（`session:*` / `git:*` / `terminal:*` 不动）。
- 集成终端的 pty 逻辑（`integratedTerminalPool.ts` 不动）。
- 主题 / 配色（沿用现有 tokens.css）。
- 代码结构目录重构（src/main|preload|renderer 不动，不引入 orca 的 shared/types/relay）。
