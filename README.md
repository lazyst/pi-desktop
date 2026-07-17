# pi-desktop

> 📖 中文文档：[README.zh-CN.md](./README.zh-CN.md)

A desktop application that wraps the [`pi`](https://gitcode.com) CLI's real
terminal UI (TUI) in multiple, isolated terminals — managed from a
sidebar-organized session list.

Built with Electron, React, and xterm.js. Each session is a real
`node-pty` process running `pi`, so you get the genuine `pi` TUI, not a
re-implementation.

## Features

- **Multiple isolated terminals** — one real `pi` process per session, each
  in its own terminal pane.
- **Sidebar session manager** — sessions grouped by working directory
  (project `cwd`), with a green dot for running sessions and a hover-to-terminate
  button.
- **New directory / new session** — pick a real folder or start a new
  `pi` session under any group.
- **Clear a directory's sessions** — the trash icon on each group header
  terminates every running process in that directory and deletes all of its
  `.jsonl` files at once, so the whole group disappears from the sidebar.
- **Batch delete sessions** — "管理" in the sidebar enters a multi-select mode
  where every session gets a checkbox; select arbitrarily across directories,
  and the header shows "已选 N 项 · 删除 · 取消" (N selected · delete · cancel).
  Confirm to batch-terminate and delete.
- **Delete a single session** — right-click a session → "删除会话"; confirm in
  the dialog to terminate its process and remove its `.jsonl` file.
- **Switch without killing** — switching to another session keeps the previous
  one running in the background; its task continues and the green dot stays on.
  Switching back re-attaches the same, still-running process (instant, no restart).
- **Light / dark theme** — ships GitHub-style dark and light themes; the gear
  button on the title bar opens the Settings panel to switch, and the choice is
  remembered in `localStorage` across restarts.
- **Frameless window** — the native menu bar and OS title bar are removed in
  favor of a custom title bar (app name + minimize / maximize / close) whose
  colors follow the active theme. The native edge-resize lost by going frameless
  is restored by a custom 8-direction resize region.
- **Safe cleanup** — closing the app kills all running `pi` processes.
- **Sandboxed renderer** — `nodeIntegration: false`, `contextIsolation: true`,
  `sandbox: true`. All process/PTY management lives in the main process; the
  renderer is a pure view.

## Tech Stack

| Layer        | Choice                                                |
| ------------ | ----------------------------------------------------- |
| Shell        | Electron                                             |
| Main process | Node + `node-pty` (conpty on Windows)              |
| Renderer     | React + TypeScript (Vite / electron-vite)           |
| Terminal     | `XtermTerminal`（完全采用 VS Code 集成终端同款组件与装配：`@xterm/xterm`@6 + `@xterm/addon-webgl` + `@xterm/addon-fit` + `@xterm/addon-clipboard` + `@xterm/addon-unicode11`）+ `node-pty` PTY 链路 |
| Tests        | Vitest (unit) + Playwright (E2E, real Electron)   |

## Prerequisites

- **Node.js** (managed via `mise` in this repo) and **pnpm**
- The **`pi` CLI** available on your `PATH` (or set `PI_BIN` to its absolute path)
- **`node-pty`** native build tools:
  - Windows: Visual Studio Build Tools (or use a prebuilt binary)
  - macOS/Linux: a working C/C++ toolchain

> The app resolves the `pi` binary (and `node` used by the `pi` shim) at
> runtime, including the well-known pnpm global bin location, so double-clicking
> the built `.exe` works even when the user shell `PATH` is not inherited.

## Getting Started

```bash
pnpm install

# Dev (Electron + Vite HMR)
pnpm dev

# Production build
pnpm build

# Preview the built app
pnpm start
```

## Testing

```bash
# Unit tests (SessionPool, React components) — fast, no display needed
pnpm test

# End-to-end (launches the real Electron app via Playwright)
pnpm test:e2e
```

E2E uses a fake `pi` (`PI_DESKTOP_FAKE=1`, see `src/main/fake-pi.mjs`)
that prints a heartbeat and writes a real `.jsonl` on first input, so the
filesystem → sidebar promotion flow is exercisable without credentials or a model.

## Architecture

```
Main Process — SessionPool (single source of truth)
  ├─ Map<sessionKey, { pty, status: 'running' | 'dead', cwd, name }>
  ├─ spawn('pi') / kill / forward I/O
  ▲  IPC (ipcMain / ipcRenderer)
  │
Renderer (React)
  ├─ Sidebar     —— sessions grouped by cwd + green dot + hover terminate + clear/batch delete
  └─ TerminalPane —— React shell; one XtermTerminal thin wrapper per open session, shown/hidden by `active`
```

- **`sessionKey`** = absolute path of the session's `.jsonl` file (new sessions
  use a `pi`-generated key, e.g. `live-<uuid>`).
- **Open / reopen** — `session:open{ key?, cwd?, name? }`. Opening a
  disk-backed session reuses the already-running process for that file (it does
  **not** spawn a duplicate), so switching back is instant and the task keeps
  running. A session whose process has died is restarted on open.
- **Switch away** — the terminal pane is hidden (CSS `display`) but still
  receives PTY data, so the buffer is preserved and the task continues.
- **Input** — `Terminal.onData` → `session:input` → `pty.write`.
- **Output** — `pty.on('data')` → `session:data` → `XtermTerminal` 写入。PTY 数据经固定 5ms 时间窗聚合（对齐 VS Code `TerminalDataBufferer`）后一次性 `term.write`，消除流式高频重绘的中间帧闪烁；xterm 原生处理 `?2026` 同步输出序列，无需自研帧切分。
- **Terminal layer** — `XtermTerminal` 完全采用 VS Code 集成终端同款装配：`@xterm/xterm`@6 稳定版 + `addon-webgl`（open 前锁定渲染器、会话内恒定）+ `addon-fit` + `addon-clipboard`（接管复制/粘贴）+ `addon-unicode11`（CJK / 宽字符度量）。详见 `docs/adr/0003-terminal-vscode-integrated-components.md`。
- **Resize** — `FitAddon` computes `cols`/`rows`, then both
  `Terminal.resize()` and `pty.resize()` are called so the `pi` TUI reflows.

### IPC Contract

Renderer → Main:

- `session:list` — request session groups
- `session:open{ key?, cwd?, name? }` — open / create a session
- `session:input{ key, data }` — terminal keystrokes
- `session:resize{ key, cols, rows }` — size changed
- `session:terminate{ key }` — kill a session
- `session:delete{ key }` — delete a single session (kill process + remove `.jsonl`)
- `session:deleteMany{ keys }` — batch-delete multiple sessions (kill + remove files)
- `session:clearDirectory{ cwd }` — clear all sessions under a directory (kill + remove files)
- `session:pickDirectory` — native folder picker
- `session:debug` — pool diagnostics (process count / pids)
- `window:minimize` — minimize the window
- `window:toggle-maximize` — toggle maximize / restore
- `window:close` — close the window
- `window:get-bounds` — read window geometry (`{ x, y, width, height }`)
- `window:set-bounds` — set window geometry (used by the custom resize region)

Main → Renderer:

- `session:list{ groups }` — initial / changed index (also pushed on fs change)
- `session:data{ key, data }` — PTY output bytes
- `session:status{ key, status }` — `running` / `dead` (drives the green dot)
- `session:exit{ key }` — process exited
- `session:index{ groups }` — filesystem watch push (promotes new sessions)
- `window:maximize-change{ maximized }` — maximize state changed (drives the title bar maximize/restore icon)

## Environment Variables

| Variable                   | Purpose                                              |
| -------------------------- | ---------------------------------------------------- |
| `PI_BIN`                  | Absolute path to the `pi` executable                 |
| `PI_DESKTOP_SESSIONS_DIR`| Override `~/.pi/agent/sessions` (used by E2E)      |
| `PI_DESKTOP_FAKE`         | Use the fake `pi` instead of the real one (E2E)     |

## License

See repository settings.
