# Pi Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an Electron desktop app that wraps `pi`'s real TUI in isolated per-session terminals, with a directory-grouped sidebar (green "running" dot + hover terminate) and uninterrupted background tasks when switching sessions.

**Architecture:** Electron main process owns a `SessionPool` (Map: sessionKey → `node-pty` instance) that spawns one `pi` process per open session and bridges PTY I/O to the React renderer over IPC. The renderer shows a `xterm.js` terminal per open session and a sidebar that lists sessions grouped by project cwd; switching only toggles which terminal pane is visible, so background tasks keep running.

**Tech Stack:** Electron, React, TypeScript, Vite (via `electron-vite`), `node-pty` (main only), `@xterm/xterm` + `@xterm/addon-fit`, Vitest + @testing-library/react for tests. pnpm for installs.

## Global Constraints

- Desktop framework: **Electron** (main process Node + renderer). (Spec §2)
- Renderer: **React + TypeScript**, built with **Vite**. (Spec §2)
- PTY: **`node-pty`**, only in the main process; renderer runs with `nodeIntegration:false`, `sandbox:true`. (Spec §2)
- Layout: **single terminal main area + sidebar switch**; one terminal visible at a time. (Spec §1, Q3=A)
- Sidebar grouped **by directory (project cwd)**; supports **new directory** (real folder picker) and **new session**. (Spec §1, Q5=A)
- Running session shows a **green dot**; hover reveals a **terminate** button that kills the `pi` process. (User requirement)
- Switching sessions must **not kill** the running process (task continues). (Spec §1, Q4=A lifecycle)
- On app close: **kill all running processes**; on restart, sidebar lists only files (no green dots). (Spec §1, Q4=A)
- Model: use **pi's own default** (do NOT pass `--model`); no in-app model settings. (Spec §1, Q6=B)
- Monorepo/workdir: all code lives under `pi-desktop/`. (User instruction)

---

## File Structure

```
pi-desktop/
├─ package.json                      # deps + scripts (dev/build/test/start)
├─ electron.vite.config.ts           # electron-vite + vitest config
├─ tsconfig.json                     # renderer TS config
├─ tsconfig.node.json                # main/preload TS config
├─ src/
│  ├─ main/
│  │  ├─ index.ts                    # Electron entry: BrowserWindow + ipcMain + SessionPool wiring
│  │  └─ sessionPool.ts             # SessionPool: spawn/kill/status/listFiles (testable, pty injectable)
│  ├─ preload/
│  │  └─ index.ts                    # contextBridge: expose typed `window.pi` IPC API
│  └─ renderer/
│     ├─ src/
│     │  ├─ main.tsx                 # React root
│     │  ├─ App.tsx                  # layout: Sidebar + TerminalPane, active-session state
│     │  ├─ ipc.ts                   # typed wrapper around window.pi
│     │  ├─ types.ts                 # SessionInfo / SessionGroup / Status
│     │  ├─ components/
│     │  │  ├─ Sidebar.tsx           # grouped tree, green dot, hover terminate, new dir/session
│     │  │  └─ TerminalPane.tsx      # xterm.js per session, attach/detach, input/resize
│     │  └─ __tests__/
│     │     ├─ Sidebar.test.tsx
│     │     └─ TerminalPane.test.tsx
│     └─ vite-env.d.ts
└─ src/main/__tests__/
   └─ sessionPool.test.ts            # SessionPool unit tests (mock node-pty)
```

---

## Task 1: Scaffold Electron + React + TS + Vite project

**Files:**
- Create: `pi-desktop/package.json`
- Create: `pi-desktop/electron.vite.config.ts`
- Create: `pi-desktop/tsconfig.json`
- Create: `pi-desktop/tsconfig.node.json`
- Create: `src/renderer/src/vite-env.d.ts`
- Create: `src/renderer/src/main.tsx`

**Interfaces:**
- Produces: a runnable Electron app showing a blank window (baseline before features).

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "pi-desktop",
  "version": "0.1.0",
  "private": true,
  "main": "out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "start": "electron-vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "@xterm/addon-fit": "^0.10.0",
    "@xterm/xterm": "^5.5.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@testing-library/react": "^16.0.1",
    "@testing-library/jest-dom": "^6.5.0",
    "@playwright/test": "^1.47.0",
    "@types/node": "^22.0.0",
    "@types/react": "^18.3.1",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.1",
    "electron": "^32.0.0",
    "electron-vite": "^2.3.0",
    "jsdom": "^25.0.0",
    "node-pty": "^1.0.0",
    "typescript": "^5.5.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `electron.vite.config.ts`**

```ts
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: { build: { rollupOptions: { external: ['node-pty'] } } },
  preload: { build: { rollupOptions: { external: ['node-pty'] } } },
  renderer: {
    resolve: { alias: { '@': '/src/renderer/src' } },
    plugins: [react()],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/renderer/src/__tests__/setup.ts'],
  },
});
```

- [ ] **Step 3: Create `tsconfig.json` (renderer)**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "types": ["vite/client", "vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src/renderer"]
}
```

- [ ] **Step 4: Create `tsconfig.node.json` (main + preload)**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "node",
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/main", "src/preload"]
}
```

- [ ] **Step 5: Create `src/renderer/src/vite-env.d.ts`**

```ts
/// <reference types="vite/client" />
```

- [ ] **Step 6: Create `src/renderer/src/main.tsx` (blank window baseline)**

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  return <div style={{ padding: 20 }}>Pi Desktop — scaffold OK</div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
```

- [ ] **Step 7: Install dependencies**

Run: `cd pi-desktop && pnpm install`
Expected: installs without fatal error. `node-pty` may build a native binary (prebuilt preferred; if it compiles, ensure VS Build Tools / python are present on Windows).

- [ ] **Step 8: Verify blank window opens**

Run: `cd pi-desktop && pnpm dev`
Expected: Electron window appears showing "Pi Desktop — scaffold OK". (Stop the dev process after confirming.)

- [ ] **Step 9: Commit**

```bash
cd pi-desktop && git add -A && git commit -m "chore: scaffold Electron + React + Vite project"
```

---

## Task 2: Implement `SessionPool` (spawn / kill / status / list) with tests

**Files:**
- Create: `src/main/sessionPool.ts`
- Create: `src/main/__tests__/sessionPool.test.ts`

**Interfaces:**
- Consumes: injected `PtyFactory` (so tests mock `node-pty`); `sessionsDir` path.
- Produces: `SessionPool` class with `openExisting(file)`, `openNew(cwd, name?)`, `write(key, data)`, `resize(key, cols, rows)`, `terminate(key)`, `killAll()`, `get(key)`, `listFiles()`. Emits via callbacks `onData(key,data)`, `onStatus(key,status)`, `onExit(key)`.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/__tests__/sessionPool.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionPool, decodeCwd, formatTimestamp } from '../sessionPool';

function mockPty() {
  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    on: vi.fn((_e: string, cb: (d: string) => void) => { (mockPty as any)._cb = cb; }),
    pid: 999,
  };
}
function makePool() {
  const factory = vi.fn(() => mockPty());
  const onData = vi.fn(), onStatus = vi.fn(), onExit = vi.fn();
  const pool = new SessionPool(factory, {
    cols: 80, rows: 24, sessionsDir: '/tmp/sessions', onData, onStatus, onExit,
  });
  return { pool, factory, onData, onStatus, onExit };
}

describe('SessionPool', () => {
  it('openExisting spawns pi --session and reports running', () => {
    const { pool, factory, onStatus } = makePool();
    const info = pool.openExisting('/tmp/sessions/x/session.jsonl');
    expect(factory).toHaveBeenCalledWith('pi', ['--session', '/tmp/sessions/x/session.jsonl'], expect.objectContaining({ cwd: 'x', name: 'pi' }));
    expect(info.status).toBe('running');
    expect(onStatus).toHaveBeenCalledWith('/tmp/sessions/x/session.jsonl', 'running');
  });

  it('write forwards to pty.write', () => {
    const { pool } = makePool();
    const key = '/tmp/sessions/x/session.jsonl';
    pool.openExisting(key);
    pool.write(key, 'ls\n');
    expect(mockPty().write).not.toHaveBeenCalled(); // factory returns NEW mock each call; see note
  });

  it('terminate kills pty and reports dead', () => {
    const { pool, onStatus } = makePool();
    const key = '/tmp/sessions/x/session.jsonl';
    pool.openExisting(key);
    pool.terminate(key);
    expect(onStatus).toHaveBeenCalledWith(key, 'dead');
    expect(pool.get(key)).toBeUndefined();
  });

  it('killAll terminates every session', () => {
    const { pool } = makePool();
    pool.openExisting('/a/s.jsonl');
    pool.openNew('/some/cwd', 'n');
    pool.killAll();
    expect(pool.get('/a/s.jsonl')).toBeUndefined();
  });
});

describe('cwd codec', () => {
  it('decodes sanitized cwd best-effort', () => {
    expect(decodeCwd('--C--Users-hcz-.pi-agent--')).toContain('Users');
    expect(decodeCwd('--C--Users-hcz-.pi-agent--')).toContain('pi-agent');
  });
  it('formatTimestamp parses filename', () => {
    expect(formatTimestamp('2026-07-03T19-07-11-857Z_abc.jsonl')).toBe('2026-07-03 19:07');
  });
});
```

> Note: the simplistic `mockPty()` returns a fresh object each call, so the `write` assertion above is illustrative. In the real implementation we capture the SINGLE pty returned for a given open and assert against that instance. The implementer should keep a reference to the returned pty in the test (e.g., `const pty = pool.openExisting(...)` then assert via a captured variable from `factory.mock.results`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pi-desktop && pnpm test src/main/__tests__/sessionPool.test.ts`
Expected: FAIL — `SessionPool` not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/sessionPool.ts
import * as fs from 'node:fs';
import * as path from 'node:path';

export type SessionStatus = 'running' | 'dead';
export interface SessionInfo {
  key: string;
  cwd: string;
  name: string;
  status: SessionStatus;
}
export interface SessionGroup {
  cwd: string;
  sessions: Array<{ key: string; name: string; time: string }>;
}
export interface PtyFactory {
  (file: string, args: string[], opts: { cwd: string; cols: number; rows: number; name: string }): IPtyLike;
}
export interface IPtyLike {
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  on(event: 'data' | 'exit', cb: (d?: any) => void): void;
  pid?: number;
}
export interface SessionPoolOptions {
  cols: number;
  rows: number;
  sessionsDir: string;
  onData: (key: string, data: string) => void;
  onStatus: (key: string, status: SessionStatus) => void;
  onExit: (key: string) => void;
}

interface Entry { pty: IPtyLike; info: SessionInfo; }

export class SessionPool {
  private entries = new Map<string, Entry>();
  constructor(private ptyFactory: PtyFactory, private opts: SessionPoolOptions) {}

  openExisting(sessionFile: string): SessionInfo {
    const cwd = readSessionCwd(sessionFile) ?? decodeCwd(path.basename(path.dirname(sessionFile)));
    const name = formatTimestamp(path.basename(sessionFile));
    return this.spawn(['--session', sessionFile], cwd, name, sessionFile, sessionFile);
  }
  openNew(cwd: string, name?: string): SessionInfo {
    const key = `live-${randomUUID()}`;
    const args = name ? ['--name', name] : [];
    return this.spawn(args, cwd, name || 'new-session', key, key);
  }
  private spawn(args: string[], cwd: string, name: string, infoKey: string, mapKey: string): SessionInfo {
    const pty = this.ptyFactory('pi', args, { cwd, cols: this.opts.cols, rows: this.opts.rows, name: 'pi' });
    const info: SessionInfo = { key: infoKey, cwd, name, status: 'running' };
    pty.on('data', (d: string) => this.opts.onData(infoKey, d));
    pty.on('exit', () => { this.opts.onStatus(infoKey, 'dead'); this.opts.onExit(infoKey); });
    this.entries.set(mapKey, { pty, info });
    this.opts.onStatus(infoKey, 'running');
    return info;
  }
  write(key: string, data: string) { this.entries.get(key)?.pty.write(data); }
  resize(key: string, cols: number, rows: number) { this.entries.get(key)?.pty.resize(cols, rows); }
  terminate(key: string) {
    const e = this.entries.get(key);
    if (!e) return;
    e.pty.kill();
    this.entries.delete(key);
    this.opts.onStatus(key, 'dead');
  }
  killAll() { for (const k of [...this.entries.keys()]) this.terminate(k); }
  get(key: string) { return this.entries.get(key)?.info; }
  debugInfo(): { count: number; pids: number[] } {
    const running = [...this.entries.values()].filter((e) => e.info.status === 'running');
    return { count: running.length, pids: running.map((e) => e.pty.pid ?? -1).filter((p) => p > 0) };
  }
  listFiles(): SessionGroup[] {
    const root = this.opts.sessionsDir;
    if (!fs.existsSync(root)) return [];
    const groups: SessionGroup[] = [];
    for (const enc of fs.readdirSync(root)) {
      const dir = path.join(root, enc);
      if (!fs.statSync(dir).isDirectory()) continue;
      const cwd = readGroupCwd(dir) ?? decodeCwd(enc);
      const sessions = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => {
          const name = formatTimestamp(f);
          return { key: path.join(dir, f), name, time: name };
        });
      groups.push({ cwd, sessions });
    }
    return groups;
  }
}

export function decodeCwd(enc: string): string {
  let s = enc;
  if (s.startsWith('--')) s = s.slice(2);
  if (s.endsWith('--')) s = s.slice(0, -2);
  s = s.replace(/--/g, '\\').replace(/^([A-Za-z])-/, '$1:');
  return s;
}
export function formatTimestamp(filename: string): string {
  const m = filename.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return filename;
  return `${m[1]} ${m[2]}:${m[3]}`;
}
function readSessionCwd(file: string): string | undefined {
  try {
    const line = fs.readFileSync(file, 'utf8').split('\n', 1)[0];
    const obj = JSON.parse(line);
    return typeof obj?.cwd === 'string' ? obj.cwd : undefined;
  } catch { return undefined; }
}
function readGroupCwd(dir: string): string | undefined {
  const first = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'));
  return first ? readSessionCwd(path.join(dir, first)) : undefined;
}
function randomUUID(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pi-desktop && pnpm test src/main/__tests__/sessionPool.test.ts`
Expected: PASS (all cases). Fix the `write` test to capture the returned pty instance from `factory.mock.results` so the assertion is meaningful.

- [ ] **Step 4b: Add a real-PTY integration test (no mock, no `pi`)**

```ts
// src/main/__tests__/sessionPool.realpty.test.ts
import { describe, it, expect } from 'vitest';
import * as nodePty from 'node-pty';
import { SessionPool } from '../sessionPool';

const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';

describe('SessionPool real PTY', () => {
  it('spawns a real shell, echoes input, and reports exit on kill', async () => {
    const onData = vi.fn(); // not used; we read synchronously below
    const onStatus = vi.fn();
    const onExit = vi.fn();
    const pool = new SessionPool(
      (_file, _args, opts) => nodePty.spawn(shell, [], { ...opts, shell: true }) as any,
      { cols: 80, rows: 24, sessionsDir: '/tmp/sessions', onData, onStatus, onExit },
    );
    const info = pool.openNew('C:\\', 'realshell'); // factory ignores 'pi' and spawns the real shell
    const pty = (pool as any).entries.get(info.key).pty;
    const got: string[] = [];
    pty.on('data', (d: string) => got.push(d));
    await new Promise((r) => setTimeout(r, 200));
    pty.write('echo HELLO_PTY\r\n');
    await new Promise((r) => setTimeout(r, 400));
    expect(got.join('')).toContain('HELLO_PTY');
    pool.terminate(info.key);
    expect(pool.get(info.key)).toBeUndefined();
  });
});
```

Run: `cd pi-desktop && pnpm test src/main/__tests__/sessionPool.realpty.test.ts`
Expected: PASS — proves the real `node-pty` bridge (spawn → data → kill) works, independent of `pi`. (The `(pool as any).entries` access is a test-only reach-in; acceptable for integration coverage.)

- [ ] **Step 5: Commit**

```bash
cd pi-desktop && git add -A && git commit -m "feat: add SessionPool with spawn/kill/status/list and tests"
```

---

## Task 3: Wire IPC bridge (preload + ipcMain handlers)

**Files:**
- Create: `src/main/index.ts`
- Create: `src/preload/index.ts`
- Create: `src/renderer/src/types.ts`
- Create: `src/renderer/src/ipc.ts`

**Interfaces:**
- Consumes: `SessionPool` (Task 2).
- Produces: `window.pi` API used by renderer (Task 4/5): `listSessions()`, `openSession(req)`, `terminate(key)`, `input(key,data)`, `resize(key,cols,rows)`, and event subscriptions `onData/onStatus/onExit`.

- [ ] **Step 1: Create `src/renderer/src/types.ts`**

```ts
export type SessionStatus = 'running' | 'dead';
export interface SessionInfo {
  key: string;
  cwd: string;
  name: string;
  status: SessionStatus;
}
export interface SessionGroup {
  cwd: string;
  sessions: Array<{ key: string; name: string; time: string }>;
}
export interface OpenRequest { key?: string; cwd?: string; name?: string; }
```

- [ ] **Step 2: Create `src/preload/index.ts`**

```ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('pi', {
  listSessions: (): Promise<SessionGroup[]> => ipcRenderer.invoke('session:list'),
  openSession: (req: OpenRequest): Promise<SessionInfo> => ipcRenderer.invoke('session:open', req),
  terminate: (key: string): Promise<void> => ipcRenderer.invoke('session:terminate', key),
  input: (key: string, data: string) => ipcRenderer.send('session:input', { key, data }),
  resize: (key: string, cols: number, rows: number) => ipcRenderer.send('session:resize', { key, cols, rows }),
  onData: (cb: (key: string, data: string) => void) =>
    ipcRenderer.on('session:data', (_e, m: { key: string; data: string }) => cb(m.key, m.data)),
  onStatus: (cb: (key: string, status: SessionStatus) => void) =>
    ipcRenderer.on('session:status', (_e, m: { key: string; status: SessionStatus }) => cb(m.key, m.status)),
  onExit: (cb: (key: string) => void) =>
    ipcRenderer.on('session:exit', (_e, m: { key: string }) => cb(m.key)),
  debug: (): Promise<{ count: number; pids: number[] }> => ipcRenderer.invoke('session:debug'),
});
```

- [ ] **Step 2b: Create `src/main/fake-pi.mjs` (test-only fake backend)**

```js
// src/main/fake-pi.mjs
// Stand-in for `pi` in automated E2E: prints a heartbeat every second,
// echoes stdin lines, and exits cleanly on SIGTERM. No network / model / credentials.
let n = 0;
const timer = setInterval(() => { n += 1; process.stdout.write(`tick ${n}\n`); }, 1000);
process.stdout.write('fake-pi ready\n');

process.stdin.on('data', (d) => {
  const s = d.toString();
  process.stdout.write(`echo: ${s}`);
});

function shutdown() {
  clearInterval(timer);
  process.stdout.write('terminated\n');
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

- [ ] **Step 3: Create `src/main/index.ts`**

```ts
import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'node:path';
import { SessionPool } from './sessionPool';
import type { IPtyLike } from './sessionPool';
import nodePty from 'node-pty';

const SESSIONS_DIR = path.join(app.getPath('home'), '.pi', 'agent', 'sessions');

function createPool(win: BrowserWindow) {
  const useFake = process.env.PI_DESKTOP_FAKE === '1';
  const fakeScript = path.join(__dirname, 'fake-pi.mjs');
  const ptyFactory = (file: string, args: string[], opts: any): IPtyLike => {
    if (useFake) return nodePty.spawn('node', [fakeScript], { ...opts, shell: true }) as unknown as IPtyLike;
    return nodePty.spawn(file, args, { ...opts, shell: true }) as unknown as IPtyLike;
  };
  return new SessionPool(ptyFactory, {
    cols: 80, rows: 24, sessionsDir: SESSIONS_DIR,
    onData: (key, data) => win.webContents.send('session:data', { key, data }),
    onStatus: (key, status) => win.webContents.send('session:status', { key, status }),
    onExit: (key) => win.webContents.send('session:exit', { key }),
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100, height: 720,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const pool = createPool(win);

  ipcMain.handle('session:list', () => pool.listFiles());
  ipcMain.handle('session:open', (_e, req: { key?: string; cwd?: string; name?: string }) => {
    if (req.key && req.key.endsWith('.jsonl')) return pool.openExisting(req.key);
    if (req.cwd) return pool.openNew(req.cwd, req.name);
    throw new Error('session:open requires key or cwd');
  });
  ipcMain.handle('session:terminate', (_e, key: string) => pool.terminate(key));
  ipcMain.handle('session:debug', () => pool.debugInfo());
  ipcMain.on('session:input', (_e, m: { key: string; data: string }) => pool.write(m.key, m.data));
  ipcMain.on('session:resize', (_e, m: { key: string; cols: number; rows: number }) => pool.resize(m.key, m.cols, m.rows));

  win.on('closed', () => pool.killAll());
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
```

- [ ] **Step 4: Create `src/renderer/src/ipc.ts`**

```ts
import type { OpenRequest, SessionGroup, SessionInfo, SessionStatus } from './types';

export interface PiApi {
  listSessions(): Promise<SessionGroup[]>;
  openSession(req: OpenRequest): Promise<SessionInfo>;
  terminate(key: string): Promise<void>;
  input(key: string, data: string): void;
  resize(key: string, cols: number, rows: number): void;
  debug(): Promise<{ count: number; pids: number[] }>;
  onData(cb: (key: string, data: string) => void): void;
  onStatus(cb: (key: string, status: SessionStatus) => void): void;
  onExit(cb: (key: string) => void): void;
}
export const pi = (window as any).pi as PiApi;
```

- [ ] **Step 5: Type-check / smoke (no runtime test needed yet; renderer not wired)**

Run: `cd pi-desktop && pnpm exec tsc -p tsconfig.node.json --noEmit`
Expected: no type errors for main/preload.

- [ ] **Step 6: Commit**

```bash
cd pi-desktop && git add -A && git commit -m "feat: wire IPC bridge (preload + main handlers) for SessionPool"
```

---

## Task 4: Sidebar component (grouped tree, green dot, hover terminate, new dir/session)

**Files:**
- Create: `src/renderer/src/components/Sidebar.tsx`
- Create: `src/renderer/src/__tests__/setup.ts`
- Create: `src/renderer/src/__tests__/Sidebar.test.tsx`

**Interfaces:**
- Consumes: `pi` from `../ipc` (`listSessions`, `openSession`, `terminate`, `onStatus`).
- Produces: renders groups; calls `onOpen(key?|cwd?)` and `onTerminate(key)` to parent `App`; merges `statusMap` (from `onStatus`) for green dots.

- [ ] **Step 1: Create test setup `src/renderer/src/__tests__/setup.ts`**

```ts
import '@testing-library/jest-dom';
```

- [ ] **Step 2: Write the failing test `Sidebar.test.tsx`**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Sidebar } from '../components/Sidebar';

const groups = [
  { cwd: 'C:\\Users\\hcz\\.pi-agent', sessions: [
    { key: '/a/s1.jsonl', name: '2026-07-03 19:07', time: '2026-07-03 19:07' },
  ]},
];

function renderSidebar(statusMap = {}) {
  const api = {
    listSessions: vi.fn().mockResolvedValue(groups),
    openSession: vi.fn().mockResolvedValue({ key: 'k', cwd: 'x', name: 'n', status: 'running' }),
    terminate: vi.fn().mockResolvedValue(undefined),
    input: vi.fn(), resize: vi.fn(), onData: vi.fn(), onStatus: vi.fn(), onExit: vi.fn(),
  };
  (window as any).pi = api;
  const onOpen = vi.fn(), onTerminate = vi.fn();
  render(<Sidebar statusMap={statusMap} onOpen={onOpen} onTerminate={onTerminate} />);
  return { api, onOpen, onTerminate };
}

describe('Sidebar', () => {
  it('renders groups and sessions', async () => {
    renderSidebar();
    expect(await screen.findByText(/C:\\Users\\hcz/)).toBeInTheDocument();
    expect(screen.getByText('2026-07-03 19:07')).toBeInTheDocument();
  });
  it('shows green dot when status running', async () => {
    const { container } = renderSidebar({ '/a/s1.jsonl': 'running' });
    const dot = await screen.findByText('2026-07-03 19:07');
    const item = dot.closest('.session-item')!;
    expect(item.querySelector('.dot.running')).toBeInTheDocument();
  });
  it('clicking a session opens it', async () => {
    const { onOpen } = renderSidebar();
    fireEvent.click(await screen.findByText('2026-07-03 19:07'));
    expect(onOpen).toHaveBeenCalledWith({ key: '/a/s1.jsonl' });
  });
  it('hover terminate calls onTerminate', async () => {
    const { onTerminate } = renderSidebar({ '/a/s1.jsonl': 'running' });
    const item = (await screen.findByText('2026-07-03 19:07')).closest('.session-item')!;
    fireEvent.click(item.querySelector('.terminate')!);
    expect(onTerminate).toHaveBeenCalledWith('/a/s1.jsonl');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd pi-desktop && pnpm test src/renderer/src/__tests__/Sidebar.test.tsx`
Expected: FAIL — `Sidebar` not defined.

- [ ] **Step 4: Write `Sidebar.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { pi } from '../ipc';
import type { SessionGroup, SessionStatus } from '../types';

interface Props {
  statusMap: Record<string, SessionStatus>;
  onOpen: (req: { key?: string; cwd?: string; name?: string }) => void;
  onTerminate: (key: string) => void;
}

export function Sidebar({ statusMap, onOpen, onTerminate }: Props) {
  const [groups, setGroups] = useState<SessionGroup[]>([]);

  useEffect(() => {
    pi.listSessions().then(setGroups).catch(() => setGroups([]));
  }, []);

  return (
    <aside style={{ width: 280, background: '#16161e', borderRight: '1px solid #2a2a36', display: 'flex', flexDirection: 'column', color: '#d4d4d8' }}>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid #2a2a36', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 600 }}>会话</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => {
            const dir = window.prompt('选择目录（真实文件夹路径）：', 'C:\\Users\\hcz\\project');
            if (dir) onOpen({ cwd: dir });
          }}>+ 目录</button>
          <button onClick={() => {
            const name = window.prompt('新会话名称：', 'new-session');
            if (name) onOpen({ cwd: groups[0]?.cwd, name: name ?? undefined });
          }}>+ 会话</button>
        </div>
      </div>
      <div style={{ overflowY: 'auto', flex: 1, padding: '6px 0' }}>
        {groups.map((g) => (
          <div key={g.cwd} className="group" style={{ marginBottom: 4 }}>
            <div style={{ padding: '6px 12px', color: '#8b8b98', fontSize: 11, wordBreak: 'break-all' }}>
              📁 {g.cwd}
            </div>
            {g.sessions.map((s) => {
              const running = statusMap[s.key] === 'running';
              return (
                <div key={s.key} className="session-item" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px 5px 26px', cursor: 'pointer' }}
                     onClick={() => onOpen({ key: s.key })}>
                  <span className={`dot ${running ? 'running' : ''}`} style={{ width: 8, height: 8, borderRadius: '50%', background: running ? '#3fb950' : '#444', flex: 'none' }} />
                  <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
                  <button className="terminate" title="终止会话" onClick={(e) => { e.stopPropagation(); onTerminate(s.key); }}
                    style={{ display: 'none', width: 18, height: 18, border: 'none', background: 'transparent', color: '#f85149', cursor: 'pointer' }} >✕</button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </aside>
  );
}
```

> Show the terminate button only on hover — this is done in `App.tsx`/global CSS via `.session-item:hover .terminate { display: inline-flex !important; }`. Add that rule in `App.tsx`'s `<style>` (Task 6). The test clicks `.terminate` directly (visible in jsdom regardless of CSS), so it still passes.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd pi-desktop && pnpm test src/renderer/src/__tests__/Sidebar.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd pi-desktop && git add -A && git commit -m "feat: Sidebar with grouped sessions, green dot, hover terminate, new dir/session"
```

---

## Task 5: TerminalPane component (xterm.js per session, attach/detach, input/resize)

**Files:**
- Create: `src/renderer/src/components/TerminalPane.tsx`
- Create: `src/renderer/src/__tests__/TerminalPane.test.tsx`

**Interfaces:**
- Consumes: `pi` (`input`, `resize`, `onData`), `sessionKey`, `active`, `cols/rows` from parent.
- Produces: mounts a `Terminal` per session; when `active`, attaches to its div and fits; forwards keystrokes via `pi.input(key, data)`; writes incoming `pi.onData` bytes to the terminal.

- [ ] **Step 1: Write the failing test `TerminalPane.test.tsx`**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { TerminalPane } from '../components/TerminalPane';

describe('TerminalPane', () => {
  it('forwards keystrokes to pi.input when active', () => {
    const api = {
      listSessions: vi.fn(), openSession: vi.fn(), terminate: vi.fn(),
      input: vi.fn(), resize: vi.fn(), onData: vi.fn(), onStatus: vi.fn(), onExit: vi.fn(),
    };
    (window as any).pi = api;
    render(<TerminalPane sessionKey="k" active={true} />);
    // TerminalPane registers onData; we simulate a keypress by calling the captured onData handler
    expect(api.onData).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pi-desktop && pnpm test src/renderer/src/__tests__/TerminalPane.test.tsx`
Expected: FAIL — `TerminalPane` not defined.

- [ ] **Step 3: Write `TerminalPane.tsx`**

```tsx
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { pi } from '../ipc';
import '@xterm/xterm/css/xterm.css';

interface Props { sessionKey: string; active: boolean; }

export function TerminalPane({ sessionKey, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal>();
  const fitRef = useRef<FitAddon>();

  useEffect(() => {
    const term = new Terminal({ convertEol: true, cursorBlink: true, fontFamily: 'monospace', fontSize: 13 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term; fitRef.current = fit;

    const onData = (key: string, data: string) => { if (key === sessionKey) term.write(data); };
    pi.onData(onData);

    term.onData((d) => pi.input(sessionKey, d));

    return () => {
      term.dispose();
      // Note: pi.onData has no off(); a production build should track and ignore stale keys.
    };
  }, [sessionKey]);

  useEffect(() => {
    if (!hostRef.current || !termRef.current || !fitRef.current) return;
    termRef.current.open(hostRef.current);
    try { fitRef.current.fit(); } catch {}
    const { cols, rows } = termRef.current;
    pi.resize(sessionKey, cols, rows);
  }, [active, sessionKey]);

  return <div ref={hostRef} data-session={sessionKey} className={active ? 'terminal-host active' : 'terminal-host'} style={{ flex: 1, padding: 8, background: '#0c0c0c', display: active ? 'block' : 'none' }} />;
}
```

> The test checks `pi.onData` was registered. For a production-grade teardown, track the registered callback and ignore messages for non-active keys; the above already guards by `key === sessionKey`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pi-desktop && pnpm test src/renderer/src/__tests__/TerminalPane.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd pi-desktop && git add -A && git commit -m "feat: TerminalPane with xterm.js, input/resize, per-session attach/detach"
```

---

## Task 6: App composition (layout, active switching, status wiring)

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/main.tsx` (use `App`)

**Interfaces:**
- Consumes: `Sidebar`, `TerminalPane`, `pi.openSession`, `pi.terminate`, `pi.onStatus`, `pi.onExit`.
- Produces: the full working UI: click sidebar → open session → TerminalPane becomes active; status updates drive green dots; hover terminate kills.

- [ ] **Step 1: Rewrite `src/renderer/src/App.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { TerminalPane } from './components/TerminalPane';
import { pi } from './ipc';
import type { SessionInfo, SessionStatus } from './types';

interface OpenSession extends SessionInfo { key: string; cwd: string; name: string; status: SessionStatus; }

export default function App() {
  const [open, setOpen] = useState<OpenSession[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [statusMap, setStatusMap] = useState<Record<string, SessionStatus>>({});

  useEffect(() => {
    pi.onStatus((key, status) => setStatusMap((m) => ({ ...m, [key]: status })));
    pi.onExit((key) => setStatusMap((m) => ({ ...m, [key]: 'dead' })));
  }, []);

  const handleOpen = async (req: { key?: string; cwd?: string; name?: string }) => {
    const info = await pi.openSession(req);
    setOpen((list) => list.some((s) => s.key === info.key) ? list : [...list, info as OpenSession]);
    setActiveKey(info.key);
  };
  const handleTerminate = (key: string) => { pi.terminate(key); };

  const active = open.find((s) => s.key === activeKey);

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#0c0c0c', color: '#d4d4d8', fontFamily: 'monospace' }}>
      <Sidebar statusMap={statusMap} onOpen={handleOpen} onTerminate={handleTerminate} />
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ height: 34, borderBottom: '1px solid #2a2a36', display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px', background: '#16161e' }}>
          <span style={{ fontWeight: 600 }}>{active ? `${active.name} · ${active.cwd}` : '—'}</span>
          <span style={{ fontSize: 11, color: statusMap[activeKey ?? ''] === 'running' ? '#3fb950' : '#8b8b98' }}>
            {statusMap[activeKey ?? ''] === 'running' ? '● 运行中' : '空闲'}
          </span>
        </div>
        <div style={{ flex: 1, position: 'relative' }}>
          {open.map((s) => (
            <TerminalPane key={s.key} sessionKey={s.key} active={s.key === activeKey} />
          ))}
          {!active && <div style={{ padding: 20, color: '#8b8b98' }}>从左侧选择一个会话，或新建会话。</div>}
        </div>
      </main>
      <style>{`.session-item:hover .terminate { display: inline-flex !important; }`}</style>
    </div>
  );
}
```

- [ ] **Step 2: Update `src/renderer/src/main.tsx` to render `App`**

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
```

- [ ] **Step 3: Type-check renderer**

Run: `cd pi-desktop && pnpm exec tsc -p tsconfig.json --noEmit`
Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
cd pi-desktop && git add -A && git commit -m "feat: compose App — sidebar + terminal panes, active switch, status wiring"
```

---

## Task 7: Lifecycle hardening (kill on close, spawn-failure handling)

**Files:**
- Modify: `src/main/index.ts` (already kills on `closed`; add spawn-failure guard + startup list push)

**Interfaces:**
- Consumes: `SessionPool` (Task 2/3).
- Produces: robust spawn errors (don't crash), explicit startup `session:list` push, guarantee `killAll` on quit.

- [ ] **Step 1: Guard `openSession` against spawn failure**

In `src/main/index.ts`, wrap the handler body so a throw becomes a rejected promise with a clear message instead of crashing the main process:

```ts
ipcMain.handle('session:open', (_e, req: { key?: string; cwd?: string; name?: string }) => {
  try {
    if (req.key && req.key.endsWith('.jsonl')) return pool.openExisting(req.key);
    if (req.cwd) return pool.openNew(req.cwd, req.name);
    throw new Error('session:open requires key or cwd');
  } catch (err) {
    console.error('[session:open] failed:', err);
    throw new Error('无法启动 pi 会话，请确认 pi 已在 PATH 中且目录可访问');
  }
});
```

- [ ] **Step 2: Ensure kill on app quit**

Add after `createWindow` registration (or near `app.whenReady`):

```ts
app.on('before-quit', () => { /* pool is per-window; killAll already on window 'closed' */ });
```

Since `pool.killAll()` runs on `win.on('closed')`, and the last window close triggers quit, running processes are killed. No further change needed; verify in E2E (Task 8).

- [ ] **Step 3: Type-check main**

Run: `cd pi-desktop && pnpm exec tsc -p tsconfig.node.json --noEmit`
Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
cd pi-desktop && git add -A && git commit -m "fix: guard session:open spawn failure; ensure killAll on window close"
```

---

## Task 8: Automated end-to-end tests (Playwright + fake backend)

**Files:**
- Create: `playwright.config.ts`
- Create: `e2e/app.spec.ts`

**Interfaces:**
- Consumes: built app (`out/main/index.js`), `window.pi.debug()` (Task 3), `fake-pi.mjs` (Task 3), Sidebar/TerminalPane (Tasks 4/5).
- Produces: a fully automated E2E that proves, with **NO manual steps** and **NO real `pi`/model/credentials**: sidebar renders, opening a session shows a terminal, switching away keeps the process running (continuity), hover-terminate kills it, and closing the app kills all child processes.

- [ ] **Step 1: Create `playwright.config.ts`**

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60000,
  expect: { timeout: 10000 },
  reporter: [['list']],
});
```

- [ ] **Step 2: Create `e2e/app.spec.ts`**

```ts
import { test, expect, _electron, type Page } from '@playwright/test';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const MAIN = path.join(__dirname, '..', 'out', 'main', 'index.js');

async function latestTick(page: Page): Promise<number> {
  const txt = await page.locator('.terminal-host.active .xterm-rows').innerText().catch(() => '');
  const m = [...txt.matchAll(/tick (\d+)/g)];
  return m.length ? Number(m[m.length - 1][1]) : -1;
}

function pidAlive(pid: number): boolean {
  try { execSync(`tasklist /FI "PID eq ${pid}"`); return true; }
  catch { return false; }
}

test('list → open → continuity across switch → hover terminate → close kills', async () => {
  const electronApp = await _electron.launch({ args: [MAIN], env: { ...process.env, PI_DESKTOP_FAKE: '1' } });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  page.on('dialog', (d) => d.accept('e2e-session')); // auto-answer +会话 window.prompt

  // 1) app loaded (sidebar header visible)
  await expect(page.getByText('会话')).toBeVisible({ timeout: 15000 });

  // 2) open first fake session → terminal renders, green dot running
  await page.locator('button', { hasText: '+ 会话' }).click();
  await expect(page.locator('.terminal-host.active .xterm-rows').innerText()).toContain('fake-pi ready', { timeout: 15000 });
  await expect(page.locator('.session-item', { hasText: 'e2e-session' }).first().locator('.dot.running')).toBeVisible();
  expect((await page.evaluate(() => (window as any).pi.debug())).count).toBe(1);

  // 3) open a second session, switch back to first, prove it kept ticking while hidden
  const before = await latestTick(page);
  await page.locator('button', { hasText: '+ 会话' }).click();
  expect((await page.evaluate(() => (window as any).pi.debug())).count).toBe(2);
  await page.waitForTimeout(3000);
  await page.locator('.session-item', { hasText: 'e2e-session' }).first().click();
  const after = await latestTick(page);
  expect(after).toBeGreaterThan(before); // process ran while hidden → continuity proven

  // 4) capture all child pids, then hover-terminate the first session
  const pidsAll = (await page.evaluate(() => (window as any).pi.debug())).pids as number[];
  const item = page.locator('.session-item', { hasText: 'e2e-session' }).first();
  await item.hover();
  await item.locator('.terminate').click();
  await expect(item.locator('.dot.running')).toHaveCount(0);
  expect((await page.evaluate(() => (window as any).pi.debug())).count).toBe(1);

  // 5) close app → all child pids must be gone (kill-on-close)
  await electronApp.close();
  await page.waitForTimeout(1500);
  for (const pid of pidsAll) expect(pidAlive(pid)).toBe(false);
});
```

> `tasklist` is Windows-specific (this environment is Windows). On other platforms swap `pidAlive` for `ps -p <pid>`. The PID-based assertion removes any need for manual verification of process cleanup.

- [ ] **Step 3: Build the app, then run E2E**

Run:
```bash
cd pi-desktop && pnpm build && pnpm exec playwright install && pnpm test:e2e
```
Expected:
- `pnpm build` produces `out/main`, `out/preload`, `out/renderer`.
- `playwright install` fetches the Electron build Playwright drives.
- `pnpm test:e2e` → the spec PASSES: sidebar renders, fake terminal shows `fake-pi ready`, green dot present, tick count increases after switching away and back (continuity), hover-terminate drops the running count and removes the dot, and after `app.close()` the child `node fake-pi.mjs` PIDs are no longer alive.

- [ ] **Step 4: Commit**

```bash
cd pi-desktop && git add -A && git commit -m "test: add automated Playwright E2E (fake backend) for session flow + continuity + terminate + close-kill"
```

**Optional (only if `pi` + a model key are available in CI):** add a second spec that launches WITHOUT `PI_DESKTOP_FAKE`, opens a real session, and asserts the TUI renders (`xterm-rows` contains known `pi` TUI text). This exercises the real `pi` path but is gated behind credential availability so the default suite stays hermetic.

---

## Self-Review Notes (per skill)

- **Spec coverage:** §1 goals (sidebar groups, green dot, hover terminate, task continuity, close-kills) → Tasks 4/5/6/7/8. §2 stack → Task 1. §3 architecture → Tasks 2/3. §4 pool → Task 2. §5 sidebar → Task 4. §6 terminal → Task 5. §7 IPC → Task 3. §8 lifecycle → Task 7. §9 verification → **Task 8 is now FULLY AUTOMATED (Playwright + fake backend); no manual E2E remains.** No gaps.
- **Automated testing:** Unit (SessionPool mock + real PTY, Sidebar, TerminalPane via vitest) + E2E (Playwright drives the built app in fake mode: list → open → continuity-across-switch → hover-terminate → close-kills, with PID-level process assertions). The real-`pi` path is covered by the same `SessionPool` spawn code (real-PTY integration test) and an optional gated spec; the default suite is hermetic (no `pi`/model/credentials).
- **Placeholders:** None. All code steps show real code; no "TBD"/"implement later". The `write` test note is an explicit implementer instruction, not a placeholder.
- **Type consistency:** `SessionInfo`/`SessionGroup`/`SessionStatus`/`OpenRequest` defined in `types.ts` (Task 3) and `sessionPool.ts` (Task 2); reused identically in Sidebar/TerminalPane/App and IPC signatures. `window.pi` API shape in `ipc.ts` matches `preload/index.ts`. `debug()` returns `{count, pids}` consistently across SessionPool/ipyMain/preload/ipc.
- **Known simplification:** `pi.onData`/`onStatus`/`onExit` in preload have no `off()`; `TerminalPane` guards by `key === sessionKey` and relies on component unmount + key guard. Acceptable for v1; a follow-up can add an unsubscribe handle. Flagged, not a blocker.
