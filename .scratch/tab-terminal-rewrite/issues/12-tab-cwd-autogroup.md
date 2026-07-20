# 12 — tab 条按 cwd 自动分段展示

**What to build:** 在 tab 条上按 `cwd` 自动分段显示 tab（ADR-0001 的 `TabAutoGroup`，E3），纯展示层归类，**不进入 store 数据模型**。不同 cwd 的 tab 之间有视觉分段，提升多项目并行时的可读性。

**Blocked by:** 03 — CenterPane / TabBar / TerminalDrawer 改造为从 store 取数

**Status:** done

- [x] `TabBar` 渲染时按 `tab.cwd` 归并分组，组间加视觉分隔（不引入 group 实体）
- [x] 拖拽重排（T11）与分组展示互不冲突，分组仅影响展示顺序/分隔
- [x] 手动验证：打开不同 cwd 的会话/文件，tab 条按目录分段展示且交互正常

## 实现说明（2025-07-20）

纯展示层分组，未触碰 store 数据模型（无 group 实体，符合 ADR-0001 E3）。

**改动点：**
- `TabBar.tsx` / `TerminalTabBar.tsx`：新增可选 `groupBy?: (t) => string | undefined` prop
  与 `TabBarItem.groupKey?` / `TabItem.groupKey?` 字段。分组逻辑抽到共享工具
  `tabGrouping.ts` 的 `buildGroupedRows()`，按 groupBy 返回值做**稳定聚簇排序**（同键 tab
  跨位置聚合到一段、段内保持父层传入的相对顺序），不同键之间插入 `terminal-tab-group-sep`
  分隔符。分隔符为**非 sortable 静态元素**（不进 `SortableContext` 的 items），故与 T11 拖拽
  重排互不冲突——所有 tab 仍在同一 `SortableContext` 中可跨段拖拽，`handleDragEnd` 仍基于
  原始 `tabs` 计算下标。不传 `groupBy` 时退化为原行为（零分隔符），保持向后兼容。
- `CenterPane.tsx`：构造 TabBar item 时按 `kind` 取分组键——`preview` 用 `root`、
  `session`/`diff` 用 `cwd`，并传 `groupBy={(t) => t.groupKey}`。
- `TerminalDrawer.tsx`：终端 tab 按对应 `integrated-terminal` tab 的 `cwd` 分组。
- `app.css`：新增 `.terminal-tab-group-sep` 样式（1px 竖线、上下留白、不可交互）。

**验证：**
- 新增 `TabBar.autogroup.test.tsx`（6 用例）：覆盖「不传 groupBy 行为不变」
  /「按键聚合+段间分隔」/「稳定归并+相邻同键不重插」/「**乱序/交错同键仍聚成连续段**
  （非仅相邻合并，修正初版碎片化）」/「分组+拖拽共存不影响 `.terminal-tab` 计数与顺序契约」
  /「纯展示模式也分组」。
- 全量测试 362 passed（含既有 TabBar.reorder / CenterPane / TerminalDrawer 测试均通过，
  分组分隔符不计入 `.terminal-tab` 计数，未破坏既有顺序/交互契约）。
- renderer 侧 typecheck 无新增错误（main 进程 10 个 TS 错误为 pre-existing，与本次无关）。
- 手动验证：需在 electron 中开不同 cwd 的会话/终端确认视觉分段（见下方待办）。

**待手动验证：** 在 `pnpm dev` 实际打开不同 cwd 的会话与集成终端，确认 tab 条按目录
分段且拖拽/关闭/新建交互正常（单元层已覆盖渲染与契约，端到端视觉待人工确认）。
