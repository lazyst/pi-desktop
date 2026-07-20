# 02 — tabStore 落地核心状态与 action

**What to build:** 把统一 Tab 模型的运行时状态真正落到 `tabStore.ts`：实现 `tabs` / `activeEditorTabId` / `activePanelTabId` 的读写，以及全部 action。关键语义迁移——现有 `App.tsx` 的 `closedTabIds` 集合（关闭会话终端=隐藏不卸载）并入 `Tab.hidden` 标志；集成终端与中间区 tab 统一进单数组，用 `location` 区分（editor / panel）。主进程 `SessionPool` / `IntegratedTerminalPool` 的调用点暂不动，store 仅作为状态容器。

**Blocked by:** 01 — 引入 zustand 依赖与空 tabStore 骨架

**Status:** completed

- [x] `tabs: Tab[]` 单数组承载 session / preview / diff / integrated-terminal 四种 kind
- [x] `activeEditorTabId` 与 `activePanelTabId` 双激活指针，分别追踪中间区与底部终端区
- [x] `openSession` / `openPreview` / `openDiff` / `openTerminal` 创建或激活对应 Tab（同 key 已存在则激活、取消 hidden）
- [x] `selectTab(id)` 按 Tab 的 location 写入对应激活指针
- [x] `closeTab(id)` 移除 Tab；会话 kind 的"关闭隐藏"语义由 `hideTab` / `setHidden` 表达（置 `hidden:true`，不卸载内容实例）
- [x] `reorderTabs(location, orderedIds)` 调整同 location 内 order
- [x] 纯函数 action 可单测，无需渲染环境（29 个单测全部通过）
