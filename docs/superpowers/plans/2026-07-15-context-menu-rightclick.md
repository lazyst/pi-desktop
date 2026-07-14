# 右键交互：xterm 复制/粘贴 + 侧边栏删除会话 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 xterm 终端右键支持「有选区复制 / 无选区粘贴」，并让左侧会话列表右键弹出含「删除会话」的菜单（确认后删除文件并终止进程）。

**Architecture:** 终端复制/粘贴用 `navigator.clipboard` + xterm 选择 API，复用既有 `term.onData → pi.input` 链路；侧边栏用自定义 React 上下文菜单（按鼠标 `clientX/clientY` 定位 + 视口夹取），「删除会话」经新增 IPC `session:delete` 走主进程 `SessionPool.deleteSession`（先 `terminate` 杀进程再删 `.jsonl`，路径安全已内置）。

**Tech Stack:** Electron + React 18 + TypeScript + `@xterm/xterm`；Vitest + @testing-library/react（jsdom）；主进程 `node-pty` / `fs`。

## Global Constraints

- 渲染进程约束（来自 spec）：`sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`，**所有文件 / 进程操作只在主进程**，渲染进程纯视图；不得使用 `electron` 模块（用 `navigator.clipboard` 与 IPC）。
- 「删除会话」语义（来自 spec）：删除 `.jsonl` 文件 + 若进程在跑先终止 + 删除前弹确认框。
- 右键行为（来自 spec）：有选中文本 → 复制；无选中 → 粘贴；不引入终端内弹出菜单。
- 包管理器：用 `pnpm`（项目约定）。测试命令：`pnpm test`（= `vitest run`）。
- 测试环境：组件测试文件顶部加 `// @vitest-environment jsdom`；复用 `src/renderer/src/__tests__/setup.ts` 的 jsdom polyfill。

---

## Task 1: SessionPool.deleteSession（主进程，含路径安全）

**Files:**
- Modify: `src/main/sessionPool.ts`
- Test: `src/main/__tests__/sessionPool.test.ts`

**Interfaces:**
- Consumes: 现有 `terminate(key)`、`opts.sessionsDir`、`this.entries`。`fs` 与 `path` 已在本文件 import。
- Produces: `deleteSession(key: string): void` —— 后续 `main/index.ts` 的 `session:delete` handler 调用。

- [ ] **Step 1: 在 `sessionPool.test.ts` 末尾新增失败测试**

```ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function makePoolIn(sessionsDir: string) {
  const factory = vi.fn(() => mockPty());
  const onData = vi.fn(), onStatus = vi.fn(), onExit = vi.fn();
  const pool = new SessionPool(factory, {
    cols: 80, rows: 24, sessionsDir, onData, onStatus, onExit,
  });
  return { pool, factory, onData, onStatus, onExit };
}

describe('SessionPool.deleteSession', () => {
  it('terminates the process and removes the .jsonl file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-del-'));
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, '{}');
    const { pool, factory } = makePoolIn(dir);
    pool.openExisting(file);
    pool.deleteSession(file);
    const pty = factory.mock.results[0].value as ReturnType<typeof mockPty>;
    expect(pty.kill).toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(false);
    expect(pool.get(file)).toBeUndefined();
  });

  it('refuses to delete files outside sessionsDir (path-traversal guard)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-del-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-out-'));
    const file = path.join(outside, 'evil.jsonl');
    fs.writeFileSync(file, '{}');
    const { pool } = makePoolIn(dir);
    pool.deleteSession(file);
    expect(fs.existsSync(file)).toBe(true); // 未被删除
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/main/__tests__/sessionPool.test.ts`
Expected: FAIL —— `deleteSession is not a function`

- [ ] **Step 3: 在 `src/main/sessionPool.ts` 实现 `deleteSession`**

在 `terminate(key: string) { ... }` 方法之后新增：

```ts
  deleteSession(key: string) {
    // 先终止进程（杀 pty + 触发 onStatus('dead') / onExit，渲染层据此关闭终端面板）。
    this.terminate(key);
    // 仅删除 sessionsDir 内的 .jsonl 文件，防止越权删除任意文件。
    if (!key.endsWith('.jsonl')) return;
    const dir = path.resolve(this.opts.sessionsDir);
    const target = path.resolve(key);
    const inside = target === dir || target.startsWith(dir + path.sep);
    if (!inside) return;
    try { fs.rmSync(target, { force: true }); } catch { /* 忽略占用 / 竞态 */ }
  }
```

- [ ] **Step 4: 运行测试 + 主进程类型检查确认通过**

Run: `pnpm test src/main/__tests__/sessionPool.test.ts && pnpm exec tsc -p tsconfig.node.json --noEmit`
Expected: PASS（含两个新增用例）；类型检查无错误。

- [ ] **Step 5: 提交**

```bash
git add src/main/sessionPool.ts src/main/__tests__/sessionPool.test.ts
git commit -m "feat(main): add SessionPool.deleteSession with path-traversal guard"
```

---

## Task 2: IPC 契约 wiring（ipc.ts / preload / main）

**Files:**
- Modify: `src/renderer/src/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `SessionPool.deleteSession`（Task 1）。
- Produces: 渲染层 `pi.deleteSession(key: string): Promise<void>`，供 App 调用。

- [ ] **Step 1: 在 `src/renderer/src/ipc.ts` 的 `PiApi` 接口新增方法声明**

在 `terminate(key: string): Promise<void>;` 之后新增一行：

```ts
  deleteSession(key: string): Promise<void>;
```

- [ ] **Step 2: 在 `src/preload/index.ts` 暴露桥接**

在 `terminate: (key: string): Promise<void> => ipcRenderer.invoke('session:terminate', key),` 之后新增：

```ts
  deleteSession: (key: string): Promise<void> => ipcRenderer.invoke('session:delete', key),
```

- [ ] **Step 3: 在 `src/main/index.ts` 注册 handler**

在 `ipcMain.handle('session:terminate', (_e, key: string) => pool.terminate(key));` 之后新增（同处可引用 `pushIndex`）：

```ts
  ipcMain.handle('session:delete', (_e, key: string) => {
    pool.deleteSession(key);
    pushIndex(); // 与 fs.watch debounce 互补，保证侧边栏即时更新
  });
```

- [ ] **Step 4: 类型检查 + 全量单测确认无回归**

Run: `pnpm exec tsc -p tsconfig.node.json --noEmit && pnpm test`
Expected: 类型检查通过（`main/index.ts` 与 `preload/index.ts` 均被 `tsconfig.node.json` 覆盖）；`pnpm test` 全绿（无回归）。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/ipc.ts src/preload/index.ts src/main/index.ts
git commit -m "feat(ipc): add session:delete channel (preload + main handler)"
```

---

## Task 3: TerminalPane 右键复制 / 粘贴

**Files:**
- Modify: `src/renderer/src/components/TerminalPane.tsx`
- Test: `src/renderer/src/__tests__/TerminalPane.test.tsx`

**Interfaces:**
- Consumes: xterm `term.hasSelection()` / `term.getSelection()` / `term.paste()`；全局 `navigator.clipboard`；既有 `termRef`。
- Produces: 无（纯交互；粘贴经既有 `term.onData → pi.input` 链路）。

- [ ] **Step 1: 在 `TerminalPane.test.tsx` 新增两个失败用例**

在文件顶部 import 区已含 `Terminal` 与 `fireEvent`。在 `describe('TerminalPane', ...)` 内、现有用例之后新增：

```ts
  it('right-click with a selection copies it to the clipboard', () => {
    const api = makeApi();
    (window as any).pi = api;
    const hasSelection = vi.spyOn(Terminal.prototype, 'hasSelection').mockReturnValue(true);
    const getSelection = vi.spyOn(Terminal.prototype, 'getSelection').mockReturnValue('hello');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText, readText: vi.fn() },
    });
    const { container } = render(<TerminalPane sessionKey="k" active={true} />);
    const host = container.querySelector('.terminal-host') as HTMLElement;
    fireEvent.contextMenu(host);
    expect(writeText).toHaveBeenCalledWith('hello');
    hasSelection.mockRestore();
    getSelection.mockRestore();
  });

  it('right-click without a selection pastes from the clipboard', async () => {
    const api = makeApi();
    (window as any).pi = api;
    const hasSelection = vi.spyOn(Terminal.prototype, 'hasSelection').mockReturnValue(false);
    const paste = vi.spyOn(Terminal.prototype, 'paste').mockImplementation(() => {});
    const readText = vi.fn().mockResolvedValue('world');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(), readText },
    });
    const { container } = render(<TerminalPane sessionKey="k" active={true} />);
    const host = container.querySelector('.terminal-host') as HTMLElement;
    fireEvent.contextMenu(host);
    await vi.waitFor(() => expect(paste).toHaveBeenCalledWith('world'));
    hasSelection.mockRestore();
    paste.mockRestore();
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/renderer/src/__tests__/TerminalPane.test.tsx`
Expected: FAIL —— 两个新用例的 `writeText` / `paste` 未被调用（右键无处理）。

- [ ] **Step 3: 实现 `TerminalPane.tsx` 右键逻辑**

3a. 在 import 行把 `useState` 改为同时引入 `useCallback` 与一个类型（避免依赖 `React` 命名空间导入）：

```ts
import { useEffect, useRef, useState, useCallback, type MouseEvent } from 'react';
```

3b. 在组件函数体内、`useEffect(...)` 之前新增处理回调（引用 `termRef`，稳定无依赖）：

```ts
  const handleContextMenu = useCallback((e: MouseEvent) => {
    e.preventDefault();
    const term = termRef.current;
    if (!term) return;
    try {
      const clip = navigator.clipboard;
      if (!clip) return;
      if (term.hasSelection()) {
        clip.writeText(term.getSelection()).catch(() => {});
      } else {
        clip.readText().then((text) => { if (text) term.paste(text); }).catch(() => {});
      }
    } catch { /* 剪贴板不可用（如非安全上下文）时静默跳过 */ }
  }, []);
```

3c. 在返回的 host `<div>` 上挂 `onContextMenu`：

```tsx
      <div ref={hostRef} data-session={sessionKey} className={active ? 'terminal-host active' : 'terminal-host'} onContextMenu={handleContextMenu} />
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test src/renderer/src/__tests__/TerminalPane.test.tsx`
Expected: PASS（含两个新用例）

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/components/TerminalPane.tsx src/renderer/src/__tests__/TerminalPane.test.tsx
git commit -m "feat(terminal): right-click copies selection / pastes from clipboard"
```

---

## Task 4: ContextMenu 组件

**Files:**
- Create: `src/renderer/src/components/ContextMenu.tsx`
- Test: `src/renderer/src/__tests__/ContextMenu.test.tsx`

**Interfaces:**
- Consumes: 无（纯展示组件，定位用传入的 `x/y`）。
- Produces: `ContextMenu` —— 供 `Sidebar` 在右键会话时渲染；`items: { label, danger?, onClick }[]`、`onClose`。

- [ ] **Step 1: 写失败测试 `ContextMenu.test.tsx`**

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContextMenu } from '../components/ContextMenu';

describe('ContextMenu', () => {
  it('renders items and clicking an item invokes onClick', () => {
    const onDelete = vi.fn();
    render(
      <ContextMenu
        x={10}
        y={10}
        items={[{ label: '删除会话', danger: true, onClick: onDelete }]}
        onClose={vi.fn()}
      />,
    );
    const item = screen.getByText('删除会话');
    expect(item).toBeInTheDocument();
    fireEvent.click(item);
    expect(onDelete).toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <ContextMenu x={10} y={10} items={[{ label: '删除会话', onClick: vi.fn() }]} onClose={onClose} />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/renderer/src/__tests__/ContextMenu.test.tsx`
Expected: FAIL —— 模块不存在（`Cannot find module '../components/ContextMenu'`）

- [ ] **Step 3: 创建 `src/renderer/src/components/ContextMenu.tsx`**

```tsx
import { useEffect } from 'react';

export interface ContextMenuItem {
  label: string;
  danger?: boolean;
  onClick: () => void;
}
interface Props {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onDocClick = () => onClose();
    const onScroll = () => onClose();
    const onResize = () => onClose();
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [onClose]);

  // 按鼠标点击处（clientX/clientY）定位；超出视口时夹取以保证完整可见。
  const MENU_W = 160;
  const MENU_H = Math.max(36, items.length * 32 + 8);
  const left = Math.min(x, window.innerWidth - MENU_W - 8);
  const top = Math.min(y, window.innerHeight - MENU_H - 8);

  return (
    <div className="context-menu" style={{ left, top }} role="menu" onClick={(e) => e.stopPropagation()}>
      {items.map((it, i) => (
        <button
          key={i}
          type="button"
          role="menuitem"
          className={`context-menu-item${it.danger ? ' danger' : ''}`}
          onClick={() => { it.onClick(); onClose(); }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test src/renderer/src/__tests__/ContextMenu.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/components/ContextMenu.tsx src/renderer/src/__tests__/ContextMenu.test.tsx
git commit -m "feat(ui): add reusable ContextMenu component"
```

---

## Task 5: Sidebar 右键菜单接线

**Files:**
- Modify: `src/renderer/src/components/Sidebar.tsx`
- Test: `src/renderer/src/__tests__/Sidebar.test.tsx`

**Interfaces:**
- Consumes: `ContextMenu`（Task 4）；现有 props 不变。
- Produces: 新增 prop `onDeleteSession: (key: string, name: string) => void` —— 供 `App` 传入；右键会话项弹出含「删除会话」的菜单。

- [ ] **Step 1: 更新 `Sidebar.test.tsx` 的 helper 与新失败用例**

1a. 在 `renderSidebar` 函数内新增 `onDeleteSession = vi.fn()` 的默认值，并传入 `<Sidebar ... onDeleteSession={overrides.onDeleteSession ?? onDeleteSession} />`（同时把 `onDeleteSession` 加入返回对象）。完整替换后的 helper 顶部示意：

```tsx
function renderSidebar(overrides: any = {}) {
  const onOpen = vi.fn();
  const onTerminate = vi.fn();
  const onPickDirectory = vi.fn();
  const onTogglePin = vi.fn();
  const onDeleteSession = vi.fn();
  (window as any).pi = {
    listSessions: vi.fn(), openSession: vi.fn(), terminate: vi.fn(),
    input: vi.fn(), resize: vi.fn(), onData: vi.fn(), onStatus: vi.fn(), onExit: vi.fn(),
  };
  const utils = render(
    <Sidebar
      sessions={overrides.sessions ?? sessions}
      statusMap={overrides.statusMap ?? {}}
      activeKey={overrides.activeKey}
      pinned={overrides.pinned ?? []}
      onOpen={onOpen}
      onTerminate={onTerminate}
      onPickDirectory={onPickDirectory}
      onTogglePin={onTogglePin}
      onDeleteSession={overrides.onDeleteSession ?? onDeleteSession}
    />,
  );
  return { onOpen, onTerminate, onPickDirectory, onTogglePin, onDeleteSession, ...utils };
}
```

1b. 在 `describe('Sidebar', ...)` 内新增用例：

```tsx
  it('right-click a session opens a context menu with 删除会话', async () => {
    const { onDeleteSession } = renderSidebar({ statusMap: { k1: 'running' } });
    const item = screen.getByText('e2e-session').closest('.session-item')!;
    fireEvent.contextMenu(item);
    const menuItem = await screen.findByText('删除会话');
    expect(menuItem).toBeInTheDocument();
    fireEvent.click(menuItem);
    expect(onDeleteSession).toHaveBeenCalledWith('k1', 'e2e-session');
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/renderer/src/__tests__/Sidebar.test.tsx`
Expected: FAIL —— `onDeleteSession` 从未被调用 / 菜单未出现（Sidebar 尚未处理 contextmenu）。

- [ ] **Step 3: 实现 `Sidebar.tsx`**

3a. import 顶部新增 `ContextMenu` 与 `useState`（若未引入 `useState` 需补上；本文件已 import `useState`）：

```tsx
import { useState } from 'react';
import type { SessionStatus } from '../types';
import { IconNewSession, IconPin } from './icons';
import { ContextMenu } from './ContextMenu';
```

3b. `Props` 接口新增：

```tsx
  onDeleteSession: (key: string, name: string) => void;
```

3c. 解构与菜单状态（在 `expanded` 状态之后新增）：

```tsx
export function Sidebar({ sessions, statusMap, activeKey, pinned, onOpen, onTerminate, onPickDirectory, onTogglePin, onDeleteSession }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ key: string; name: string; x: number; y: number } | null>(null);
```

3d. 在 `session-item` 的 `<div ...>` 上新增 `onContextMenu`（与现有 `onClick` / `onKeyDown` 并列）：

```tsx
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ key: s.key, name: s.name, x: e.clientX, y: e.clientY });
                    }}
```

3e. 把组件返回值最外层 `<aside>` 包进 fragment，并在末尾渲染菜单：

```tsx
  return (
    <>
      <aside className="sidebar">
        {/* …原有内容保持不变… */}
      </aside>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[{ label: '删除会话', danger: true, onClick: () => onDeleteSession(menu.key, menu.name) }]}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
```

（`<aside> ... </aside>` 内部所有原有 JSX 原样保留，仅在外层加 `<>...</>` 与菜单。）

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test src/renderer/src/__tests__/Sidebar.test.tsx`
Expected: PASS（含新用例；旧用例无回归）

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/components/Sidebar.tsx src/renderer/src/__tests__/Sidebar.test.tsx
git commit -m "feat(sidebar): right-click session opens delete context menu"
```

---

## Task 6: ConfirmDialog + App 删除流程接线

**Files:**
- Create: `src/renderer/src/components/ConfirmDialog.tsx`
- Test: `src/renderer/src/__tests__/ConfirmDialog.test.tsx`
- Modify: `src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: `pi.deleteSession(key)`（Task 2 的 `PiApi`）。
- Produces: `ConfirmDialog` 组件；`App` 暴露 `handleDeleteRequest` / `handleDeleteConfirm`，并把 `onDeleteSession` 传给 `Sidebar`（Task 5）。

- [ ] **Step 1: 写失败测试 `ConfirmDialog.test.tsx`**

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmDialog } from '../components/ConfirmDialog';

describe('ConfirmDialog', () => {
  it('renders title/message and cancel/confirm invoke callbacks', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog title="删除会话" message="确认删除该会话？此操作不可恢复。" onConfirm={onConfirm} onCancel={onCancel} />,
    );
    expect(screen.getByText('删除会话')).toBeInTheDocument();
    expect(screen.getByText('确认删除该会话？此操作不可恢复。')).toBeInTheDocument();
    fireEvent.click(screen.getByText('取消'));
    expect(onCancel).toHaveBeenCalled();
    fireEvent.click(screen.getByText('删除'));
    expect(onConfirm).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/renderer/src/__tests__/ConfirmDialog.test.tsx`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 创建 `src/renderer/src/components/ConfirmDialog.tsx`**

```tsx
interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ title, message, confirmLabel = '删除', cancelLabel = '取消', onConfirm, onCancel }: Props) {
  return (
    <div className="modal-overlay" onClick={onCancel} role="presentation">
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="confirm-title">{title}</h2>
        <p className="confirm-message">{message}</p>
        <div className="confirm-actions">
          <button type="button" className="btn" onClick={onCancel}>{cancelLabel}</button>
          <button type="button" className="btn btn-danger" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 在 `App.tsx` 接线删除流程**

4a. import 顶部新增：

```tsx
import { Sidebar } from './components/Sidebar';
import { TerminalPane } from './components/TerminalPane';
import { ConfirmDialog } from './components/ConfirmDialog';
```

4b. 在 `App` 组件内、`pinned` 状态之后新增确认弹窗状态与处理函数（放在 `handleTerminate` 附近）：

```tsx
  const [confirm, setConfirm] = useState<{ key: string; name: string } | null>(null);

  const handleDeleteRequest = (key: string, name: string) => setConfirm({ key, name });

  const handleDeleteConfirm = async () => {
    if (!confirm) return;
    const { key } = confirm;
    setConfirm(null);
    setError(null);
    try {
      await pi.deleteSession(key);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
```

4c. 把 `onDeleteSession={handleDeleteRequest}` 传给 `<Sidebar ... />`（在现有 `onTogglePin={handleTogglePin}` 之后）：

```tsx
        onTogglePin={handleTogglePin}
        onDeleteSession={handleDeleteRequest}
```

4d. 在组件返回 JSX 的末尾（`</div>` 闭合前、`app-shell` 内）渲染确认弹窗：

```tsx
      {confirm && (
        <ConfirmDialog
          title="删除会话"
          message={`确定删除会话「${confirm.name}」？该会话文件将被删除且不可恢复，若进程正在运行也会被终止。`}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
```

（`handleTerminate` 保持不变；删除走的是 `deleteSession` 而非 `terminate`。）

- [ ] **Step 5: 运行 App 测试 + 全量单测**

Run: `pnpm test`
Expected: PASS（含 `App.test.tsx` 无回归；`ConfirmDialog` 用例通过）

- [ ] **Step 6: 提交**

```bash
git add src/renderer/src/components/ConfirmDialog.tsx src/renderer/src/__tests__/ConfirmDialog.test.tsx src/renderer/src/App.tsx
git commit -m "feat(app): wire delete-session confirm dialog to session:delete IPC"
```

---

## Task 7: 样式（context-menu / 确认弹窗），沿用 tokens

**Files:**
- Modify: `src/renderer/src/styles/app.css`

**Interfaces:**
- Consumes: `tokens.css` 变量（`--bg-elevated`、`--border`、`--danger`、`--danger-hover`、`--shadow-modal`、`--r-md`、`--sp-2`、`--sp-3`、`--fs-md`、`--fw-semibold`、`--focus-ring`）。
- Produces: `.context-menu` / `.context-menu-item` / `.context-menu-item.danger` / `.modal-overlay` / `.confirm-dialog` / `.confirm-title` / `.confirm-message` / `.confirm-actions` / `.btn-danger`。

- [ ] **Step 1: 在 `app.css` 末尾新增样式**

在文件末尾追加（保持与现有 `.session-item` / `.terminate` 风格一致）：

```css
/* 右键上下文菜单 */
.context-menu {
  position: fixed;
  z-index: 1000;
  min-width: 160px;
  padding: var(--sp-1) 0;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-modal);
  overflow: hidden;
}
.context-menu-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: var(--sp-2) var(--sp-3);
  background: transparent;
  border: none;
  color: var(--text);
  font-family: var(--font-mono);
  font-size: var(--fs-md);
  cursor: pointer;
}
.context-menu-item:hover,
.context-menu-item:focus-visible {
  background: var(--bg-hover);
  outline: none;
}
.context-menu-item.danger {
  color: var(--danger);
}
.context-menu-item.danger:hover,
.context-menu-item.danger:focus-visible {
  background: rgba(248, 81, 73, 0.12);
  color: var(--danger-hover);
}

/* 确认弹窗 */
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
}
.confirm-dialog {
  width: min(360px, calc(100vw - 32px));
  padding: var(--sp-4);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-modal);
}
.confirm-title {
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-xl);
  font-weight: var(--fw-semibold);
  color: var(--text);
}
.confirm-message {
  margin: 0 0 var(--sp-4);
  font-size: var(--fs-md);
  line-height: var(--lh-base);
  color: var(--text-muted);
}
.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
}
.btn-danger {
  color: #fff;
  background: var(--danger);
  border: 1px solid var(--danger);
}
.btn-danger:hover {
  background: var(--danger-hover);
  border-color: var(--danger-hover);
}
.btn-danger:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
```

（`.btn` 基础样式已存在，这里只补充 `.btn-danger` 变体。）

- [ ] **Step 2: 类型检查 + 全量单测（确认无回归）**

Run: `pnpm exec tsc --noEmit -p tsconfig.json && pnpm test`
Expected: 类型检查通过（渲染进程）；`pnpm test` 全绿。

- [ ] **Step 3: 提交**

```bash
git add src/renderer/src/styles/app.css
git commit -m "style: add context-menu and confirm-dialog styles using tokens"
```

---

## Task 8: 全量验证 + 手动冒烟

**Files:** 无新改动（验证阶段）。

- [ ] **Step 1: 运行全量单测 + 类型检查 + 生产构建**

Run:
```bash
pnpm test && pnpm exec tsc --noEmit -p tsconfig.json && pnpm exec tsc --noEmit -p tsconfig.node.json && pnpm build
```
Expected: 全部通过；两个类型检查均无错误；`pnpm build` 成功产出 `out/`。

- [ ] **Step 2: 手动冒烟（`pnpm dev`）**

启动 `pnpm dev`，人工验证：
1. 终端内用鼠标选中一段文本 → 右键 → 文本进入剪贴板（可粘贴到别处验证）；空选区右键 → 剪贴板内容被粘贴进终端。
2. 左侧某会话上右键 → 出现菜单「删除会话」→ 点击 → 弹出确认框 → 确认 → 侧边栏该项消失；若当时该会话正运行，「终止进程」绿点消失且进程退出。
3. 靠近窗口右下边缘右键时，菜单完整可见（夹取生效）。
4. 取消确认框 → 不删除。

- [ ] **Step 3: 可选 E2E 占位（不强制）**

如需端到端覆盖，可在 `e2e/` 用 Playwright（`pnpm test:e2e`，fake-pi）补充：右键会话项 → 点「删除会话」→ 断言侧边栏对应条目消失。此步骤非阻塞，可后续追加。
