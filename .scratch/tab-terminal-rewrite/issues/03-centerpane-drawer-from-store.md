# 03 — CenterPane / TabBar / TerminalDrawer 改造为从 store 取数

**What to build:** 将中间区与终端抽屉从"App 透传 ~13 个 props"改为"组件直接订阅 `useTabStore`"。`CenterPane` 不再接收散落 props，`TabBar` / `TerminalDrawer` 同理；`CenterPane` 内自行管理的 `closeGuards` ref 收编进 store。`App.tsx` 删除散落的 `useState` / ref mirror（`tabsRef` / `terminalsRef` / `closedTabIdsRef`），仅保留把主进程 IPC 事件（onExit / onIndex / onTerminalExit / onTerminalList）写回 store 的逻辑。**用户可见行为完全不变**，仅架构收敛、消除 ref mirror。

**Blocked by:** 02 — tabStore 落地核心状态与 action

**Status:** ready-for-agent

- [x] `CenterPane.tsx` 改为从 `useTabStore` 订阅 tabs / 激活指针，删除透传 props 入口
- [x] `TabBar.tsx` 与 `TerminalTabBar` 相关渲染从 store 取数；关闭 × 经 store 的统一 guard 入口
  - 注：`TabBar` / `TerminalTabBar` 是通用组件（分别被 `RightPanel` / `TerminalDrawer` 复用），保留 props 接口；
    数据来源由 `CenterPane` / `TerminalDrawer` 从 store 订阅后传入（即「从 store 取数」的取数层在二者，
    而非让通用组件直接耦合 store）。`CenterPane` 的 × 经本地 `closeGuards`（PreviewTab dirty 拦截）后
    调 `store.closeCenterTab`（session→隐藏 keep-alive / preview·diff→移除），`TerminalDrawer` 的 × 沿用
    App 协调回调 `handleCloseTab`（store.removeTerminal + 主进程 destroyTerminal）。
- [x] `TerminalDrawer.tsx` 改为从 store 取 terminals / activeTermId，删 tabs / activeId props 透传
- [x] `App.tsx` 移除 `tabs` / `activeTabId` / `closedTabIds` 及对应 ref mirror，改为初始化 store 并把 IPC 回调写回 store action
- [x] 内容组件（`TerminalPane` / `PreviewTab` / `DiffTab` / `IntegratedTerminalPane`）调用契约保持不变
- [x] 手动验证：开关会话、切 tab、关 tab（隐藏不卸载）、新建/切换集成终端、抽屉高度拖拽，行为同重构前

**实现说明（架构决策）**
- store 扩展：新增 `terminals` / `drawerOpen` / `drawerHeight` / `activeTermId` 状态与 action
  （`setTerminals` / `toggleDrawer` / `setDrawerOpen` / `setDrawerHeight` / `setActiveTermId` /
  `removeTerminal` / `removeSessionTab` / `closeCenterTab` / `promoteTabNames`），把 App 的
  `tabsRef` / `terminalsRef` / `closedTabIdsRef` 全部消除。`closedTabIds` 的 keep-alive 语义由
  store 的 `hidden` 字段承载（`hideTab` / `closeCenterTab` 对 session 置 hidden）。
- `closeGuards`（PreviewTab dirty 确认的拦截回调 Map）保留为 `CenterPane` 局部 `useRef`：它是 UI 拦截
  协调机制，非跨组件共享状态，放进全局 store 会违反「store 仅作状态容器」的设计约束（见
  `tabStore.ts` 顶部注释）；改造后它本就是 `CenterPane` 局部，已无 App 级 mirror，符合 issue 收敛目标。
- `openDiff` / `openPreview` 的 tab 标题对齐**重构前 App 的实际渲染**（`工作区改动`、hash 前 8 位、
  文件名优先），修正了 issue 02 写入 store 时的英文标题偏差，使「用户可见行为完全不变」真正成立。

**Status:** done
