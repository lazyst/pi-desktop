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
- **Switch without killing** — switching to another session keeps the previous
  one running in the background; its task continues and the green dot stays on.
  Switching back re-attaches the same, still-running process (instant, no restart).
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
| Terminal     | `@xterm/xterm` + `@xterm/addon-fit`                |
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
  ├─ Sidebar     —— sessions grouped by cwd + green dot + hover terminate
  └─ TerminalPane —— one xterm.js per open session, shown/hidden by `active`
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
- **Output** — `pty.on('data')` → `session:data` → `Terminal.write`.
- **Resize** — `FitAddon` computes `cols`/`rows`, then both
  `Terminal.resize()` and `pty.resize()` are called so the `pi` TUI reflows.

### IPC Contract

Renderer → Main:

- `session:list` — request session groups
- `session:open{ key?, cwd?, name? }` — open / create a session
- `session:input{ key, data }` — terminal keystrokes
- `session:resize{ key, cols, rows }` — size changed
- `session:terminate{ key }` — kill a session
- `session:pickDirectory` — native folder picker
- `session:debug` — pool diagnostics (process count / pids)

Main → Renderer:

- `session:list{ groups }` — initial / changed index (also pushed on fs change)
- `session:data{ key, data }` — PTY output bytes
- `session:status{ key, status }` — `running` / `dead` (drives the green dot)
- `session:exit{ key }` — process exited
- `session:index{ groups }` — filesystem watch push (promotes new sessions)

## Environment Variables

| Variable                   | Purpose                                              |
| -------------------------- | ---------------------------------------------------- |
| `PI_BIN`                  | Absolute path to the `pi` executable                 |
| `PI_DESKTOP_SESSIONS_DIR`| Override `~/.pi/agent/sessions` (used by E2E)      |
| `PI_DESKTOP_FAKE`         | Use the fake `pi` instead of the real one (E2E)     |

## License

See repository settings.
