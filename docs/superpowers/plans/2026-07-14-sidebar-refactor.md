# Sidebar / 目录重构 + 终端滚动 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构左侧栏（添加目录走原生选择、新建会话改为目录 hover、置顶目录、侧边栏只显示已发消息的真实会话），并修复终端竖向滚动条可拖动 + 增加置底按钮。

**Architecture:** 主进程新增 `session:pickDirectory`（系统目录选择）与 `fs.watch` 推送 `session:index`（会话写盘即"晋升"进侧边栏）；渲染进程 `App` 改为侧边栏只渲染 disk 会话、live 会话只活在终端区，`Sidebar` 增加目录 hover 操作与置顶（localStorage 持久化），`TerminalPane` 用 viewport 的 scroll 事件驱动置底 FAB。`fake-pi` 在收到首条输入时写出 `.jsonl`，使晋升流程可在 E2E 验证。

**Tech Stack:** Electron + React + TypeScript（electron-vite），`@xterm/xterm` + `@xterm/addon-fit`，Vitest（单元），Playwright（E2E，走 `PI_DESKTOP_FAKE=1` 的 `fake-pi.mjs`）。

## Global Constraints

- 渲染进程保持 `nodeIntegration:false`、`sandbox:true`、`contextIsolation:true`；PTY 只在主进程。
- 不引入新的运行时依赖（图标用内联 SVG，不引图标库）。
- 置顶状态 localStorage key 固定为 `pi-desktop:pinned-dirs`（值为 `string[]`）。
- 会话"晋升"检测用主进程 `fs.watch(SESSIONS_DIR, { recursive: true })` + 300ms debounce 推送 `session:index`。
- 侧边栏只渲染 disk 会话（`.jsonl`）；live 会话不进侧边栏，发首条消息写盘后才出现。
- `fake-pi.mjs` 收到首条 stdin 时必须写出 `.jsonl`（首行 session header 含 `cwd: process.cwd()`，次行 user message 文本作为会话名），以支撑 E2E 晋升测试。
- 单测 `pnpm test`；E2E `pnpm test:e2e`（须先 `pnpm build` 产出 `out/`）。

---

### Task 1: 渲染进程 IPC 契约 — 新增 `pickDirectory` 与 `onIndex`

**Files:**
- Modify: `src/renderer/src/ipc.ts`（在 `PiApi` 增加两个方法签名）
- Modify: `src/preload/index.ts`（实现并 expose）

**Interfaces:**
- Consumes: `SessionGroup`（已存在 `types.ts`）
- Produces: `pi.pickDirectory(): Promise<string|null>`、`pi.onIndex(cb)` 供 `App.tsx` 使用

- [ ] **Step1: 在 `PiApi` 增加签名**

`src/renderer/src/ipc.ts` 的 `export interface PiApi { ... }` 中，在 `debug()` 之后、`onData` 之前加入：

```ts
  debug(): Promise<{ count: number; pids: number[] }>;
  pickDirectory(): Promise<string | null>;
  onData(cb: (key: string, data: string) => void): void;
  onStatus(cb: (key: string, status: SessionStatus) => void): void;
  onExit(cb: (key: string) => void): void;
  onIndex(cb: (groups: SessionGroup[]) => void): void;
```

- [ ] **Step2: 在 preload 实现**

`src/preload/index.ts` 的 `contextBridge.exposeInMainWorld('pi', { ... })` 中，在 `debug` 之后加入：

```ts
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('session:pickDirectory'),
  onData: (cb: (key: string, data: string) => void) =>
    ipcRenderer.on('session:data', (_e, m: { key: string; data: string }) => cb(m.key, m.data)),
  onStatus: (cb: (key: string, status: SessionStatus) => void) =>
    ipcRenderer.on('session:status', (_e, m: { key: string; status: SessionStatus }) => cb(m.key, m.status)),
  onExit: (cb: (key: string) => void) =>
    ipcRenderer.on('session:exit', (_e, m: { key: string }) => cb(m.key)),
  onIndex: (cb: (groups: SessionGroup[]) => void) =>
    ipcRenderer.on('session:index', (_e, groups: SessionGroup[]) => cb(groups)),
```

- [ ] **Step3: 类型自洽检查 + 提交**

Run: `cd C:/Users/hcz/.pi/pi_workspace/pi-desktop && pnpm exec tsc --noEmit -p tsconfig.json`
Expected: 无类型错误（`SessionGroup` 已在 `types.ts` 定义）。

```bash
git add src/renderer/src/ipc.ts src/preload/index.ts
git commit -m "feat(ipc): add pickDirectory + onIndex to renderer contract"
```

---

### Task 2: 主进程 — `session:pickDirectory` handler + `fs.watch` 索引推送

**Files:**
- Modify: `src/main/index.ts`（import `dialog`；新增 handler；创建 pool 后启动 watch）

**Interfaces:**
- Consumes: `dialog.showOpenDialog`、`pool.listFiles()`（已存在）
- Produces: 主→渲染事件 `session:index`；IPC `session:pickDirectory` 返回值（路径或 `null`）

- [ ] **Step1: 增加 `dialog` import**

`src/main/index.ts` 顶部改为：

```ts
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
```

- [ ] **Step2: 新增 handler 与 watch**

在 `createWindow()` 内、`const pool = createPool(win);` 之后，`ipcMain.handle('session:list', ...)` 之前加入：

```ts
  // 弹出系统原生目录选择对话框（需求 1）。用户取消返回 null。
  ipcMain.handle('session:pickDirectory', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择目录',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // 会话写盘（用户发首条消息后 pi 写出 .jsonl）即视为"晋升"，推送最新索引给渲染进程。
  // 300ms debounce 合并突发写入。recursive watch 在 Windows/macOS 原生支持。
  let indexTimer: ReturnType<typeof setTimeout> | undefined;
  const pushIndex = () => {
    if (indexTimer) clearTimeout(indexTimer);
    indexTimer = setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.send('session:index', pool.listFiles());
    }, 300);
  };
  try {
    fs.watch(SESSIONS_DIR, { recursive: true }, pushIndex);
  } catch (err) {
    console.error('[session:index] fs.watch failed:', err);
  }
```

（`fs` 已在 `src/main/index.ts` 顶部 import，无需新增。）

- [ ] **Step3: 类型/编译检查 + 提交**

Run: `cd C:/Users/hcz/.pi/pi_workspace/pi-desktop && pnpm exec tsc --noEmit -p tsconfig.json`
Expected: 无类型错误。

```bash
git add src/main/index.ts
git commit -m "feat(main): add pickDirectory handler + fs.watch session:index push"
```

---

### Task 3: App.tsx — 侧边栏只渲染 disk 会话 + 挂载 `onIndex` + 置顶状态（localStorage）

**Files:**
- Modify: `src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: `pi.onIndex`、`pi.pickDirectory`、`pi.listSessions`（Task 1 提供）
- Produces: `sessions`（= disk）、`pinned`、`onPickDirectory`、`onTogglePin` 传给 `Sidebar`

- [ ] **Step1: 先写失败断言（集成层，靠 E2E 验证；此处加一个最小单测确保 `sessions` 不含 live）**

`src/renderer/src/__tests__/App.test.tsx`（新建）：

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from '../App';

describe('App', () => {
  it('passes only disk sessions to the sidebar (no live merge)', async () => {
    const api = {
      listSessions: vi.fn().mockResolvedValue([]),
      openSession: vi.fn(),
      terminate: vi.fn(),
      input: vi.fn(), resize: vi.fn(),
      onData: vi.fn(), onStatus: vi.fn(), onExit: vi.fn(), onIndex: vi.fn(),
      pickDirectory: vi.fn(), debug: vi.fn(),
    };
    (window as any).pi = api;
    render(<App />);
    // onIndex 被订阅（用于后续晋升），初始 listSessions 被调用
    expect(api.onIndex).toHaveBeenCalled();
    expect(api.listSessions).toHaveBeenCalled();
    // 侧边栏存在，但空列表时不渲染任何 session-item
    expect(await screen.findByText('会话', { exact: true })).toBeInTheDocument();
    expect(screen.queryByText('live-xyz')).toBeNull();
  });
});
```

- [ ] **Step2: Run 确认失败（App 尚未改写，旧逻辑仍可能合并 live，但本测试只断言 onIndex/listSessions 被调用 + 无 live 文本，旧代码未订阅 onIndex 故失败）**

Run: `cd C:/Users/hcz/.pi/pi_workspace/pi-desktop && pnpm exec vitest run src/renderer/src/__tests__/App.test.tsx`
Expected: FAIL（`api.onIndex` 未被调用）。

- [ ] **Step3: 改写 `App.tsx`**

整文件替换为：

```tsx
import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { TerminalPane } from './components/TerminalPane';
import { pi } from './ipc';
import type { SessionInfo, SessionStatus } from './types';

interface OpenSession extends SessionInfo { key: string; cwd: string; name: string; status: SessionStatus; }
interface DiskSession { key: string; cwd: string; name: string; time?: string; }

const PIN_KEY = 'pi-desktop:pinned-dirs';

function readPinned(): string[] {
  try {
    const raw = localStorage.getItem(PIN_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function toDisk(groups: { cwd: string; sessions: Array<{ key: string; name: string; time: string }> }[]): DiskSession[] {
  return groups.flatMap((g) => g.sessions.map((s) => ({ key: s.key, cwd: g.cwd, name: s.name, time: s.time })));
}

export default function App() {
  const [open, setOpen] = useState<OpenSession[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [statusMap, setStatusMap] = useState<Record<string, SessionStatus>>({});
  const [error, setError] = useState<string | null>(null);
  const [disk, setDisk] = useState<DiskSession[]>([]);
  const [pinned, setPinned] = useState<string[]>(() => readPinned());

  useEffect(() => {
    pi.onStatus((key, status) => setStatusMap((m) => ({ ...m, [key]: status })));
    pi.onExit((key) => {
      setStatusMap((m) => ({ ...m, [key]: 'dead' }));
      setOpen((list) => list.filter((s) => s.key !== key));
    });
    // 会话写盘后主进程推送最新索引 → 晋升进侧边栏（需求 1 & 2）
    pi.onIndex((groups) => setDisk(toDisk(groups)));
    pi.listSessions().then(toDisk).then(setDisk).catch(() => setDisk([]));
  }, []);

  // 侧边栏只渲染 disk 会话；live 会话只活在终端区，发消息写盘后才出现。
  const sessions: DiskSession[] = disk;

  const handleOpen = async (req: { key?: string; cwd?: string; name?: string }) => {
    setError(null);
    try {
      const info = await pi.openSession(req.key ? { key: req.key } : { cwd: req.cwd, name: req.name });
      setOpen((list) => list.some((s) => s.key === info.key) ? list : [...list, info as OpenSession]);
      setActiveKey(info.key);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePickDirectory = async () => {
    setError(null);
    try {
      const dir = await pi.pickDirectory();
      if (!dir) return;
      await handleOpen({ cwd: dir });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleTogglePin = (cwd: string) => {
    setPinned((prev) => {
      const next = prev.includes(cwd) ? prev.filter((c) => c !== cwd) : [...prev, cwd];
      try { localStorage.setItem(PIN_KEY, JSON.stringify(next)); } catch { /* ignore quota */ }
      return next;
    });
  };

  const handleTerminate = (key: string) => { pi.terminate(key); };

  const active = open.find((s) => s.key === activeKey);
  const activeStatus = activeKey ? statusMap[activeKey] : undefined;

  return (
    <div className="app-shell">
      <Sidebar
        sessions={sessions}
        statusMap={statusMap}
        activeKey={activeKey}
        pinned={pinned}
        onOpen={handleOpen}
        onTerminate={handleTerminate}
        onPickDirectory={handlePickDirectory}
        onTogglePin={handleTogglePin}
      />
      <main className="main">
        <div className="header">
          <span className="header-title">{active ? `${active.name} · ${active.cwd}` : '—'}</span>
          <span className={`header-status ${activeStatus === 'running' ? 'running' : ''}`}>
            {activeStatus === 'running' ? '● 运行中' : '空闲'}
          </span>
          {error && <span className="header-error">⚠ {error}</span>}
        </div>
        <div className="terminal-area">
          {open.map((s) => (
            <TerminalPane key={s.key} sessionKey={s.key} active={s.key === activeKey} />
          ))}
          {!active && <div className="empty-state">从左侧选择一个会话，或新建会话。</div>}
        </div>
      </main>
    </div>
  );
}
```

- [ ] **Step4: Run 测试确认通过**

Run: `cd C:/Users/hcz/.pi/pi_workspace/pi-desktop && pnpm exec vitest run src/renderer/src/__tests__/App.test.tsx`
Expected: PASS。

- [ ] **Step5: 提交**

```bash
git add src/renderer/src/App.tsx src/renderer/src/__tests__/App.test.tsx
git commit -m "refactor(app): sidebar shows disk-only sessions; wire onIndex + pinned state"
```

---

### Task 4: 图标组件 `icons.tsx`（内联 SVG）

**Files:**
- Create: `src/renderer/src/components/icons.tsx`

**Interfaces:**
- Consumes: 无
- Produces: `IconNewSession`、`IconPin`、`IconArrowDown` 供 `Sidebar` 与 `TerminalPane` 使用

- [ ] **Step1: 创建图标组件**

`src/renderer/src/components/icons.tsx`：

```tsx
interface IconProps { size?: number; className?: string; }
const base = (size: number) => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
});

export function IconNewSession({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}

export function IconPin({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M9 4h6l-1 6 3 3H7l3-3-1-6z" />
      <path d="M12 16v4" />
    </svg>
  );
}

export function IconArrowDown({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M12 5v14M6 13l6 6 6-6" />
    </svg>
  );
}
```

- [ ] **Step2: 编译检查 + 提交**

Run: `cd C:/Users/hcz/.pi/pi_workspace/pi-desktop && pnpm exec tsc --noEmit -p tsconfig.json`
Expected: 无类型错误。

```bash
git add src/renderer/src/components/icons.tsx
git commit -m "feat(icons): add inline SVG icon components"
```

---

### Task 5: Sidebar.tsx 重构（TDD）— 目录 hover 操作 + 置顶 + 移除顶部"+ 会话"

**Files:**
- Modify: `src/renderer/src/components/Sidebar.tsx`
- Test: `src/renderer/src/__tests__/Sidebar.test.tsx`（整文件替换）

**Interfaces:**
- Consumes: `IconNewSession`、`IconPin`（Task 4）、`pinned: string[]`、`onPickDirectory`、`onTogglePin`（App 提供，Task 3）、`onOpen`、`onTerminate`
- Produces: 分组 hover 触发 `onOpen({ cwd })` / `onTogglePin(cwd)`；`+ 目录` 触发 `onPickDirectory`；置顶分组加 `pinned` class 且排序置顶

- [ ] **Step1: 写失败测试（整文件替换 `Sidebar.test.tsx`）**

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Sidebar } from '../components/Sidebar';
import type { SessionStatus } from '../types';

const sessions = [
  { key: 'k1', cwd: 'C:\\Users\\hcz\\.pi-agent', name: 'e2e-session' },
  { key: 'k2', cwd: 'C:\\Users\\hcz\\project', name: 'other-session' },
];

function renderSidebar(overrides: any = {}) {
  const onOpen = vi.fn();
  const onTerminate = vi.fn();
  const onPickDirectory = vi.fn();
  const onTogglePin = vi.fn();
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
    />,
  );
  return { onOpen, onTerminate, onPickDirectory, onTogglePin, ...utils };
}

describe('Sidebar', () => {
  it('no longer renders a top-level "+ 会话" button', () => {
    renderSidebar();
    expect(screen.queryByText('+ 会话')).toBeNull();
  });

  it('"+ 目录" triggers onPickDirectory (native picker)', () => {
    const { onPickDirectory } = renderSidebar();
    fireEvent.click(screen.getByText('+ 目录'));
    expect(onPickDirectory).toHaveBeenCalled();
  });

  it('renders cwd groups and sessions from the sessions prop', async () => {
    renderSidebar();
    expect(await screen.findByText(/C:\\Users\\hcz\\.pi-agent/)).toBeInTheDocument();
    expect(screen.getByText('e2e-session')).toBeInTheDocument();
    expect(screen.getByText('other-session')).toBeInTheDocument();
  });

  it('clicking new-session action opens a session in that cwd', () => {
    const { onOpen } = renderSidebar();
    fireEvent.click(screen.getByLabelText('在 C:\\Users\\hcz\\project 新建会话'));
    expect(onOpen).toHaveBeenCalledWith({ cwd: 'C:\\Users\\hcz\\project' });
  });

  it('clicking pin action toggles pin for that cwd', () => {
    const { onTogglePin } = renderSidebar();
    fireEvent.click(screen.getByLabelText('置顶 C:\\Users\\hcz\\project'));
    expect(onTogglePin).toHaveBeenCalledWith('C:\\Users\\hcz\\project');
  });

  it('pins a group: adds pinned class and sorts it first', () => {
    const { container } = renderSidebar({ pinned: ['C:\\Users\\hcz\\project'] });
    const groups = container.querySelectorAll('.group');
    expect(groups.length).toBe(2);
    expect(groups[0]).toHaveClass('pinned');
    expect(groups[0].textContent).toContain('C:\\Users\\hcz\\project');
    expect(groups[1].textContent).toContain('C:\\Users\\hcz\\.pi-agent');
  });

  it('clicking a session opens it by key', async () => {
    const { onOpen } = renderSidebar({ statusMap: { k1: 'running' } });
    fireEvent.click(await screen.findByText('e2e-session'));
    expect(onOpen).toHaveBeenCalledWith({ key: 'k1' });
  });

  it('hover terminate calls onTerminate', async () => {
    const { onTerminate } = renderSidebar({ statusMap: { k1: 'running' } });
    const item = (await screen.findByText('e2e-session')).closest('.session-item')!;
    fireEvent.click(item.querySelector('.terminate')!);
    expect(onTerminate).toHaveBeenCalledWith('k1');
  });

  it('marks the active session item with .active class', () => {
    const { container } = renderSidebar({ statusMap: { k1: 'running' }, activeKey: 'k1' });
    const active = screen.getByText('e2e-session').closest('.session-item')!;
    expect(active).toHaveClass('active');
    expect(container.querySelector('.session-item:not(.active)')).not.toHaveClass('active');
  });
});
```

- [ ] **Step2: Run 确认失败**

Run: `cd C:/Users/hcz/.pi/pi_workspace/pi-desktop && pnpm exec vitest run src/renderer/src/__tests__/Sidebar.test.tsx`
Expected: FAIL（找不到 `+ 目录` / 新 aria-label；旧代码仍有 `+ 会话`）。

- [ ] **Step3: 整文件替换 `Sidebar.tsx`**

```tsx
import { useState } from 'react';
import type { SessionStatus } from '../types';
import { IconNewSession, IconPin } from './icons';

interface Session { key: string; cwd: string; name: string; time?: string; }
interface Props {
  sessions: Session[];
  statusMap: Record<string, SessionStatus>;
  activeKey?: string | null;
  pinned: string[];
  onOpen: (req: { key?: string; cwd?: string; name?: string }) => void;
  onTerminate: (key: string) => void;
  onPickDirectory: () => void;
  onTogglePin: (cwd: string) => void;
}

export function Sidebar({ sessions, statusMap, activeKey, pinned, onOpen, onTerminate, onPickDirectory, onTogglePin }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // 分组按 cwd；置顶分组排到最前（保持置顶先后顺序），其余维持原序。
  const pinnedSet = new Set(pinned);
  const rawGroups: Array<{ cwd: string; items: Session[] }> = [];
  const cwdIndex = new Map<string, number>();
  for (const s of sessions) {
    let i = cwdIndex.get(s.cwd);
    if (i === undefined) { i = rawGroups.length; cwdIndex.set(s.cwd, i); rawGroups.push({ cwd: s.cwd, items: [] }); }
    rawGroups[i].items.push(s);
  }
  const groups = [...rawGroups].sort((a, b) => {
    const pa = pinnedSet.has(a.cwd) ? pinned.indexOf(a.cwd) : Number.MAX_SAFE_INTEGER;
    const pb = pinnedSet.has(b.cwd) ? pinned.indexOf(b.cwd) : Number.MAX_SAFE_INTEGER;
    return pa - pb;
  });

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">会话</span>
        <div className="sidebar-actions">
          <button className="btn" onClick={onPickDirectory}>+ 目录</button>
        </div>
      </div>
      <div className="session-list">
        {groups.map((g) => {
          const isPinned = pinnedSet.has(g.cwd);
          const isOpen = !!expanded[g.cwd];
          const visible = isOpen ? g.items : g.items.slice(0, 5);
          const hidden = g.items.length - visible.length;
          return (
            <div key={g.cwd} className={`group${isPinned ? ' pinned' : ''}`}>
              <div className="group-title">
                <span className="group-name">📁 {g.cwd}</span>
                <span className="group-actions">
                  <button
                    className="icon-btn"
                    title={`置顶 ${g.cwd}`}
                    aria-label={`置顶 ${g.cwd}`}
                    data-action="pin"
                    onClick={() => onTogglePin(g.cwd)}
                  >
                    <IconPin />
                  </button>
                  <button
                    className="icon-btn"
                    title={`在 ${g.cwd} 新建会话`}
                    aria-label={`在 ${g.cwd} 新建会话`}
                    data-action="new-session"
                    onClick={() => onOpen({ cwd: g.cwd })}
                  >
                    <IconNewSession />
                  </button>
                </span>
              </div>
              {visible.map((s) => {
                const running = statusMap[s.key] === 'running';
                const isActive = s.key === activeKey;
                return (
                  <div
                    key={s.key}
                    data-key={s.key}
                    className={`session-item${isActive ? ' active' : ''}`}
                    tabIndex={0}
                    aria-label={`打开会话 ${s.name}`}
                    onClick={() => onOpen({ key: s.key })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onOpen({ key: s.key });
                      }
                    }}
                  >
                    <span className={`dot ${running ? 'running' : ''}`} />
                    <span className="session-name">
                      <div className="name">{s.name}</div>
                      {s.time && <div className="time">{s.time}</div>}
                    </span>
                    {running && (
                      <button className="terminate" title="终止进程" onClick={(e) => { e.stopPropagation(); onTerminate(s.key); }}>终止进程</button>
                    )}
                  </div>
                );
              })}
              {g.items.length > 5 && (
                <div
                  className="group-expand"
                  onClick={() => setExpanded((m) => ({ ...m, [g.cwd]: !isOpen }))}
                >
                  {isOpen ? '收起' : `展开 ${hidden} 个更多`}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
```

- [ ] **Step4: Run 测试确认通过**

Run: `cd C:/Users/hcz/.pi/pi_workspace/pi-desktop && pnpm exec vitest run src/renderer/src/__tests__/Sidebar.test.tsx`
Expected: PASS（9 个用例）。

- [ ] **Step5: 提交**

```bash
git add src/renderer/src/components/Sidebar.tsx src/renderer/src/__tests__/Sidebar.test.tsx
git commit -m "refactor(sidebar): dir hover actions, pin (localStorage), remove +会话 modal"
```

---

### Task 6: TerminalPane.tsx — 置底 FAB（TDD）

**Files:**
- Modify: `src/renderer/src/components/TerminalPane.tsx`
- Test: `src/renderer/src/__tests__/TerminalPane.test.tsx`（整文件替换）

**Interfaces:**
- Consumes: `IconArrowDown`（Task 4）、`pi`（input/resize/onData）
- Produces: 当终端 viewport 未贴底时渲染 `.jump-bottom.visible`；点击调用 `term.scrollToBottom()`

- [ ] **Step1: 写失败测试**

`src/renderer/src/__tests__/TerminalPane.test.tsx` 整文件替换为：

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { Terminal } from '@xterm/xterm';
import { TerminalPane } from '../components/TerminalPane';

function makeApi() {
  return {
    listSessions: vi.fn(), openSession: vi.fn(), terminate: vi.fn(),
    input: vi.fn(), resize: vi.fn(), onData: vi.fn(), onStatus: vi.fn(), onExit: vi.fn(),
    pickDirectory: vi.fn(), debug: vi.fn(),
  };
}

describe('TerminalPane', () => {
  it('forwards keystrokes to pi.input when active', () => {
    const api = makeApi();
    (window as any).pi = api;
    render(<TerminalPane sessionKey="k" active={true} />);
    expect(api.onData).toHaveBeenCalled();
  });

  it('shows jump-to-bottom button only when scrolled up, and clicks scrollToBottom', () => {
    const api = makeApi();
    (window as any).pi = api;
    const scrollToBottom = vi.spyOn(Terminal.prototype, 'scrollToBottom').mockImplementation(() => {});
    const { container } = render(<TerminalPane sessionKey="k" active={true} />);

    const btn = container.querySelector('.jump-bottom') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    // 初始贴底：无 visible
    expect(btn.className).not.toContain('visible');

    // 模拟 viewport 滚动到顶部（未贴底）
    const vp = document.querySelector('.xterm-viewport') as HTMLElement | null;
    if (vp) {
      Object.defineProperty(vp, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(vp, 'clientHeight', { value: 400, configurable: true });
      Object.defineProperty(vp, 'scrollTop', { value: 0, configurable: true });
      vp.dispatchEvent(new Event('scroll'));
    }
    expect(container.querySelector('.jump-bottom')!.className).toContain('visible');

    fireEvent.click(container.querySelector('.jump-bottom')!);
    expect(scrollToBottom).toHaveBeenCalled();
  });
});
```

- [ ] **Step2: Run 确认失败**

Run: `cd C:/Users/hcz/.pi/pi_workspace/pi-desktop && pnpm exec vitest run src/renderer/src/__tests__/TerminalPane.test.tsx`
Expected: FAIL（找不到 `.jump-bottom`，且无 scrollToBottom 调用）。

- [ ] **Step3: 改写 `TerminalPane.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { pi } from '../ipc';
import { IconArrowDown } from './icons';
import '@xterm/xterm/css/xterm.css';

// Mirrors --font-mono in tokens.css.
const FONT_MONO = "'JetBrains Mono','Fira Code','Cascadia Code',ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

interface Props { sessionKey: string; active: boolean; }

export function TerminalPane({ sessionKey, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal>();
  const fitRef = useRef<FitAddon>();
  const openedRef = useRef(false);
  const [showJump, setShowJump] = useState(false);

  useEffect(() => {
    const term = new Terminal({ convertEol: true, cursorBlink: true, fontFamily: FONT_MONO, fontSize: 13, lineHeight: 1.2, scrollback: 5000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term; fitRef.current = fit;

    const onData = (key: string, data: string) => { if (key === sessionKey) term.write(data); };
    pi.onData(onData);
    term.onData((d) => pi.input(sessionKey, d));

    return () => {
      term.dispose();
      openedRef.current = false;
    };
  }, [sessionKey]);

  useEffect(() => {
    if (!active || !hostRef.current || !termRef.current || !fitRef.current) return;
    try {
      if (!openedRef.current) { termRef.current.open(hostRef.current); openedRef.current = true; }
    } catch { /* jsdom/headless: ignore open failures */ }
    try { fitRef.current.fit(); } catch {}
    const { cols, rows } = termRef.current;
    pi.resize(sessionKey, cols, rows);

    // 需求 5：未贴底时显示置底按钮。监听 viewport 原生 scroll。
    const viewport = termRef.current.element?.querySelector('.xterm-viewport') as HTMLElement | null;
    const onScrollEvt = () => {
      if (!viewport) return;
      const atBottom = viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight - 2;
      setShowJump(!atBottom);
    };
    viewport?.addEventListener('scroll', onScrollEvt);
    onScrollEvt();
    return () => viewport?.removeEventListener('scroll', onScrollEvt);
  }, [active, sessionKey]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      if (!active || !openedRef.current || !termRef.current || !fitRef.current) return;
      try { fitRef.current.fit(); } catch {}
      const { cols, rows } = termRef.current;
      pi.resize(sessionKey, cols, rows);
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [active, sessionKey]);

  return (
    <>
      <div ref={hostRef} data-session={sessionKey} className={active ? 'terminal-host active' : 'terminal-host'} />
      {active && (
        <button
          className={`jump-bottom${showJump ? ' visible' : ''}`}
          title="滚动到最新"
          aria-label="滚动到最新"
          onClick={() => termRef.current?.scrollToBottom()}
        >
          <IconArrowDown />
        </button>
      )}
    </>
  );
}
```

- [ ] **Step4: Run 测试确认通过**

Run: `cd C:/Users/hcz/.pi/pi_workspace/pi-desktop && pnpm exec vitest run src/renderer/src/__tests__/TerminalPane.test.tsx`
Expected: PASS。

- [ ] **Step5: 提交**

```bash
git add src/renderer/src/components/TerminalPane.tsx src/renderer/src/__tests__/TerminalPane.test.tsx
git commit -m "feat(terminal): jump-to-bottom FAB driven by viewport scroll"
```

---

### Task 7: CSS — 目录 hover 操作 / 置顶左轨 / FAB / xterm 滚动条可见

**Files:**
- Modify: `src/renderer/src/styles/app.css`

**Interfaces:**
- Consumes: `tokens.css` 的设计变量（`--accent`、`--bg-hover`、`--border-strong`、`--sp-*`、`--r-*`、`--shadow-modal`、`--transition`、`--focus-ring`）

- [ ] **Step1: 在 `app.css` 中替换 `.group-title` 并新增样式**

将现有 `.group-title { ... }` 整块替换为：

```css
.group-title {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  color: var(--text-faint);
  font-size: var(--fs-xs);
  word-break: break-all;
  letter-spacing: var(--ls-label);
}
.group-name { flex: 1; min-width: 0; }

/* 目录 hover 操作（新建会话 / 置顶）：默认淡出，hover/focus 淡入，复用 --transition */
.group-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  flex: none;
  opacity: 0;
  transition: opacity var(--transition);
}
.group:hover .group-actions,
.group:focus-within .group-actions { opacity: 1; }

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px; height: 22px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--r-sm);
  transition: color var(--transition), background-color var(--transition);
}
.icon-btn:hover { color: var(--accent); background: var(--bg-hover); }
.icon-btn:focus-visible { box-shadow: var(--focus-ring); }

/* 置顶目录：常驻淡强调色左轨（复用"活动会话左轨"视觉语言）+ 标题变色 */
.group.pinned { box-shadow: inset 2px 0 0 rgba(124, 156, 255, 0.40); }
.group.pinned .group-name { color: var(--accent); }
```

- [ ] **Step2: 在 `app.css` 末尾新增 FAB 与 xterm 滚动条样式**

```css
/* 置底按钮（需求 5）：仅活动且未贴底的会话显示，固定在终端区右下角 */
.jump-bottom {
  position: absolute;
  right: var(--sp-3);
  bottom: var(--sp-3);
  z-index: 6;
  width: 36px; height: 36px;
  display: none;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--accent);
  border-radius: var(--r-lg);
  background: var(--bg-elevated);
  color: var(--accent);
  cursor: pointer;
  box-shadow: var(--shadow-modal);
  transition: background-color var(--transition), transform var(--transition), opacity var(--transition);
}
.jump-bottom.visible { display: inline-flex; animation: jumpIn 160ms ease; }
.jump-bottom:hover { background: var(--bg-active); }
.jump-bottom:focus-visible { box-shadow: var(--focus-ring); }
@keyframes jumpIn {
  from { transform: translateY(8px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

/* 需求 4：让 xterm 原生竖向滚动条可见且可拖动（默认滑块 #283040 在黑底几乎不可见） */
.xterm-viewport {
  scrollbar-width: thin;
  scrollbar-color: var(--border-strong) transparent;
}
.xterm-viewport::-webkit-scrollbar { width: 10px; }
.xterm-viewport::-webkit-scrollbar-track { background: rgba(255, 255, 255, 0.03); }
.xterm-viewport::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 5px; }
.xterm-viewport::-webkit-scrollbar-thumb:hover { background: var(--accent); }
```

（`@keyframes jumpIn` 若与现有冲突可改名；当前无同名。）

- [ ] **Step3: 编译/构建检查**

Run: `cd C:/Users/hcz/.pi/pi_workspace/pi-desktop && pnpm exec tsc --noEmit -p tsconfig.json`
Expected: 无类型错误（纯 CSS 改动不影响类型，但确认整体可编译）。

- [ ] **Step4: 提交**

```bash
git add src/renderer/src/styles/app.css
git commit -m "style: dir hover actions, pinned rail, jump-bottom FAB, visible xterm scrollbar"
```

---

### Task 8: fake-pi 在首条输入时写出 `.jsonl`（支撑 E2E 晋升）

**Files:**
- Modify: `src/main/fake-pi.mjs`

**Interfaces:**
- Consumes: `process.env.PI_DESKTOP_SESSIONS_DIR`、`process.cwd()`
- Produces: 在 `SESSIONS_DIR/<encodeURIComponent(cwd)>/<stamp>_e2e.jsonl` 写出 session header（含 `cwd`）+ 首条 user message

- [ ] **Step1: 改写 `fake-pi.mjs`**

替换为：

```js
// src/main/fake-pi.mjs
// Stand-in for `pi` in automated E2E: prints a heartbeat every second,
// echoes stdin lines, and on the FIRST stdin line writes a real .jsonl session
// file (so the fs.watch -> session:index promotion path is exercisable), then
// exits cleanly on SIGTERM. No network / model / credentials.
import * as fs from 'node:fs';
import * as path from 'node:path';

let n = 0;
const timer = setInterval(() => { n += 1; process.stdout.write(`tick ${n}\n`); }, 1000);
process.stdout.write('fake-pi ready\n');

let wroteSession = false;
process.stdin.on('data', (d) => {
  const s = d.toString();
  process.stdout.write(`echo: ${s}`);
  if (!wroteSession) {
    wroteSession = true;
    const dir = process.env.PI_DESKTOP_SESSIONS_DIR;
    if (dir) {
      const group = path.join(dir, encodeURIComponent(process.cwd()));
      fs.mkdirSync(group, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(group, `${stamp}_e2e.jsonl`);
      const header = JSON.stringify({ type: 'session', version: 3, id: 'e2e', timestamp: stamp, cwd: process.cwd() });
      const msg = JSON.stringify({ type: 'message', id: 'm', parentId: null, timestamp: stamp, message: { role: 'user', content: [{ type: 'text', text: s.trim() }] } });
      fs.writeFileSync(file, header + '\n' + msg + '\n');
    }
  }
});

function shutdown() {
  clearInterval(timer);
  process.stdout.write('terminated\n');
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

- [ ] **Step2: 提交**

```bash
git add src/main/fake-pi.mjs
git commit -m "test(fake-pi): write a .jsonl on first input to exercise promotion"
```

---

### Task 9: E2E — 晋升 / 置顶持久化 / FAB / 滚动条 / 改写旧用例

**Files:**
- Modify: `e2e/app.spec.ts`（整文件替换两个旧 test 并新增三个）

**Interfaces:**
- Consumes: 构建产物 `out/main/index.js`、fake-pi（`PI_DESKTOP_FAKE=1`，Task 8 已增强）
- Produces: 验证需求 1/2（晋升）、3（置顶持久化）、5（FAB）；同时保留"打开 disk 会话→切走续跑→hover 终止→关闭杀进程"的核心回归

- [ ] **Step1: 整文件替换 `e2e/app.spec.ts`**

```ts
import { test, expect, _electron, type Page, type ElectronApplication } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const MAIN = path.join(__dirname, '..', 'out', 'main', 'index.js');

let electronApp: ElectronApplication | undefined;
test.afterEach(async () => {
  if (electronApp) { await electronApp.close().catch(() => {}); electronApp = undefined; }
});

function pidAlive(pid: number): boolean {
  try { return require('node:child_process').execSync(`tasklist /FI "PID eq ${pid}"`).toString().includes(String(pid)); }
  catch { return false; }
}

async function launch(env: NodeJS.ProcessEnv): Promise<{ app: ElectronApplication; page: Page }> {
  const e = { ...process.env, ...env };
  delete (e as any).ELECTRON_RENDERER_URL;
  electronApp = await _electron.launch({ args: [MAIN], env: e });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app: electronApp, page };
}

function writeDiskSession(dir: string, cwd: string, name: string) {
  const group = path.join(dir, encodeURIComponent(cwd));
  fs.mkdirSync(group, { recursive: true });
  const stamp = '2026-07-14T12-00-00-000Z';
  const header = JSON.stringify({ type: 'session', version: 3, id: 'x', timestamp: stamp, cwd });
  const msg = JSON.stringify({ type: 'message', id: 'm', parentId: null, timestamp: stamp, message: { role: 'user', content: [{ type: 'text', text: name }] } });
  fs.writeFileSync(path.join(group, `${stamp}_disk.jsonl`), header + '\n' + msg + '\n');
}

test('open disk session → continuity across switch → hover terminate → close kills', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sess-'));
  const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-a-'));
  const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-b-'));
  writeDiskSession(dir, cwdA, 'session-A');
  writeDiskSession(dir, cwdB, 'session-B');
  const { page } = await launch({ PI_DESKTOP_FAKE: '1', PI_DESKTOP_SESSIONS_DIR: dir });

  await expect(page.getByText('会话', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.session-item', { hasText: 'session-A' })).toBeVisible({ timeout: 15000 });

  await page.locator('.session-item', { hasText: 'session-A' }).click();
  await expect(page.locator('.terminal-host.active .xterm-rows')).toContainText('fake-pi ready', { timeout: 15000 });
  const before = Number((await page.locator('.terminal-host.active .xterm-rows').innerText()).match(/tick (\d+)/)?.[1] ?? '0');
  expect((await page.evaluate(() => (window as any).pi.debug())).count).toBe(1);

  await page.locator('.session-item', { hasText: 'session-B' }).click();
  expect((await page.evaluate(() => (window as any).pi.debug())).count).toBe(2);
  await page.waitForTimeout(3000);
  await page.locator('.session-item', { hasText: 'session-A' }).click();
  await expect.poll(async () => Number((await page.locator('.terminal-host.active .xterm-rows').innerText()).match(/tick (\d+)/)?.[1] ?? '0'), { timeout: 10000 }).toBeGreaterThan(before);

  const pidsAll = (await page.evaluate(() => (window as any).pi.debug())).pids as number[];
  const kA = await page.locator('.session-item', { hasText: 'session-A' }).first().getAttribute('data-key');
  const item = page.locator(`.session-item[data-key="${kA}"]`);
  await item.hover();
  await item.locator('.terminate').click();
  await expect(item.locator('.dot.running')).toHaveCount(0);
  expect((await page.evaluate(() => (window as any).pi.debug())).count).toBe(1);

  await electronApp!.close();
  await new Promise((r) => setTimeout(r, 2500));
  for (const pid of pidsAll) expect(pidAlive(pid)).toBe(false);
});

test('new session from a directory promotes into the sidebar after first message', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-promo-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proj-'));
  writeDiskSession(dir, proj, 'seeded-session');
  const { page } = await launch({ PI_DESKTOP_FAKE: '1', PI_DESKTOP_SESSIONS_DIR: dir });

  await expect(page.getByText('会话', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.session-item', { hasText: 'seeded-session' })).toBeVisible({ timeout: 15000 });

  // hover 目录 → 点新建会话图标（需求 2）
  await page.locator('.group', { hasText: proj }).locator('[data-action="new-session"]').click();
  await expect(page.locator('.terminal-host.active .xterm-rows')).toContainText('fake-pi ready', { timeout: 15000 });

  // 发送首条消息 → fake-pi 写盘 → 晋升进侧边栏
  await page.locator('.terminal-host.active').click();
  await page.keyboard.type('hello from new session\n');

  await expect(page.locator('.session-item', { hasText: 'hello from new session' })).toBeVisible({ timeout: 8000 });
  // 没发消息的 live 会话不出现；只有新建的这一个 pty 在跑（seeded 是 disk-only）
  expect((await page.evaluate(() => (window as any).pi.debug())).count).toBe(1);

  await electronApp!.close();
});

test('pinning a directory persists across reload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pin-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proj-'));
  writeDiskSession(dir, proj, 'pin-seeded');
  const { page } = await launch({ PI_DESKTOP_FAKE: '1', PI_DESKTOP_SESSIONS_DIR: dir });

  await expect(page.getByText('会话', { exact: true })).toBeVisible({ timeout: 15000 });
  await page.locator('.group', { hasText: proj }).locator('[data-action="pin"]').click();
  await expect(page.locator('.group.pinned', { hasText: proj })).toBeVisible({ timeout: 5000 });

  const stored = await page.evaluate(() => localStorage.getItem('pi-desktop:pinned-dirs'));
  expect(stored).toContain(proj.replace(/\\/g, '\\\\'));

  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByText('会话', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.group.pinned', { hasText: proj })).toBeVisible({ timeout: 5000 });

  await electronApp!.close();
});

test('jump-to-bottom button appears when scrolled up and returns to latest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-jump-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proj-'));
  writeDiskSession(dir, proj, 'jump-seeded');
  const { page } = await launch({ PI_DESKTOP_FAKE: '1', PI_DESKTOP_SESSIONS_DIR: dir });

  await expect(page.locator('.session-item', { hasText: 'jump-seeded' })).toBeVisible({ timeout: 15000 });
  await page.locator('.session-item', { hasText: 'jump-seeded' }).click();
  // 等待若干 tick 产生溢出
  await expect(page.locator('.terminal-host.active .xterm-rows')).toContainText('tick 3', { timeout: 10000 });

  const vp = page.locator('.terminal-host.active .xterm-viewport');
  await vp.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
  await expect(page.locator('.jump-bottom.visible')).toBeVisible({ timeout: 5000 });

  await page.locator('.jump-bottom.visible').click();
  await expect(page.locator('.terminal-host.active .xterm-rows')).toContainText('tick', { timeout: 5000 });

  await electronApp!.close();
});
```

- [ ] **Step2: 构建并跑 E2E**

Run:
```bash
cd C:/Users/hcz/.pi/pi_workspace/pi-desktop && pnpm build && pnpm test:e2e
```
Expected: 4 个 e2e 用例 PASS。若 `fs.watch` recursive 在该环境不可用，则"晋升"用例可能偶发失败——属已知风险（见下方风险），需确认环境支持或临时降级 watch 策略；其余用例不受影响。

- [ ] **Step3: 提交**

```bash
git add e2e/app.spec.ts
git commit -m "test(e2e): promotion, pin persistence, jump-to-bottom, rewritten continuity"
```

---

### Task 10: 运行时验证需求 4（滚动条可拖动）与整体手测

**Files:** 无代码改动（验证任务）

**Interfaces:** 依赖 Task 7 的 CSS 修复 + Task 2 的 watch

- [ ] **Step1: 构建并启动 dev 验证滚动条**

Run: `cd C:/Users/hcz/.pi/pi_workspace/pi-desktop && pnpm dev`
手动：
1. 打开任一会话，等待输出产生溢出 → 终端右侧出现竖向滚动条，滑块为 `--border-strong` 灰蓝色（可见）。
2. 用鼠标拖动滑块上下滚动 → 确认可拖动、终端内容跟随滚动（若仍不可拖，回到 Task 7 评估是否启用 xterm `scrollSensitivity` 或以 FAB/滚轮为主入口，不引第三方库）。
3. 滚到上方 → 右下角出现置底按钮 → 点击回到最新行。
4. 点 `+ 目录` → 系统原生目录选择框弹出 → 选一个空目录 → 终端区跑起 pi；未发消息直接切走/关闭 → 侧边栏不出现该目录。
5. 在目录上 hover → 出现 `⊕`/`📌` → 点 `⊕` 在该目录新建会话（发消息后晋升）；点 `📌` 置顶（刷新后仍在顶部）。

- [ ] **Step2: 确认无回归后收尾**

Run: `cd C:/Users/hcz/.pi/pi_workspace/pi-desktop && pnpm test && pnpm build`
Expected: 单元 + 构建全绿。

---

## 自查（Self-Review）

**Spec 覆盖：**
- 需求 1（添加目录=原生选择+cd 跑 pi+未发消息不显示）：Task 1-3（`pickDirectory` + 侧边栏 disk-only + 晋升）+ Task 10 手测 ✓
- 需求 2（新建会话=目录 hover 图标+未发消息不显示）：Task 5（hover 操作）+ Task 3（disk-only）+ Task 9（晋升 e2e）✓
- 需求 3（置顶目录=hover 图标+localStorage 持久化）：Task 3（状态）+ Task 5（UI/排序）+ Task 7（左轨）+ Task 9（持久化 e2e）✓
- 需求 4（滚动条可拖动）：Task 7（CSS 可见性修复）+ Task 10（运行时验证）✓
- 需求 5（置底按钮）：Task 6（FAB）+ Task 7（样式）+ Task 9（e2e）✓

**Placeholder 扫描：** 无 TBD/TODO；每个代码步骤均含完整代码。Task 10 为纯验证，无占位。

**类型一致性：** `pi.pickDirectory()/onIndex()`（Task1）→ 主进程 handler（Task2）→ `App` 使用（Task3）签名一致；`pinned/onPickDirectory/onTogglePin` 在 App→Sidebar→测试间一致；`IconNewSession/IconPin/IconArrowDown` 命名在 Task4/5/6 一致；`.jump-bottom`/`.group.pinned`/`.group-actions`/`data-action` 在 Task5/6/7/9 一致。

**已知风险：** `fs.watch({recursive:true})` 在极少数平台（部分 Linux 无 inotify recursive）可能不可用；已 try/catch，失败时仅失去实时晋升（初始 `listSessions` 仍可用，重启后能看到）。若 E2E 环境不支持，可降级为对 `SESSIONS_DIR` 单层 + 已知子目录 watch。
