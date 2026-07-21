# 终端统一改造方案

## 背景

pi-desktop 目前有两种终端：

| | Pi 会话终端 | 集成终端 |
|---|---|---|
| 位置 | 中间编辑区（editor） | 底部抽屉（panel） |
| 本质 | 在 xterm.js 中显示 `pi` CLI 的 TUI | 在 xterm.js 中显示系统 shell（PowerShell/bash） |
| 底层 Pool | `SessionPool` | `IntegratedTerminalPool` |
| IPC 前缀 | `session:*` | `terminal:*` |
| Pane 组件 | `SessionPane.tsx` | `IntegratedPane.tsx` |
| 数据通道 | `SessionChannel` | `IntegratedChannel` |
| Shell integration | 无 | 有（OSC 633 cwd 检测等） |

**核心事实**：两者的底层都是 node-pty + xterm.js，差异仅在于**启动命令不同**——`SessionPool` spawn `pi`，`IntegratedTerminalPool` spawn 用户 shell。对此 Orca 项目的做法是将 agent 定义为配置记录，一个终端池统一管理。

目标：
1. 消除重复代码（两个 Pool、两个 IPC 命名空间、两个 Pane 组件、两个 Channel 类）
2. 统一 UI 布局——去掉底部抽屉，所有终端在统一 TabBar 中展示
3. 保留侧边栏业务逻辑（分组、置顶、运行状态、终端计数徽标等）

---

## 架构现状

### 主进程 (`src/main/`)

**`sessionPool.ts`** — 管理 pi 会话 PTY
- `ptyFactory('pi', args, opts)` → spawn `pi` 进程
- 额外职责：.jsonl 会话文件管理（listFiles / reconcile / deleteSession / clearDirectory）
- IPC 通道：`session:*`

**`integratedTerminalPool.ts`** — 管理系统 shell PTY
- `nodePty.spawn(profile.path, spawnArgs, opts)` → spawn shell
- 额外职责：Shell integration 注入（OSC 633）、CWD 跟踪、缓冲区持久化
- IPC 通道：`terminal:*`

**`index.ts`** — 两套 IPC handler
```
session:open / session:terminate / session:delete  → pool.*
session:input / session:resize / session:ack        → pool.*
terminal:create / terminal:destroy                   → termPool.*
terminal:input / terminal:resize / terminal:ack      → termPool.*
terminal:saveBuffer / terminal:loadBuffer            → 内存 Map
terminal:updateCwd                                   → termPool.updateCwd
```

### Preload (`src/preload/index.ts`)

`pi` 桥暴露两套 API：
```typescript
// 会话
pi.input / pi.resize / pi.onData / pi.onExit / pi.onStatus / pi.onRelink
pi.openSession / pi.terminate / pi.deleteSession

// 集成终端
pi.terminalInput / pi.terminalResize / pi.onTerminalData / pi.onTerminalExit
pi.createTerminal / pi.destroyTerminal / pi.listTerminalProfiles

// 路由 hack
pi.acknowledgeDataEvent(key, bytes)  // 按 key 前缀 'term-' 路由到 terminal:ack / session:ack
```

### 渲染进程 (`src/renderer/src/`)

**`terminalChannel.ts`** — 两个通道类：
- `SessionChannel` → 包 `pi.onData/pi.input/pi.resize`
- `IntegratedChannel` → 包 `pi.onTerminalData/pi.terminalInput/pi.terminalResize`

**`paneManager.ts`** — **已统一**！通过 `AcquireOptions.kind: 'session' | 'integrated'` 区分。

**`SessionPane.tsx`** — pi 会话的 React 壳（47 行渲染逻辑 + keep-alive）
**`IntegratedPane.tsx`** — 集成终端的 React 壳（195 行，含查找面板、buffer、shell integration）

**`CenterPane.tsx`** — 中间区容器：
```
.center-pane
  ├── TabBar（session / preview / diff）
  ├── .center-pane-body（SessionPane / PreviewTab / DiffTab）
  └── TerminalDrawer（底部抽屉）
        ├── TerminalTabBar
        └── IntegratedPane（keep-alive）
```

**`TerminalDrawer.tsx`** — 抽屉组件（resizer、高度拖拽、TerminalTabBar）

**`TabBar.tsx`** — 已支持 `kind: 'integrated-terminal'`（类型中已有）

**`Sidebar.tsx`** — 侧边栏（保留不动）：
- 按 cwd 分组显示 pi 会话
- 每个分组下有「新建会话」「新建终端」按钮
- 显示分组对应的终端计数徽标
- 置顶、多选删除、右键删除、清空目录

**`tabStore.ts`** — 两个 location：
```typescript
TabLocation = 'editor' | 'panel' | 'floating'
// 两个激活 ID
activeEditorTabId: string | null
activePanelTabId: string | null
```

---

## 改造方案（两步走）

### 第零步：了解现有测试

需要更新的测试文件：
- `src/main/__tests__/sessionPool.test.ts` + `sessionPool.realpty.test.ts`
- `src/main/__tests__/integratedTerminalPool.logic.test.ts` + `integratedTerminalPool.realpty.test.ts`
- `src/main/__tests__/integratedTerminalIpc.test.ts`
- `src/renderer/src/__tests__/IntegratedTerminal.test.tsx` + `.activation.test.tsx`
- `src/renderer/src/__tests__/SessionPane.test.tsx` + `.webgl.test.tsx`
- `src/renderer/src/__tests__/TerminalDrawer.test.tsx`
- `src/renderer/src/__tests__/App.terminal.test.tsx`
- `src/renderer/src/__tests__/CenterPane.test.tsx`
- `src/renderer/src/__tests__/paneManager.test.tsx`
- `src/renderer/src/__tests__/terminalChannel.test.ts`
- `src/renderer/src/store/__tests__/tabStore.test.ts`
- `src/renderer/src/__tests__/SettingsPanel.terminal.test.tsx`

---

### 第一步：合并 Pool + IPC + Channel（不改 UI 布局）

**目标**：消除所有重复的后端逻辑，保持 UI 不动，可独立上线。

#### 1.1 创建 `UnifiedTerminalPool`

新建 `src/main/unifiedTerminalPool.ts`，合并两个 Pool 的功能。

```typescript
export interface SpawnOptions {
  command?: string           // 'pi' → pi 会话，undefined → 默认 shell
  cwd: string
  profile?: TerminalProfile  // command 为 undefined 时必填
}

export interface TerminalInfo {
  id: string
  cwd: string
  title: string
  type: 'pi' | 'shell'     // 标记类型，供侧边栏/UI 区分
}

export class UnifiedTerminalPool {
  create(opts: SpawnOptions): TerminalInfo
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  destroy(id: string): void
  killAll(): void
  has(id: string): boolean
  list(): TerminalInfo[]
  updateCwd(id: string, cwd: string): void
  acknowledgeDataEvent(id: string, bytes: number): void
}
```

关键实现细节：
- `command === 'pi'` → 走原 `SessionPool.spawn()` 路径（spawn pi + TERM_PROGRAM=vscode）
- `command === undefined` → 走原 `IntegratedTerminalPool.create()` 路径（spawn shell + shell injection）
- 数据缓冲、背压控制保持原有 5ms 聚合策略
- `type` 字段区分终端类型，供 UI 展示不同图标

#### 1.2 提取 `SessionFileManager`

将 SessionPool 的会话文件管理职责提取到 `src/main/sessionFileManager.ts`：

```typescript
export class SessionFileManager {
  listFiles(): SessionGroup[]      // 读 ~/.pi/agent/sessions/ 目录
  reconcile(groups: SessionGroup[]): void  // 关联 live↔disk
  deleteSession(key: string): void
  deleteMany(keys: string[]): void
  clearDirectory(cwd: string): void
  debugInfo(): { count: number; pids: number[] }
}
```

疑问（待用户确认）：
- SessionFileManager 是否保留 `reconcile` 逻辑？这是把 live 进程映射到磁盘 .jsonl 的关键
- 用户说「会话 jsonl 是 pi 内部机制，不需要我管理」——那 `listFiles` 是否仍需要？

#### 1.3 合并 IPC 命名空间

`src/main/index.ts` 中：

```typescript
// === 统一终端 IPC ===
ipcMain.handle('terminal:spawn', async (_, req: SpawnRequest) => {
  try {
    const info = unifiedPool.create(req)
    pushTerminalList()
    return info
  } catch (err) { ... }
})

ipcMain.on('terminal:input', (_, m: { id: string; data: string }) => unifiedPool.write(m.id, m.data))
ipcMain.on('terminal:resize', (_, m: { id: string; cols: number; rows: number }) => unifiedPool.resize(m.id, m.cols, m.rows))
ipcMain.on('terminal:ack', (_, m: { id: string; bytes: number }) => unifiedPool.acknowledgeDataEvent(m.id, m.bytes))
ipcMain.handle('terminal:destroy', (_, id: string) => unifiedPool.destroy(id))

// 滚动缓冲区持久化（保留，用于所有终端）
const terminalBuffers = new Map<string, string>()
ipcMain.on('terminal:saveBuffer', (_, m: { id: string; data: string }) => terminalBuffers.set(m.id, m.data))
ipcMain.handle('terminal:loadBuffer', (_, id: string) => terminalBuffers.get(id))

// Shell integration 的 cwd 更新
ipcMain.on('terminal:updateCwd', (_, m: { id: string; cwd: string }) => {
  unifiedPool.updateCwd(m.id, m.cwd)
  pushTerminalList()
})

// Profile 探测（保留）
ipcMain.handle('terminal:listProfiles', () => detectTerminalProfiles())

// === 会话文件管理（独立）===
ipcMain.handle('session:list', () => sessionFileManager.listFiles())
ipcMain.handle('session:delete', (_, key: string) => { sessionFileManager.deleteSession(key); pushIndex() })
// ... 其余 file management IPC handler 保留
```

**移除的旧 IPC：**
- `session:open` / `session:terminate` → 由 `terminal:spawn` + `terminal:destroy` 替代
- `session:input` / `session:resize` / `session:ack` → 由 `terminal:input` / `terminal:resize` / `terminal:ack` 替代
- `terminal:create` / `terminal:createInAppWorkDir` → 由 `terminal:spawn` 替代

#### 1.4 合并 Preload API

`src/preload/index.ts`：

```typescript
// 统一终端 API
spawnTerminal: (req: { command?: string; cwd?: string; profile?: TerminalProfile }) => 
  ipcRenderer.invoke('terminal:spawn', req),
terminalInput: (id: string, data: string) => ipcRenderer.send('terminal:input', { id, data }),
terminalResize: (id: string, cols: number, rows: number) => ipcRenderer.send('terminal:resize', { id, cols, rows }),
onTerminalData: (cb: (id: string, data: string) => void) => { ... },
onTerminalExit: (cb: (id: string) => void) => { ... },
destroyTerminal: (id: string) => ipcRenderer.invoke('terminal:destroy', id),

// 统一 data/exit 事件
onData: onTerminalData,        // 前面兼容
onExit: onTerminalExit,

// 背压回传统一
acknowledgeDataEvent: (id: string, bytes: number) => 
  ipcRenderer.send('terminal:ack', { id, bytes }),

// 会话文件管理（保留供侧边栏）
listSessions: () => ipcRenderer.invoke('session:list'),
deleteSession: (key: string) => ipcRenderer.invoke('session:delete', key),
// ...

// Profile 探测（保留）
listTerminalProfiles: () => ipcRenderer.invoke('terminal:listProfiles'),
```

**移除的旧 API：**
- `pi.input` / `pi.resize` / `pi.onStatus` / `pi.onRelink` / `pi.openSession` / `pi.terminate`
- `pi.createTerminal` / `pi.createTerminalInAppWorkDir` / `pi.listIntegratedTerminals`
- `pi.onTerminalList` / `pi.saveTerminalBuffer` / `pi.loadTerminalBuffer` / `pi.updateTerminalCwd`

#### 1.5 合并 Channel 类

`src/renderer/src/components/terminalChannel.ts`：

```typescript
// 移除 SessionChannel + IntegratedChannel，统一为：

export class UnifiedChannel implements TerminalChannel {
  constructor(private readonly pi: PiApi, private readonly id: string) {}

  onData(cb: (data: string) => void): () => void {
    return this.pi.onTerminalData((id, data) => {
      if (id === this.id) cb(data)
    })
  }

  onExit(cb: () => void): () => void {
    return this.pi.onTerminalExit((id) => {
      if (id === this.id) cb()
    })
  }

  send(data: string): void {
    this.pi.terminalInput(this.id, data)
  }

  resize(cols: number, rows: number): void {
    this.pi.terminalResize(this.id, cols, rows)
  }
}
```

`PaneKind` 在 `paneManager.ts` 中直接移除：

```typescript
// 之前
acquirePane({ key, kind, pi })  // kind: 'session' | 'integrated'

// 之后——不再需要 kind
acquirePane(key: string, pi: PiApi): XtermTerminal
```

#### 1.6 合并 Pane 组件

`SessionPane.tsx` → 删除，由 `IntegratedPane.tsx` 替代。

`IntegratedPane.tsx` 重命名为 `TerminalPane.tsx`（或保留原名），其功能完全覆盖 SessionPane：
- keep-alive 生命周期 ✅
- ResizeObserver ✅
- 「跳到底部」浮钮 ✅
- 右键菜单 ✅
- 终端内查找面板 ✅（额外功能）
- Shell integration 回调（cwd / openFile）→ 统一保留

**`CenterPane.tsx` 调整**（第一步）：
- `SessionPane` import → 改为 `TerminalPane` / `IntegratedPane`
- 两个类型的 tab 都用同一个 TerminalPane 组件渲染

#### 1.7 测试更新

| 旧测试 | 变化 |
|---|---|
| `sessionPool.test.ts` | → 改为 `unifiedTerminalPool.test.ts` |
| `integratedTerminalPool.logic.test.ts` | → 合并入 unifiedTerminalPool 测试 |
| `integratedTerminalPool.realpty.test.ts` | → 合并入 unifiedTerminalPool 测试 |
| `integratedTerminalIpc.test.ts` | → 改为测试统一 IPC handler |
| `terminalChannel.test.ts` | → 改为测试 UnifiedChannel |
| `paneManager.test.tsx` | 移除 PaneKind 相关用例 |
| `SessionPane.test.tsx` + `.webgl.test.tsx` | → 改为 TerminalPane 测试 |
| `App.terminal.test.tsx` | 更新 handler/API 引用 |

---

### 第二步：UI 布局合并（去抽屉，统一 TabBar）

**目标**：去掉底部抽屉，所有终端在统一 TabBar 中展示。

#### 2.1 修改 TabStore

```typescript
// src/renderer/src/store/tabStore.ts

// 移除 TabLocation 中的 'panel'、'floating'
export type TabLocation = 'editor'

// IntegratedTerminalTab.location 从 'panel' 改为 'editor'
export interface TerminalTab extends BaseTab {
  kind: 'terminal'       // 重命名简化为 terminal
  location: 'editor'
  id: string             // terminal id（形如 'term-<uuid>'）
  cwd: string
}

// 合并激活 ID
export interface TabStore {
  tabs: Tab[]
  activeTabId: string | null     // 原 activeEditorTabId，重命名
  // 移除：activePanelTabId
  // 移除：drawerOpen、drawerHeight、activeTermId（抽屉相关）
  terminals: TerminalInfo[]      // 保留：供侧边栏计数
  // ...
}
```

移除的 store action：
- `toggleDrawer` / `setDrawerOpen` / `setDrawerHeight` / `setActiveTermId`
- `removeTerminal`（由 `closeTab` 统一处理）

调整的 store action：
- `openTerminal(cwd)` → 创建 `location: 'editor'` 的终端 tab
- `closeCenterTab(id)` → 所有 tab 统一：terminal/preview/session 的 keep-alive 策略自洽

#### 2.2 改版 CenterPane

```tsx
// src/renderer/src/components/CenterPane.tsx

// 之前
export function CenterPane({ onNewTerminal, onResizeDrawer, onCloseTermTab, onOpenFile }) {
  // 渲染 TabBar（仅 editor tabs）+ TerminalDrawer

// 之后——统一 layout
.center-pane
  ├── TabBar（所有 tab：session / preview / diff / terminal）
  └── .center-pane-body
        └── TerminalPane / PreviewTab / DiffTab（全部 keep-alive）
```

TabBar 的 `TabKind` 已支持 `'integrated-terminal'`（现改名为 `'terminal'`），图标需要补一个（或者用终端图标替代）。

CenterPane Props 变化：
```
// 之前
Props { onNewTerminal, onResizeDrawer, onCloseTermTab, onOpenFile }

// 之后
Props { onNewTerminal, onCloseTermTab, onOpenFile }
// 移除 onResizeDrawer
```

#### 2.3 简化 App.tsx

移除：
```typescript
// 这些全部删除
const drawerOpen = useTabStore((s) => s.drawerOpen)
useTabStore.getState().toggleDrawer()
useTabStore.getState().setDrawerHeight(h)
pi.setConfig({ terminalDrawerHeight: h })
const handleResizeDrawer = ...
const handleNewTerminalInAppWorkDir = ...
const handleNewTerminalInCwd = ...
```

调整 `handleNewTerminal`：
```typescript
const handleNewTerminal = useCallback(async (cwd?: string) => {
  try {
    if (!profilesRef.current) profilesRef.current = await pi.listTerminalProfiles()
    const profiles = profilesRef.current
    const cfg = await pi.getConfig()
    const defaultId = cfg.defaultTerminalProfile
    const profile = (defaultId && profiles.find((p) => p.id === defaultId)) || profiles[0]
    if (!profile) return
    
    const info = await pi.spawnTerminal({ 
      cwd: cwd || activeCwd || ensureAppWorkDir(),
      profile 
    })
    // 新建 terminal tab，统一 location: 'editor'
    useTabStore.getState().openTerminal({ id: info.id, cwd: info.cwd, title: info.title })
    useTabStore.getState().selectTab(info.id)
  } catch (err) { ... }
}, [activeCwd])
```

`TitleBar` 的终端按钮改为 `onNewTerminal` 而非 `toggleDrawer`：

```tsx
<TitleBar onNewTerminal={() => handleNewTerminal()} ... />
```

#### 2.4 移除的组件

| 文件 | 原因 |
|---|---|
| `src/renderer/src/components/TerminalDrawer.tsx` | 抽屉整体移除 |
| `src/renderer/src/components/TerminalTabBar.tsx` | 由主 TabBar 处理 |
| `src/renderer/src/components/SessionPane.tsx` | 由 IntegratedPane/TerminalPane 替代 |
| `src/renderer/src/__tests__/TerminalDrawer.test.tsx` | 移除 |
| `src/renderer/src/__tests__/TerminalTabBar.test.tsx` | 移除 |

#### 2.5 CSS 清理

```css
/* 移除以下样式块：
   .terminal-drawer
   .terminal-drawer-resizer / .terminal-drawer-resizer:hover
   .terminal-drawer-header
   .terminal-drawer-icon
   .terminal-drawer-body
   .integrated-terminal-slot
*/
```

`tab-content.active` 中 `display: flex` 已覆盖所有终端场景，不需要 `terminal-drawer` 相关布局。

#### 2.6 Sidebar 调整

**Props 精简**：
```
// 移除
onNewTerminalInAppWorkDir?: () => void
onNewTerminalInCwd?: (cwd: string) => void

// 调整
// 每个分组中的「新建终端」按钮改为调统一的 onNewTerminal(cwd)
```

**每个分组的行为**：
- 「新建会话」按钮 → `onOpen({ cwd })` → spawn pi 会话
- 「新建终端」按钮 → `onNewTerminal(cwd)` → spawn shell 终端
- 两者都走统一的 `terminal:spawn` IPC，只是 `command` 参数不同

**终端计数组件不变**：
```tsx
{showTermBadge && <span className="terminal-count">{termCount} Terminal</span>}
```

#### 2.7 新增 UI 细节

1. **TabBar 终端图标** — `IntegratedPane` 需要一个区别于 session 的图标（TabBar 的 `renderKindIcon` 加一个 `case 'terminal': return <IconTerminal />`）
2. **TitleBar 按钮** — 原来有个控制抽屉开关的终端按钮，改为直接调 `handleNewTerminal()`
3. **Empty state** — `center-pane-body` 的「从左侧选择一个会话」文案改为「从左侧选择一个会话，或新建终端」

---

## 影响文件汇总

### 主进程（6 个文件）

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/main/sessionPool.ts` | ❌ 删除 | PTY 管理 → 合并到 UnifiedTerminalPool；文件管理 → SessionFileManager |
| `src/main/integratedTerminalPool.ts` | ❌ 删除 | 完全被 UnifiedTerminalPool 替代 |
| `src/main/unifiedTerminalPool.ts` | ✨ 新建 | 合并两个 Pool 的核心逻辑 |
| `src/main/sessionFileManager.ts` | ✨ 新建 | 从 SessionPool 提取的 .jsonl 管理 |
| `src/main/index.ts` | 🔧 修改 | IPC handler 合并 |
| `src/main/config.ts` | 🔧 可能微调 | `terminalDrawerHeight` 可以考虑移除 |

### Preload（1 个文件）

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/preload/index.ts` | 🔧 修改 | API 合并重命名 |

### 渲染进程 - 组件（8 个文件）

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/renderer/src/components/terminalChannel.ts` | 🔧 修改 | 合并两个 Channel 类 |
| `src/renderer/src/components/paneManager.ts` | 🔧 修改 | 移除 PaneKind |
| `src/renderer/src/components/SessionPane.tsx` | ❌ 删除 | 被替代 |
| `src/renderer/src/components/IntegratedPane.tsx` | 🔧 修改→重命名 | 改为 TerminalPane.tsx |
| `src/renderer/src/components/CenterPane.tsx` | 🔧 修改 | 移除 TerminalDrawer |
| `src/renderer/src/components/TerminalDrawer.tsx` | ❌ 删除 | 抽屉移除 |
| `src/renderer/src/components/TerminalTabBar.tsx` | ❌ 删除 | 由主 TabBar 统一处理 |
| `src/renderer/src/components/TabBar.tsx` | 🔧 可能微调 | 补终端图标 |

### 渲染进程 - Store（1 个文件）

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/renderer/src/store/tabStore.ts` | 🔧 修改 | 合并 location、移除抽屉状态 |

### 渲染进程 - App（1 个文件）

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/renderer/src/App.tsx` | 🔧 修改 | 移除抽屉逻辑、调整 handler |

### 样式（1 个文件）

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/renderer/src/styles/app.css` | 🔧 修改 | 移除 `.terminal-drawer*` 样式 |

### 测试（~13 个文件）

| 文件 | 操作 |
|---|---|
| `src/main/__tests__/sessionPool.test.ts` | 🔧 改为 unifiedTerminalPool 测试 |
| `src/main/__tests__/sessionPool.realpty.test.ts` | 🔧 合并 |
| `src/main/__tests__/integratedTerminalPool.logic.test.ts` | 🔧 合并 |
| `src/main/__tests__/integratedTerminalPool.realpty.test.ts` | 🔧 合并 |
| `src/main/__tests__/integratedTerminalIpc.test.ts` | 🔧 更新 |
| `src/renderer/src/__tests__/IntegratedTerminal.test.tsx` | 🔧 更新 import |
| `src/renderer/src/__tests__/IntegratedTerminal.activation.test.tsx` | 🔧 更新 |
| `src/renderer/src/__tests__/SessionPane.test.tsx` | ❌→改为 TerminalPane 测试 |
| `src/renderer/src/__tests__/SessionPane.webgl.test.tsx` | 🔧 更新 |
| `src/renderer/src/__tests__/TerminalDrawer.test.tsx` | ❌ 移除 |
| `src/renderer/src/__tests__/TerminalTabBar.test.tsx` | ❌ 移除 |
| `src/renderer/src/__tests__/App.terminal.test.tsx` | 🔧 更新 |
| `src/renderer/src/__tests__/CenterPane.test.tsx` | 🔧 更新 |
| `src/renderer/src/__tests__/paneManager.test.tsx` | 🔧 更新 |
| `src/renderer/src/__tests__/terminalChannel.test.ts` | 🔧 更新 |
| `src/renderer/src/store/__tests__/tabStore.test.ts` | 🔧 更新 |
| `src/renderer/src/__tests__/SettingsPanel.terminal.test.tsx` | 🔧 更新 |

---

## 执行顺序建议

```
第一步（后端合并）          第二步（UI 合并）
─────                       ─────
1. UnifiedTerminalPool     7. tabStore 改造
2. SessionFileManager      8. CenterPane 改版
3. IPC handler 合并        9. App.tsx 简化
4. Preload API 合并       10. 移除 TerminalDrawer 等
5. Channel + Pane 合并    11. CSS 清理
6. 测试更新                12. Sidebar Props 调整
                          13. 测试更新
```

---

## 未解决的问题

1. **SessionFileManager** → 你说"会话 jsonl 是 pi 内部机制"，那 `listFiles` 是否保留？如果保留，是直接从 `~/.pi/agent/sessions/` 目录读取，还是通过 pi 的 RPC 方式获取？
2. **`terminalDrawerHeight`** → config 中的一个字段，UI 改造后移除
3. **Tab 关闭行为** → session tab 是 keep-alive（隐藏不卸载），集成终端是直接 destroy。统一后，terminal tab 的关闭行为应该是 destroy pty 还是隐藏？
4. **`activeEditorTabId` 重命名** → 改为 `activeTabId` 更干净，但影响现有引用
