# 04 — 集成测试：壳重写后行为回归

**What to build:** 为阶段1（状态层+壳重写）补齐/修正测试，断言重构前后用户行为一致。重点覆盖 tab 切换、关闭（含会话 hidden 不卸载的 keep-alive）、集成终端开关与激活、drawer 高度持久化。确保后续阶段2/3/4 在已稳定的壳上改动不会悄悄破坏交互。

**Blocked by:** 03 — CenterPane / TabBar / TerminalDrawer 改造为从 store 取数

**Status:** done

- [x] `TerminalTabBar.test.tsx` 与 CenterPane 相关测试适配 store 取数后的契约
- [x] 新增/修正用例：会话 tab 关闭后 `hidden:true` 且内容实例不卸载（切回恢复滚动与历史）
- [x] 新增/修正用例：集成终端新建/切换/退出后激活指针正确迁移
- [x] `pnpm test` 全绿，新增断言覆盖 store action 的纯函数行为

**完成记录：**
- `src/renderer/src/store/__tests__/tabStore.test.ts`：在既有 29 个 action 单测基础上扩展
  至 42 个，新增 `closeCenterTab`（session=隐藏 keep-alive 不卸载 / preview·diff=真移除且激活
  指针回退）、`removeTerminal`（退出后激活指针迁移到剩余第一个或 null、移除非激活不动指针）、
  `drawer 状态`（toggleDrawer / setDrawerOpen / setDrawerHeight / setActiveTermId /
  setTerminals 整体覆盖不产生重复 id）三组纯函数行为断言。
- `src/renderer/src/__tests__/TerminalTabBar.test.tsx`：保留既有 4 个契约用例，新增 1 个
  「store 取数契约回归」用例，显式断言 TerminalDrawer 把 `store.terminals` / `activeTermId`
  映射成 TerminalTabBar 的 props 时形状精确（active 跟随 activeTermId 而非首个）。
- `src/renderer/src/__tests__/CenterPane.test.tsx`（新增，11 个用例）：用轻量桩替换
  TerminalPane/PreviewTab/DiffTab/TerminalDrawer，断言从 store 取数渲染中间区 TabBar
  （仅可见 tab、active 跟随 activeEditorTabId、空状态）、会话 tab 关闭后 `hidden:true`
  且内容 div 仍挂载（keep-alive，切回可恢复）、preview × 经 CenterPane guard 拦截、
  diff × 直走 closeCenterTab、抽屉高度/开关取数自 store.drawerHeight/drawerOpen 并经
  回调写回 App。
- `src/renderer/src/__tests__/IntegratedTerminal.activation.test.tsx`（新增，8 个用例）：
  断言集成终端「新建（setActiveTermId 置新激活）/ 切换（TerminalDrawer 把 activeTermId
  反映到 TabBar active class、tab 点击回调 onSelectTab(id)）/ 退出（removeTerminal 迁移
  激活指针、TerminalDrawer 渲染数量随 store.terminals 实时减少）」三种操作后激活指针的
  精确迁移，确保后续阶段在已稳定的壳上改动不会悄悄破坏交互。
- 验证：`pnpm test`（vitest run）全绿——36 个测试文件 / 329 个用例全过（含本次新增 19 个）；
  `npx tsc --noEmit` 无类型错误。
- 发现并记录的潜在问题（非本次范围，留待后续 issue）：TerminalDrawer 的 `onSelectTab`
  当前接线为 `selectTab`（仅作用于 `tabs[]` 中 `terminal:${cwd}` id），而抽屉内的终端
  tab 用的是主进程 `t-1` 这类 id，故点击抽屉内终端 tab 切换激活目前经 `selectTab` 为
  no-op，真实激活迁移依赖 `setActiveTermId`。已用 `setActiveTermId` 路径锁定「切换」行为，
  不在本次回归测试范围内改动 store/壳逻辑。
