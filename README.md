# pi-desktop

> 📖 中文文档：[README.zh-CN.md](./README.zh-CN.md)

A desktop application that wraps the [`pi`](https://gitcode.com) CLI's real
terminal UI (TUI) inside multiple isolated terminals, managed via a
sidebar-organized session list and a workspace-based tab system.

Built with Electron, React, and xterm.js. Each session is a real
`node-pty` process running `pi`, so you get the genuine `pi` TUI, not a
re-implementation. Additionally, integrated shell terminals with VS Code-style
shell injection are supported for general-purpose terminal work.

## Features

### Pi Sessions

- **Multiple isolated pi terminals** — one real `pi` process per session, each
  in its own terminal pane.
- **Sidebar session manager** — sessions grouped by working directory (project
  `cwd`), with a green dot for running sessions and hover-to-terminate / right-click
  context menu.
- **New directory / new session** — pick a real folder, or start a new `pi`
  session under any group.
- **Clear a directory's sessions** — the trash icon on each group header
  terminates every running process in that directory and deletes all of its
  `.jsonl` files at once; the whole group disappears from the sidebar.
- **Batch delete sessions** — "管理" in the sidebar enters multi-select mode;
  every session gets a checkbox. Select arbitrarily across directories then
  batch-terminate and delete.
- **Delete a single session** — right-click a session → "删除会话"; confirm
  to terminate its process and remove its `.jsonl` file.
- **Switch without killing** — switching to another session keeps the previous
  one running in the background; its task continues and the green dot stays on.
  Switching back re-attaches the same, still-running process (instant, no restart).
- **Unsaved sessions** — sessions not yet promoted to disk (pre-first-input) are
  listed at the top of each group as "unsaved" entries.

### Integrated Shell Terminals

- **General-purpose shell terminals** — launch bash, zsh, powershell, fish, or
  cmd.exe directly within any workspace, separate from pi sessions.
- **VS Code-style shell integration** — shell integration scripts (bash, zsh,
  fish, powershell) are injected automatically via `--init-file` / `-command` /
  `ZDOTDIR`, enabling OSC 633 sequences for command tracking and cwd detection.
- **Tab-based multi-terminal** — each workspace directory has its own tab bar
  for managing multiple shell terminals alongside pi sessions, diffs, and previews.

### Workspace & Tab System

- **Multi-cwd tab groups** — tabs (sessions, terminals, diffs, previews) are
  grouped by their working directory; each directory has its own independent
  tab bar.
- **Drag-and-drop tab reordering** — rearrange tabs within a workspace via DnD
  (powered by `@dnd-kit`).
- **Keep-alive** — switching away from a tab hides its content (CSS `display`)
  but does not destroy the process or instance; switching back is instant.
- **Right panel** — a resizable right panel with **File Tree** (project file
  browser) and **Git** (status / log / diff) tabs, replacing the old FilePanel.

### Editor & Preview

- **Markdown preview** — 3-mode Markdown support:
  - **Rendered preview**: full `react-markdown` pipeline with `remark-gfm`,
    `remark-math`, `rehype-highlight`, `rehype-katex`, and embedded `mermaid`
    diagram rendering.
  - **Rich text (WYSIWYG)**: TipTap-based editor with GFM table, task list,
    image, and link support.
  - **Source editor**: Monaco-based editor with syntax highlighting.
- **Diff viewer** — custom single-file diff view (replacing MonacoDiffEditor)
  for Git working-tree changes and commit diffs.
- **Image preview** — built-in image viewer within the tab system.

### Terminal UX

- **VS Code-style clickable links** — URLs and file paths in the terminal are
  detected and rendered as clickable links (Ctrl+click to open). Supports OSC 8
  hyperlinks, file:path:line:col format, and hover tooltips.
- **Terminal find widget** — search within terminal output (case-sensitive,
  regex, whole-word modes).
- **Select all / copy / paste** — full clipboard integration via
  `@xterm/addon-clipboard`.
- **Scroll position preservation** — scroll state is saved per-pane and restored
  when switching back.
- **Jump-to-bottom** floating button — appears when scrolled up, scrolls to the
  latest output.

### Backpressure & Flow Control

- **Source-level backpressure** — a `BackpressureController` pauses the PTY
  (via `pty.pause()`) at a high watermark and resumes it (`pty.resume()`) at a
  low watermark, matching VS Code's `TerminalProcess` flow control.
- **Dual-segment buffering** — both the main process (`TerminalDataBufferer`,
  5ms window) and the renderer (`XtermTerminal` write debounce, 5ms window)
  batch PTY output before forwarding or writing, eliminating intermediate frame
  flicker from high-frequency streaming.
- **IPC ack batching** — `AckDataBufferer` accumulates consumed byte counts and
  flushes them via IPC at configurable intervals, avoiding per-write IPC overhead.

### Window & UI

- **Frameless window** — native menu bar and OS title bar replaced with a custom
  title bar (app name + settings gear + minimize / maximize / close), whose
  colors follow the active theme.
- **8-direction resize zones** — custom edge-resize regions restore native
  resize behavior lost by going frameless.
- **Light / dark theme** — GitHub-style dark and light themes; switch via the
  gear button > Settings panel; choice persisted in `localStorage`.
- **System tray** — persistent tray icon with "显示 / 退出" context menu;
  double-click to show the window.
- **White flash mitigation** — uses an opacity bridge (`setOpacity(0)` → show →
  `setOpacity(1)`) to prevent the white flash that occurs when showing a
  frameless dark window on Windows.
- **Window state persistence** — position, size, and maximized state are saved
  to `config.json` and restored on next launch.
- **Single-instance lock** — prevents multiple app instances.

### Settings Panel

- **General** — theme, close-button behavior.
- **Session management** — view all disk sessions grouped by directory; delete
  single, clear directory, or batch delete.
- **Terminal** — font size configuration.
- **Pi Configuration** — integrated `pi-tool` configuration management:
  - **配置文件 (Config)** — edit `~/.pi/agent/settings.json` (global / project).
  - **模型配置 (Models)** — edit `~/.pi/agent/models.json` (providers & models).
  - **MCP 管理** — manage multiple MCP config layers (user-global, pi-global,
    project-shared, project-pi).
  - **Skills 管理** — list, enable, disable, and delete pi agent skills.
  - **扩展管理 (Extensions)** — list installed extensions from
    `~/.pi/agent/settings.json`.

### Safety & Security

- **Safe cleanup** — closing the app kills all running `pi` and shell processes.
- **Sandboxed renderer** — `nodeIntegration: false`, `contextIsolation: true`,
  `sandbox: true`. All process/PTY management lives in the main process; the
  renderer is a pure view.
- **File system bridge** — all file I/O goes through `fsBridge` IPC handlers
  with root-directory bounds-checking.
- **External URL safety** — external links opened via `exec()` instead of
  `shell.openExternal` to avoid Electron 30+ security confirmation dialogs.
- **Shell integration security** — injected scripts use per-session nonces and
  permission-restricted temp directories.

## Tech Stack

| Layer          | Choice                                                           |
| -------------- | ---------------------------------------------------------------- |
| Shell          | Electron 32 + electron-vite                                      |
| Main process   | Node + `node-pty` (conpty on Windows) + TypeScript               |
| Renderer       | React 18 + TypeScript + Vite                                     |
| State          | Zustand                                                          |
| Terminal       | `@xterm/xterm`@6 + `@xterm/addon-webgl` + `@xterm/addon-fit` + `@xterm/addon-search` + `@xterm/addon-clipboard` + `@xterm/addon-unicode11` + `@xterm/addon-serialize` |
| Markdown       | `react-markdown` + `remark-gfm` / `remark-math` + `rehype-highlight` / `rehype-katex` |
| Rich text      | TipTap 3 + `tiptap-markdown`                                    |
| Code editor    | Monaco Editor (`@monaco-editor/react`)                           |
| Diagrams       | Mermaid                                                          |
| Drag & drop    | `@dnd-kit/core` + `@dnd-kit/sortable`                            |
| Tests          | Vitest (unit) + Playwright (E2E, real Electron)                  |
| Packaging      | electron-builder (NSIS / DMG / AppImage)                         |

## Prerequisites

- **Node.js** (managed via `mise` in this repo) and **pnpm**
- The **`pi` CLI** available on your `PATH` (or set `PI_BIN` to its absolute path)
- **`node-pty`** native build tools:
  - Windows: Visual Studio Build Tools (or use a prebuilt binary)
  - macOS / Linux: a working C/C++ toolchain

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

# Type-check both node and renderer
pnpm typecheck

# Build distributable (platform defaults)
pnpm dist

# Build Windows NSIS installer (one-click mode off)
pnpm dist:win
```

## Testing

```bash
# Unit tests (SessionPool, React components) — fast, no display needed
pnpm test

# Watch mode
pnpm test:watch

# End-to-end (launches the real Electron app via Playwright)
pnpm test:e2e
```

E2E uses a fake `pi` (`PI_DESKTOP_FAKE=1`, see `src/main/fake-pi.mjs`)
that prints a heartbeat and writes a real `.jsonl` on first input, so the
filesystem → sidebar promotion flow is exercisable without credentials or a model.

## Architecture

### Main Process

The main process manages two primary modules:

- **`UnifiedTerminalPool`** (`src/main/unifiedTerminalPool.ts`) — the single
  source of truth for all terminal processes, unifying pi sessions
  (`command === 'pi'`) and integrated shell terminals (`command === undefined`).
  It handles spawn, write, resize, destroy, kill-all, backpressure, and
  filesystem-to-live session reconciliation.
- **`SessionFileManager`** (`src/main/sessionFileManager.ts`) — manages `.jsonl`
  session files on disk: list, delete, clear directory, and parse session names
  from the first user message.

```
Main Process
  ├─ UnifiedTerminalPool (all PTY processes)
  │   ├─ pi sessions:  spawn('pi', ['--session', file|'--name', name])
  │   │   id = 'live-<uuid>'
  │   ├─ shell terminals: spawn(shell, [injected_args])
  │   │   id = 'term-<uuid>'
  │   └─ BackpressureController per instance (pause/resume)
  ├─ SessionFileManager (.jsonl on disk)
  ├─ config.json persistence (debounced writes)
  ├─ System tray (persistent)
  └─ Window state management
      ▲  IPC (ipcMain / ipcRenderer)
      │
Renderer (React)
  ├─ TitleBar          — custom frameless title bar + theme-aware colors
  ├─ Sidebar           — sessions grouped by cwd + green dot + context menus
  │                      + directory pinning + multi-select batch delete
  ├─ CenterPane        — tab bar (per-cwd) + tab body (keep-alive)
  │   ├─ SessionPane   — pi session terminal host
  │   ├─ IntegratedPane — shell terminal host
  │   ├─ PreviewTab    — Markdown preview/editor (3 modes)
  │   └─ DiffTab       — Git diff viewer
  ├─ RightPanel        — File Tree + Git (resizable)
  └─ SettingsPanel     — General / Sessions / Terminal / Pi Config
                          (models, MCP, Skills, Extensions)
```

### Data Flow

- **`sessionKey`** = absolute path of the session's `.jsonl` file (new sessions
  use a `pi`-generated key, e.g. `live-<uuid>`). Live sessions without a disk
  file use `live-<uuid>` directly until promoted.
- **Open / reopen** — `session:open{ key?, cwd?, name? }`. Opening a
  disk-backed session reuses the already-running process for that file (it does
  **not** spawn a duplicate), so switching back is instant and the task keeps
  running. A session whose process has died is restarted on open. For shell
  terminals, use `terminal:spawn{ command: undefined, cwd, profile }`.
- **Switch away** — terminal panes are hidden via CSS `display: none` but
  continue to receive PTY data; the buffer is preserved and the task continues.
- **Input** — `Terminal.onData` → `terminal:input` → `pty.write`.
- **Output** — `pty.on('data')` → 5ms main-process window → `terminal:data` →
  XtermTerminal 5ms write debounce → `term.write()`. The dual-segment
  buffering eliminates intermediate frame flicker from high-frequency streaming.
- **Backpressure** — each PTY's output bytes are counted at the source
  (`pty.on('data')`) before buffering. At a high watermark the PTY is paused
  (`pty.pause()`); on IPC ack from the renderer (`terminal:ack`) the count
  drops and at a low watermark the PTY is resumed (`pty.resume()`).
- **Resize** — `FitAddon` computes `cols`/`rows`, then both
  `Terminal.resize()` and `pty.resize()` are called so the `pi` TUI reflows.
- **Terminal channel abstraction** — `TerminalChannel` decouples data flow
  from global API references. `PaneManager` selects the correct channel
  (session vs. integrated) when acquiring a terminal pane.
- **Shell integration** — VS Code shell integration scripts are injected
  for bash, zsh, fish, and powershell (via `--init-file`, `-command`,
  `ZDOTDIR` override). This enables OSC 633 sequence parsing for command
  start/end markers and automatic cwd tracking (`updateCwd` IPC).

### IPC Contract

Renderer → Main:

| Channel                     | Payload                                                     | Description                                     |
|-----------------------------|-------------------------------------------------------------|-------------------------------------------------|
| `terminal:spawn`            | `{ command?, cwd, profile?, sessionFile?, name?, key? }`   | Create a terminal (pi or shell)                |
| `terminal:input`            | `{ id, data }`                                              | Keyboard input to PTY                          |
| `terminal:resize`           | `{ id, cols, rows }`                                        | Resize PTY                                     |
| `terminal:ack`              | `{ id, bytes }`                                             | Backpressure ack (renderer consumed N bytes)   |
| `terminal:destroy`          | `id: string`                                                | Destroy a shell terminal (by id)               |
| `terminal:saveBuffer`       | `{ id, data }`                                              | Save scrollback buffer snapshot                |
| `terminal:loadBuffer`       | `id: string`                                                | Load scrollback buffer snapshot                |
| `terminal:updateCwd`        | `{ id, cwd }`                                               | Shell integration cwd update                   |
| `terminal:listProfiles`     | —                                                           | List available shell profiles                  |
| `terminal:list`             | —                                                           | List all terminal instances                    |
| `terminal:create`           | `{ profile, cwd }`                                          | Legacy: create shell terminal                  |
| `session:open`              | `{ key?, cwd?, name? }`                                    | Open / create a pi session                     |
| `session:terminate`         | `key: string`                                               | Terminate a pi session                         |
| `session:delete`            | `key: string`                                               | Delete a single session                        |
| `session:deleteMany`        | `{ keys }`                                                  | Batch-delete sessions                          |
| `session:clearDirectory`    | `{ cwd }`                                                   | Clear all sessions under a directory            |
| `session:pickDirectory`     | —                                                           | Native folder picker                           |
| `session:debug`             | —                                                           | Pool diagnostics                               |
| `window:minimize`           | —                                                           | Minimize window                                |
| `window:toggle-maximize`    | —                                                           | Toggle maximize / restore                      |
| `window:close`              | —                                                           | Close window (hide, not quit)                  |
| `window:get-bounds`         | —                                                           | Read window geometry                           |
| `window:set-bounds`         | `{ x, y, width, height }`                                  | Set window geometry (resize zones)             |
| `window:open`               | —                                                           | Show/focus window (tray callback)              |
| `app:config:get`            | —                                                           | Get app config                                 |
| `app:config:set`            | `{ partial }`                                               | Update app config                              |
| `app:openExternal`          | `url: string`                                               | Open external URL in system browser            |
| `fs:openWithSystem`         | `absPath: string`                                           | Open file with system default app              |
| `fs:*`                      | (various)                                                   | File system bridge operations                  |
| `git:*`                     | (various)                                                   | Git operations (status, log, diff)             |
| `pi:settings:get`           | `scope: 'global' \| 'project'`                              | Read pi settings.json                          |
| `pi:settings:set`           | `{ scope, data?, raw? }`                                    | Write pi settings.json                         |
| `pi:models:get`             | —                                                           | Read pi models.json                            |
| `pi:models:set`             | `data`                                                      | Write pi models.json                           |
| `pi:mcp:configs`            | —                                                           | List MCP config files                          |
| `pi:mcp:configs:save`       | `{ id, config }`                                            | Save MCP config                                |
| `pi:mcp:status`             | —                                                           | Check pi-mcp-adapter installation status       |
| `pi:skills:list`            | —                                                           | List pi skills                                 |
| `pi:skills:enable`          | `name: string`                                              | Enable a skill                                 |
| `pi:skills:disable`         | `name: string`                                              | Disable a skill                                |
| `pi:skills:delete`          | `name: string`                                              | Delete a skill                                 |
| `pi:extensions:list`        | —                                                           | List pi extensions                             |

Main → Renderer:

| Channel                     | Payload                                                     | Description                                     |
|-----------------------------|-------------------------------------------------------------|-------------------------------------------------|
| `term:data`                 | `{ id, data }`                                              | PTY output bytes                                |
| `term:exit`                 | `{ id }`                                                    | Process exited                                  |
| `term:list`                 | `{ list }`                                                  | Terminal list changed                           |
| `session:status`            | `{ key, status }`                                           | Session status (drives green dot)               |
| `session:relink`            | `{ from, to }`                                              | Live session promoted to disk                   |
| `session:index`             | `{ groups }`                                                | Filesystem watch push (new sessions promoted)   |
| `window:maximize-change`    | `{ maximized }`                                             | Maximize state changed                          |
| `window:initial-config`     | `config`                                                    | Initial config (preload)                        |

## Environment Variables

| Variable                    | Purpose                                                          |
| --------------------------- | ---------------------------------------------------------------- |
| `PI_BIN`                    | Absolute path to the `pi` executable                             |
| `PI_DESKTOP_SESSIONS_DIR`   | Override `~/.pi/agent/sessions` (used by E2E)                   |
| `PI_DESKTOP_FAKE`           | Use the fake `pi` instead of the real one (E2E)                 |

## Configuration

The app stores its configuration at `~/pi-desktop/config.json`. Key settings:

- `theme` — `'dark'` or `'light'`
- `sidebarWidth` — sidebar width in pixels
- `rightPanelWidth` — right panel width in pixels
- `window.bounds` — window position & size (`{ x, y, width, height }`)
- `window.maximized` — whether the window is maximized
- `appWorkDir` — default workspace directory for integrated terminals
- `pinnedDirs` — sidebar-pinned directory list
- `closeAction` — close button behavior (`'hide'` or `'quit'`)
- `fontSize` — terminal font size

## Project Structure

```
pi-desktop/
├── src/
│   ├── main/                 # Electron main process
│   │   ├── index.ts          # App entry, IPC handlers, window/tray
│   │   ├── unifiedTerminalPool.ts   # Unified PTY pool (pi + shell)
│   │   ├── sessionPool.ts           # Legacy pi-only pool (kept for compat)
│   │   ├── sessionFileManager.ts    # Disk session file management
│   │   ├── integratedTerminalPool.ts # Legacy shell pool (kept for compat)
│   │   ├── config.ts                # Config parsing & merge (pure functions)
│   │   ├── backpressure.ts          # Source-level flow control
│   │   ├── windowState.ts           # Window geometry persistence
│   │   ├── fsBridge.ts              # File system IPC bridge
│   │   ├── gitBridge.ts             # Git operation IPC bridge
│   │   ├── shellProfiles.ts         # Detect terminal profiles
│   │   ├── shell-integration/       # VS Code shell integration scripts
│   │   │   ├── inject.ts            # Injection logic
│   │   │   ├── shellIntegration.ps1 # PowerShell integration
│   │   │   ├── shellIntegration-bash.sh
│   │   │   ├── shellIntegration.fish
│   │   │   ├── shellIntegration-rc.zsh
│   │   │   ├── shellIntegration-profile.zsh
│   │   │   ├── shellIntegration-env.zsh
│   │   │   └── shellIntegration-login.zsh
│   │   ├── assets/             # Icons
│   │   ├── fake-pi.mjs         # Fake pi for E2E tests
│   │   └── __tests__/          # Main process tests
│   ├── renderer/               # Electron renderer process
│   │   └── src/
│   │       ├── App.tsx              # Root React component
│   │       ├── components/
│   │       │   ├── Sidebar.tsx      # Session sidebar
│   │       │   ├── CenterPane.tsx   # Main content area (tabs)
│   │       │   ├── RightPanel.tsx   # File tree + Git
│   │       │   ├── TabBar.tsx       # DnD-reorderable tab bar
│   │       │   ├── SessionPane.tsx  # Pi session terminal host
│   │       │   ├── IntegratedPane.tsx # Shell terminal host
│   │       │   ├── XtermTerminal.ts # xterm.js wrapper class
│   │       │   ├── TitleBar.tsx     # Custom frameless title bar
│   │       │   ├── SettingsPanel.tsx # Settings UI (with Pi config)
│   │       │   ├── FileTree.tsx     # Project file tree
│   │       │   ├── FileIcons.tsx    # File type icons
│   │       │   ├── GitView.tsx      # Git status/log/diff
│   │       │   ├── DiffTab.tsx      # Diff viewer
│   │       │   ├── PreviewTab.tsx   # Markdown preview/editor
│   │       │   ├── MarkdownPreview.tsx    # Rendered Markdown
│   │       │   ├── RichMarkdownEditor.tsx # TipTap WYSIWYG
│   │       │   ├── MermaidBlock.tsx       # Mermaid diagram renderer
│   │       │   ├── ImagePreview.tsx       # Image viewer
│   │       │   ├── ContextMenu.tsx        # Right-click menu
│   │       │   ├── ConfirmDialog.tsx      # Confirmation dialog
│   │       │   ├── WindowResizeZones.tsx  # 8-direction resize
│   │       │   ├── paneManager.ts         # Pane lifecycle & channel abstraction
│   │       │   ├── terminalChannel.ts     # Data flow channel abstraction
│   │       │   ├── terminalDataBufferer.ts # Render-side 5ms write buffer
│   │       │   ├── terminalLinks.ts      # VS Code-style link detection
│   │       │   ├── terminalCapabilities.ts # Terminal capabilities model
│   │       │   ├── decorationAddon.ts    # VS Code-style decoration addon
│   │       │   ├── markNavigationAddon.ts # VS Code-style mark navigation
│   │       │   ├── terminalResizeDebouncer.ts # Axis-specific resize debounce
│   │       │   ├── tabGrouping.ts        # Tab auto-grouping logic
│   │       │   ├── sidebarGeometry.ts    # Sidebar/panel resize geometry
│   │       │   ├── icons.tsx             # SVG icon components
│   │       │   ├── editor/              # Markdown editor utilities
│   │       │   └── pi-settings/         # Pi config panel components
│   │       ├── store/
│   │       │   └── tabStore.ts          # Zustand tab store (multi-cwd)
│   │       ├── ipc.ts              # IPC client helpers
│   │       ├── theme.ts            # Theme management
│   │       ├── fontSize.ts         # Font size state
│   │       ├── types.ts            # Shared TypeScript types
│   │       └── lib/                # Utility modules
│   ├── preload/              # Electron preload script
│   └── shared/               # Shared constants/types
├── scripts/
│   └── copy-assets.mjs       # Asset copy script
├── electron-vite.config.ts
├── tsconfig.json
├── tsconfig.node.json
└── package.json
```

## License

See repository settings.
