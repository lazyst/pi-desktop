# 设计文档：xterm 右键复制/粘贴 + 侧边栏会话右键删除菜单

- 日期：2026-07-15
- 状态：已评审（待实现）

## 目标

为 pi-desktop 增加两类右键交互：

1. **终端区（xterm）**：右键支持复制与粘贴。
2. **左侧会话列表**：右键某个会话弹出上下文菜单，菜单中含「删除会话」项，确认后可删除该会话。

两个功能都遵循现有架构约束：渲染进程 `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`，所有进程 / 文件操作只在主进程，渲染进程纯做视图。

## 关键决策（已与用户确认）

- **xterm 右键行为**：自动判断。若终端内有选中文本 → 复制选区；无选区 → 从剪贴板粘贴。不引入弹出式菜单，贴近经典终端体验。
- **删除会话语义**：删除该会话的 `.jsonl` 文件，若该会话进程正在运行则先终止，并在删除前弹出确认框以防误删。
- **侧边栏菜单实现方式**：自定义 React 上下文菜单（不用 Electron 原生 `Menu`），与现有 React UI 一致、样式可控、改动小，且避免额外 `context-menu` IPC 转发。
- **菜单定位**：使用 `contextmenu` 事件的 `e.clientX / e.clientY`（鼠标点击处的视口坐标）绝对定位，并对视口边缘做夹取（clamp），保证菜单完整可见。

---

## 功能 1：xterm 右键复制 / 粘贴

**改动文件**：`src/renderer/src/components/TerminalPane.tsx`

**实现要点**：

- 在终端已 `open` 的 effect（或单独的 `useEffect`）中，给 `term.element`（xterm 渲染根节点，存在即挂在 host 上）添加原生 `contextmenu` 事件监听：
  - `e.preventDefault()` —— 屏蔽浏览器默认右键菜单；
  - 若 `term.hasSelection()` 为真 → `navigator.clipboard.writeText(term.getSelection())` 执行复制；
  - 否则 `navigator.clipboard.readText().then((text) => term.paste(text))` 执行粘贴；
  - 用 `typeof navigator.clipboard !== 'undefined'` 做存在性判断，整段包 `try/catch`（`jsdom` / 非安全上下文下静默跳过，不抛错、不崩）。
- 粘贴复用已有链路：`term.onData((d) => pi.input(sessionKey, d))` 已把按键送往 PTY，因此 `term.paste` 会自动经此链路送入 `pi`，无需新增 IPC。
- 监听需在 effect 清理函数中 `removeEventListener`，避免重复绑定。

**说明**：复制/粘贴走 `navigator.clipboard`（Electron 渲染进程在 `contextIsolation` 下可用），无需引入 `electron` 模块。

---

## 功能 2：侧边栏会话右键菜单（删除会话）

### 2a 渲染层（React）

**新增 `src/renderer/src/components/ContextMenu.tsx`**

- 通用、可复用的绝对定位小菜单组件。Props 大致为 `{ x, y, items, onClose }`，其中 `items` 为 `{ label, danger?, onClick }[]`。
- 由 `Sidebar` 用状态 `{ key, name, x, y } | null` 控制显隐。
- 定位：以传入的 `x/y`（来自 `contextmenu` 事件的 `clientX/clientY`）为锚点，超出视口时夹取：
  ```ts
  const MENU_W = 160, MENU_H = 36;
  const left = Math.min(x, window.innerWidth  - MENU_W - 8);
  const top  = Math.min(y, window.innerHeight - MENU_H - 8);
  ```
- 关闭条件：点击菜单外部、`Esc` 键、窗口 `resize`、滚动。组件用 `useEffect` 挂这些监听并在卸载时清理。

**`src/renderer/src/components/Sidebar.tsx`**

- 每个 `session-item` 增加 `onContextMenu={(e) => { e.preventDefault(); setMenu({ key: s.key, name: s.name, x: e.clientX, y: e.clientY }); }}`。
- 在列表底部渲染 `<ContextMenu>`（当 `menu` 非空），菜单项：`删除会话`（`danger: true`），点击后：关闭菜单、调用 `onDeleteSession(menu.key, menu.name)`。
- `Sidebar` Props 新增 `onDeleteSession: (key: string, name: string) => void`。

**新增 `src/renderer/src/components/ConfirmDialog.tsx`**

- 自定义 React 确认模态（非原生 `confirm()`，避免阻塞且样式统一）。沿用 `tokens.css` 配色：背景 `--bg-elevated`、危险文字 `--danger`、阴影 `--shadow-modal`、圆角 `--r-md`。
- Props：`{ title, message, confirmLabel, onConfirm, onCancel }`。
- 渲染半透明遮罩 + 居中卡片，含「取消 / 删除」按钮，「删除」按钮用危险强调色。

**`src/renderer/src/App.tsx`**

- 新增状态 `confirm: { key: string; name: string } | null`。
- 新增 `handleDeleteRequest(key, name)` → `setConfirm({ key, name })`；
- 新增 `handleDeleteConfirm()` → `await pi.deleteSession(confirm.key)` → `setConfirm(null)`；失败时 `setError(...)`。
- 把 `onDeleteSession={handleDeleteRequest}` 传给 `Sidebar`；在根节点挂载 `<ConfirmDialog>`（当 `confirm` 非空）。

### 2b IPC 契约（新增 `session:delete`）

**`src/renderer/src/ipc.ts`**

- `PiApi` 新增 `deleteSession(key: string): Promise<void>`。

**`src/preload/index.ts`**

- 新增 `deleteSession: (key: string) => ipcRenderer.invoke('session:delete', key)`。

**`src/main/index.ts`**

- 新增 `ipcMain.handle('session:delete', (_e, key: string) => { ... })`：
  - 安全校验：`path.resolve(key).startsWith(SESSIONS_DIR)` 且 `key.endsWith('.jsonl')`，否则抛错拒绝；
  - 调用 `pool.deleteSession(key)`；
  - 随后立即 `pushIndex()`（与 `fs.watch` debounce 互补，保证侧边栏即时更新）。

**`src/main/sessionPool.ts`**

- 新增方法 `deleteSession(key: string)`：
  ```ts
  deleteSession(key: string) {
    this.terminate(key);                       // 杀进程 + 触发 onExit（渲染层据此关闭终端面板）
    try { if (key.endsWith('.jsonl')) fs.rmSync(key, { force: true }); } catch { /* 忽略占用/竞态 */ }
  }
  ```
  （`terminate` 已负责删 `entries` 并调 `onStatus('dead')` / `onExit`。）

### 数据回流

- 删除后 `onExit` 把会话从 `open` 列表移除，对应 `TerminalPane` 随之消失；
- `fs.watch`（递归监听 `SESSIONS_DIR`）与显式 `pushIndex()` 推送新索引，`onIndex` 更新 `disk`，侧边栏该项即时消失。

---

## 错误处理

- `session:delete` 的 `key` 不在 `SESSIONS_DIR` 内或不以 `.jsonl` 结尾 → 拒绝删除（防越权删除任意文件）。
- 剪贴板 API 调用失败（`navigator.clipboard` 缺失或 reject）→ 静默 `console.warn`，不影响终端正常使用。
- 文件删除失败（如进程短暂占用）→ `catch` 后继续，`fs.watch` 仍会重排索引。

---

## 测试

- **单元测试**（`src/main/__tests__/sessionPool.test.ts` 或新增）：`deleteSession` 在进程运行中调用后，进程被终止（`entries` 清空）、`.jsonl` 文件被删除。可复用现有的 fake PTY / 临时目录桩。
- **组件测试**（`src/renderer/src/__tests__/Sidebar.test.tsx`）：对 `session-item` 触发 `contextmenu` → 断言出现含「删除会话」的菜单 → 点击该项 → 断言调用了 `onDeleteSession`；再验证 `ConfirmDialog` 出现且确认后调用 `deleteSession`。
- **终端复制/粘贴**：在 `TerminalPane.test.tsx` 中可用 `navigator.clipboard` stub + `term.hasSelection`/`term.paste` spy 验证分支逻辑。

---

## 改动文件清单

| 文件 | 改动 |
| --- | --- |
| `src/renderer/src/components/TerminalPane.tsx` | 右键复制/粘贴逻辑 |
| `src/renderer/src/components/Sidebar.tsx` | 右键菜单状态 + `onContextMenu` + 渲染 `ContextMenu` |
| `src/renderer/src/components/ContextMenu.tsx` | **新增**：可复用右键菜单 |
| `src/renderer/src/components/ConfirmDialog.tsx` | **新增**：确认弹窗 |
| `src/renderer/src/App.tsx` | `handleDeleteRequest` / `handleDeleteConfirm` + 挂载 `ConfirmDialog` |
| `src/renderer/src/ipc.ts` | `deleteSession` 类型 |
| `src/preload/index.ts` | `deleteSession` 桥接 |
| `src/main/index.ts` | `session:delete` handler + 安全校验 + `pushIndex` |
| `src/main/sessionPool.ts` | `deleteSession` 方法（终止 + 删文件） |
| `src/renderer/src/styles/app.css` | 菜单 / 弹窗样式（沿用 tokens） |
