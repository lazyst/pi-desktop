# Pi Desktop — 侧边栏目录/会话重构 + 终端滚动（Spec）

- **日期**：2026-07-14
- **状态**：已确认（brainstorming 设计阶段通过，进入实现计划）
- **前置文档**：`docs/2026-07-14-pi-desktop-design.md`（整体架构、IPC 契约、进程池模型）

## 1. 目标与范围

对现有 pi-desktop 的左侧栏与终端区做增量重构，落实 5 项需求：

1. **添加目录**：弹出系统文件管理器选目录 → `cd` 该目录并运行 `pi`；若用户没在运行的 pi 里发消息（没触发 pi 的新建会话），关闭后左侧列表不显示该目录。
2. **新建会话**：附加在左侧列表的某个目录上；hover 该目录时显示"新建会话"图标，点击在该目录下运行一个 `pi`；同样，没发消息就不进列表。
3. **置顶目录**：附加在目录上，hover 显示置顶图标，点击置顶，置顶目录排到列表最前。
4. **终端滚动条可拖动**：排查并修复主对话终端区竖向滚动条无法拖动的问题。
5. **置底按钮**：当主对话终端区不在底部时，右下角显示"置底"按钮。

**范围内（本次）**：
- 侧边栏改为"只显示 disk 会话"，移除"刚添加的 live 会话立刻出现"的行为
- 添加目录走系统原生目录选择对话框
- 新建会话改为"目录 hover 图标"，移除顶部 `+ 会话`
- 目录置顶（localStorage 持久化）
- 终端滚动条可拖动修复 + 置底 FAB

**范围外（本次不做）**：
- 多终端分屏 / 标签页
- 会话重命名、删除、搜索
- 置顶的跨设备/云端同步（仅本机 localStorage）

## 2. 核心模型变更（需求 1 & 2 的根因）

### 2.1 现状问题
`renderer/src/App.tsx` 中 `sessions` 由 `disk`（来自 `pi.listSessions()`）与 `open`（live 会话）合并而成，并且 `open` 里不在 disk 中的项会被直接补进 `sessions`。这导致：**刚 `openSession({cwd})` 出来的 live 会话即便用户一条消息没发，也会立刻出现在侧边栏。**

### 2.2 新模型
- **侧边栏只渲染 disk 会话**（`.jsonl` 文件，来自 `pi.listSessions()` / `session:index`）。
- **live 会话只活在终端区**：`open` 数组继续管理"已挂载 Terminal 实例 + 活动终端"的会话，`TerminalPane` 照常渲染。
- **晋升（promotion）机制**：当用户在某个 live 会话里发出首条消息，`pi` 会把这次会话写成一个 `.jsonl` 文件。主进程通过 `fs.watch` 监听到 sessions 目录变化 → debounce → 重新 `listFiles()` → 推 `session:index` 事件 → 渲染进程 `setDisk(...)`。此时该目录/会话才"晋升"进侧边栏。
- **未发消息即关闭的 live 会话**：从不曾写出 `.jsonl`，因此永远不会出现在侧边栏，自然满足需求 1 & 2 的"不显示"。

### 2.3 晋升检测方案（已定：fs.watch）
- **方案 A（采用）**：主进程 `fs.watch(SESSIONS_DIR, { recursive: true }, handler)`，handler 做 debounce（~300ms）后 `win.webContents.send('session:index', pool.listFiles())`。近实时、零轮询。
- 方案 B（定时轮询 `listFiles()`）：简单但迟钝且浪费 I/O，弃用。
- 方案 C（让 pi 主动上报）：当前无此通道，弃用。

> 备注：`recursive: true` 在 Windows / macOS 的 Node `fs.watch` 均支持；若个别平台不稳，降级为对 `SESSIONS_DIR` 单层 watch + 对已知子目录 watch，但首选 recursive。

## 3. 各需求落点

### 3.1 添加目录（需求 1）
- 侧边栏顶部保留 `+ 目录` 按钮（移除原"弹 modal 手输路径"的交互）。
- 点击 → 渲染进程调用新增 IPC `pi.pickDirectory()`。
- 主进程新增 `session:pickDirectory` handler：`dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '选择目录' })`，返回所选绝对路径（用户取消则返回 `null`）。
- 渲染进程拿到路径后调用 `pi.openSession({ cwd })` → 主进程 `pool.openNew(cwd)` 在该目录 spawn `pi` → 切为活动终端。
- **不手动把该项塞进侧边栏**；它只作为 live 会话出现在终端区。发首条消息后由 2.3 的晋升机制进入列表。
- 边界：所选目录若已有 pi 会话，`listFiles()` 本就显示它们；本次只是额外开一个 live 会话。

### 3.2 新建会话（需求 2）
- **移除** 顶部 `+ 会话` 按钮与对应 modal。
- 每个目录分组（group）在 **hover** 时，于分组标题右侧浮现 `⊕`（新建会话）图标，点击 → `pi.openSession({ cwd: group.cwd })` 在该目录 spawn `pi`，切为活动终端。
- 同样遵循晋升机制：没发消息就不进列表。
- 目录分组标题承担两个 hover 动作：`📌`（置顶，见 3.3）与 `⊕`（新建会话）。

### 3.3 置顶目录（需求 3）
- 每个分组 hover 时显示 `📌` 图标；点击切换该 `cwd` 的置顶状态。
- 置顶状态存 **localStorage**（key 如 `pi-desktop:pinned-dirs`，值为 `cwd` 字符串数组）。已确认采用 localStorage（无需主进程改动、重启后保持）。
- 渲染侧排序：置顶分组置顶，置顶内部维持用户置顶的先后顺序；其余分组保持原有顺序（按目录路径/枚举顺序）。
- 已置顶分组：标题前常驻显示置顶角标，并加一条常驻的淡强调色左轨（复用现有"活动会话左轨"视觉语言）作为视觉锚点。
- 边界：置顶一个会话很多的目录与置顶空目录行为一致（按 cwd 维度）。

### 3.4 滚动条可拖动（需求 4）
- **排查结论（设计阶段，待运行时确认）**：xterm 的滚动条绘制在 `.xterm-viewport`（`overflow-y: scroll`）。当前全局 `tokens.css` 的 `*::-webkit-scrollbar-thumb { background: var(--border) }`（`#283040`）在黑色终端背景（`#000`/深灰）上几乎不可见，加上 xterm 在收到数据时会把 `scrollTop` 弹回底部，体感为"拖不动"。
- **修复**：
  1. 给 `.xterm-viewport` 单独提升滑块可见度：`.xterm-viewport::-webkit-scrollbar { width: 10px }`、thumb 用 `--border-strong`/`--accent`、加可见 track。
  2. 运行时用 dev/playwright 实机验证原生拖拽可用；若原生拖拽确属 xterm 已知问题（被 viewport 事件吞掉），则：保留原生滚动条 + 支持滚轮滚动（xterm 默认已处理 wheel）+ 以置底 FAB（3.5）作为回到最新行的主入口，必要时引入 xterm 的 `scrollSensitivity` 调优。
  3. 不引入额外滚动条库，保持轻量。
- 验证手段：`pnpm test:e2e` 的手动/自动走查 + 必要时在 dev 下人工拖拽确认。

### 3.5 置底按钮（需求 5）
- 仅当**活动**会话且**未贴底**时显示，固定在终端区右下角。
- 状态来源：xterm 的 `term.onScroll((newPosition) => ...)`，`newPosition` 为距底部的行数，`0` 即贴底；`>0` 显示按钮。
- 点击：`term.scrollToBottom()`。
- 可选增强：按钮上叠加"未读行数"徽标（`newPosition` 近似）。v1 先做按钮本身，徽标作为加分项（实现时可一并做）。
- 多个 `TerminalPane` 同时挂载但只有 `active` 的可见：FAB 由当前活动 `TerminalPane` 在其容器内绝对定位渲染，非活动的不渲染。

## 4. 前端设计（frontend-design 应用）

在既有"暗色 / 等宽 / 冷蓝 `#7c9cff`"体系内做**增量**，不推翻整体；复用已有设计 token（`tokens.css`）。

- **图标语言（统一）**：新增会话 `⊕`、置顶 `📌`、置底 `↓` 均用 14–16px、1.5px 描边、`fill:none`、`stroke: currentColor` 的内联 SVG React 组件，随主题同色。避免 emoji 渲染差异，实际用 SVG 而非字符。
- **hover 浮现（降噪）**：分组操作图标默认 `opacity: 0`；分组 `:hover`/`:focus-within` 时淡入（`transition: var(--transition)`，140ms）。避免常驻噪点，与现有 `.terminate` 的 hover 显隐一致。
- **签名元素复用**：现有"活动会话强调色左轨"（`border-left-color: var(--accent)`）是有辨识度的签名；置顶目录复用同一条左轨（更淡，如 `rgba(124,156,255,0.35)`）作视觉锚点，FAB 用同一强调色描边 —— 整体克制、一致。
- **FAB**：圆形、`--r-lg` 圆角、`1px solid var(--accent)`、背景 `--bg-elevated`、`box-shadow: var(--shadow-modal)`、距终端区右下 `--sp-3`；`scale` 淡入；`prefers-reduced-motion` 下去掉过渡；键盘 `:focus-visible` 有焦点环。
- **可访问性**：hover 图标按钮 `aria-label` 明确（"在该目录新建会话""置顶此目录""滚动到最新"）；键盘可达（`<button>` + `:focus-visible`）。

### 线框

侧边栏（置顶目录常驻角标 + hover 浮现操作）：
```
会话                            [+ 目录]
─────────────────────────────────────────
📌 📁 C:\Users\hcz\project      📌 ⊕    ← 已置顶常驻📌；hover 显📌⊕
     • e2e-session          12:30
     • other-session        yesterday
📁 C:\Users\hcz\.pi-agent          📌 ⊕
     • session-a
```

终端区右下角 FAB（未贴底时出现）：
```
                        ⌄
                     [ ↓ ]   ← 绝对定位，终端区右下角
```

## 5. 组件与文件级改动清单

- `src/main/index.ts`
  - 新增 `ipcMain.handle('session:pickDirectory', ...)`：`dialog.showOpenDialog` 返回路径/`null`。
  - 创建 `pool` 后启动 `fs.watch(SESSIONS_DIR, { recursive: true }, debouncedEmitIndex)`，推送 `'session:index'`。
  - 初始列表继续由渲染进程 `pi.listSessions()` 拉取（`session:list`），watch 负责后续增量更新。
- `src/preload/index.ts`
  - 新增 `pickDirectory: () => ipcRenderer.invoke('session:pickDirectory')`。
  - 新增 `onIndex: (cb) => ipcRenderer.on('session:index', (_e, groups) => cb(groups))`。
- `src/renderer/src/ipc.ts`
  - `PiApi` 增加 `pickDirectory()` 与 `onIndex(cb)` 类型。
- `src/renderer/src/types.ts`
  - 如需可加 `PinnedDirs` 类型（localStorage 形状），其余复用现有类型。
- `src/renderer/src/App.tsx`
  - `sessions` 改为仅 `disk`（删除 `liveOnly` 合并逻辑）。
  - 挂载 `pi.onIndex((groups) => setDisk(groups.flatMap(...)))` 替代/补充现有 `pi.listSessions()` 初始拉取。
  - `handleOpen` 对"添加目录/新建会话"仍走 `openSession({cwd})`，但不手动注入侧边栏。
  - 保留 `active = open.find(...)`，确保活动 live 会话（即便不在 disk）仍能正确显示在终端区与 header。
- `src/renderer/src/components/Sidebar.tsx`
  - 移除顶部 `+ 会话` 按钮与手输路径的 modal（保留 `+ 目录` → 调 `onPickDirectory`）。
  - 分组标题区新增两个 hover 图标按钮：`置顶`（调 `onTogglePin(cwd)`）与 `新建会话`（调 `onOpen({ cwd })`）。
  - 从 `localStorage` 读 `pinned`，排序：置顶在前；已置顶分组加常驻角标 + 左轨 class。
  - `Props` 新增 `onPickDirectory: () => void`、`onTogglePin: (cwd: string) => void`；`sessions` 语义明确为 disk 会话。
- `src/renderer/src/components/TerminalPane.tsx`
  - `term.onScroll((pos) => setShowJump(!pos))` 驱动 FAB 显隐。
  - 渲染置底 FAB（仅 `active` 时），点击 `term.scrollToBottom()`。
  - 活动切换（`active` 变化）时重新计算一次显隐。
- `src/renderer/src/styles/app.css` / `tokens.css`
  - 新增分组操作图标（`.group-actions`、`.icon-btn`）、置顶左轨（`.group.pinned`）、FAB（`.jump-bottom`）样式。
  - 新增 `.xterm-viewport` 滚动条可见度修复规则。
- 新增 `src/renderer/src/components/icons.tsx`（或内联 SVG 组件）：`IconNewSession`、`IconPin`、`IconArrowDown`。

## 6. IPC 契约变更（相对前置文档）

渲染 → 主（新增）：
- `session:pickDirectory` —— 弹出系统目录选择，返回绝对路径或 `null`
- `session:index`（主 → 渲染，新增推送）—— 目录变化时推送最新 `SessionGroup[]`

其余 `session:list / open / input / resize / terminate / data / status / exit` 不变。

## 7. 生命周期与边界情况

- 启动：渲染进程 `pi.listSessions()` 拉初始 disk 列表（同前）；主进程 watch 负责后续增量。
- 添加目录后取消选择：返回 `null`，不做任何事。
- 新建会话（目录 hover）：同 `openSession({cwd})`，无消息则不进列表。
- 置顶后该目录被删除/清空：分组不再枚举即不显示，localStorage 中残留的 cwd 不影响（渲染时只作用于实际存在的分组）。
- 关闭活动 live 会话（无消息）：从 `open` 移除，不在 disk，列表无痕。
- 关闭 app：`pool.killAll()`（同前）。
- 置底 FAB：仅在 `active` 且 `onScroll` 距底 > 0 时显示。

## 8. 验证方式

- **单测（`vitest`）**
  - `Sidebar.test.tsx`：断言侧边栏只含 disk 会话（移除"disk+live 合并"旧用例）；新增"置顶后排序置顶""hover 新建会话以该 cwd 调 `onOpen`""`+目录` 触发 `onPickDirectory`""置顶按钮调 `onTogglePin`"。
  - `TerminalPane.test.tsx`：mock 验证 `onScroll` 驱动 FAB 显隐、`scrollToBottom` 点击被调用。
- **E2E（`playwright`，`e2e/app.spec.ts`）**
  1. 启动 app → 点 `+ 目录` → 系统对话框选目录（可用 fake pi + 预设路径）→ 终端区出现新 pi。
  2. 在 live 会话发首条消息 → 侧边栏出现该目录/会话（晋升）。
  3. 不发的 live 会话直接关闭/切走 → 侧边栏不出现。
  4. hover 目录 → 点 `⊕` 新建会话；点 `📌` 置顶，目录置顶且刷新后保持。
  5. 终端滚动上移 → 右下角出现置底按钮 → 点击回到最新。
  6. 实机确认终端竖向滚动条可拖动（需求 4）。
- **手动**：`pnpm dev` 跑起 app，逐项手测 5 项需求，重点确认滚动条可拖与置底按钮。

## 9. 风险与对策

- `fs.watch` recursive 在部分平台/网络盘不稳 → debounce 容错；必要时单层 + 子目录 watch 兜底，本次首选 recursive。
- 置顶 localStorage 与 disk 分组不同步（目录改名/移动）→ 渲染时只作用于现存分组，残留 cwd 无副作用；不做跨改名同步。
- 滚动条根因若非"滑块不可见"而是 xterm 事件吞拖拽 → 以 FAB + 滚轮为主入口，保持原生滚动条，不引入额外库。
- 多个 TerminalPane 同挂：FAB 仅在 `active` 渲染，避免重复按钮与状态错乱。
