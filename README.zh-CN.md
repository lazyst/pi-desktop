# pi-desktop

一款桌面应用：把 [`pi`](https://github.com) CLI 的**真实终端界面（TUI）**封装进多个相互隔离的终端，并通过侧边栏式的会话列表与基于工作区的 Tab 系统进行管理。

基于 Electron、React 与 xterm.js 构建。每个会话都是一个真实的 `node-pty` 进程在运行 `pi`，因此你看到的是**原汁原味的 `pi` TUI**，而非重新实现。此外还支持集成 shell 终端（bash、zsh、powershell、fish），并注入 VS Code 风格的 shell integration 脚本。

## 功能特性

### Pi 会话

- **多个隔离的 pi 终端** —— 每个会话一个真实的 `pi` 进程，各自拥有独立的终端面板。
- **侧边栏会话管理** —— 会话按工作目录（项目 `cwd`）分组展示，运行中的会话显示绿点，hover 显示「终止」按钮，右键弹出上下文菜单。
- **新建目录 / 新建会话** —— 选择真实文件夹，或在任意分组下启动一个新的 `pi` 会话。
- **清空目录下会话** —— 组 header 的「🗑 清空」图标：一键终止该目录下所有运行中的进程并删除其对应的全部 `.jsonl` 文件，整组从侧边栏消失。
- **批量删除会话** —— 侧边栏「管理」进入多选模式，每条会话出现勾选框，可跨目录任意多选；顶部显示「已选 N 项 · 删除 · 取消」，确认后批量终止并删除。
- **删除单个会话** —— 右键会话 →「删除会话」，弹窗确认后终止进程并删除其 `.jsonl` 文件。
- **切换不杀进程** —— 切到别的会话时，上一个会话的进程在后台**继续运行**，绿点保留；切回时**复用同一个仍在运行的进程**（瞬时切换，不重启）。
- **未保存会话** —— 尚未写入磁盘（首次输入前）的会话在目录列表顶部显示为"unsaved"条目。

### 集成 Shell 终端

- **通用 Shell 终端** —— 可在任意工作区直接启动 bash、zsh、powershell、fish 或 cmd.exe，与 pi 会话分离。
- **VS Code 风格 Shell Integration** —— 自动注入 shell integration 脚本（bash、zsh、fish、powershell），通过 `--init-file` / `-command` / `ZDOTDIR` 实现，支持 OSC 633 序列的命令追踪与 cwd 检测。
- **基于 Tab 的多终端** —— 每个工作目录拥有独立的 tab 条，可同时管理多个 shell 终端、pi 会话、diff 和预览。

### 工作区与 Tab 系统

- **多目录 Tab 分组** —— Tab（会话、终端、diff、预览）按工作目录分组，每个目录拥有独立的 tab 条和激活状态。
- **拖拽重排 Tab** —— 通过 `@dnd-kit` 支持在同一目录内拖拽重排 tab 顺序。
- **Keep-alive** —— 切走 tab 时内容被隐藏（CSS `display`），但进程和实例不销毁；切回时瞬时恢复。
- **右栏面板** —— 可调整宽度的右栏，包含**文件树**（项目文件浏览器）和 **Git**（状态 / 日志 / diff）两个标签页，取代旧版 FilePanel。

### 编辑器与预览

- **Markdown 三种模式**：
  - **渲染预览**：完整的 `react-markdown` 渲染管线，集成 `remark-gfm`、`remark-math`、`rehype-highlight`、`rehype-katex`，并支持嵌入式 `mermaid` 图表渲染。
  - **富文本（所见即所得）**：基于 TipTap 的编辑器，支持 GFM 表格、任务列表、图片、链接。
  - **源码编辑**：基于 Monaco 编辑器的源码模式。
- **Diff 查看器** —— 自定义单文件 diff 视图（替代 MonacoDiffEditor），支持 Git 工作区变更和提交 diff。
- **图片预览** —— 内置图片查看器。

### 终端体验

- **VS Code 风格可点击链接** —— 终端中的 URL 和文件路径被检测为可点击链接（Ctrl+click 打开）。支持 OSC 8 超链接、`file:path:line:col` 格式以及 hover 工具提示。
- **终端搜索（Find Widget）** —— 在终端输出中搜索（支持区分大小写、正则、全词匹配模式）。
- **全选 / 复制 / 粘贴** —— 通过 `@xterm/addon-clipboard` 实现完整的剪贴板集成。
- **滚动位置保留** —— 每个面板的滚动状态在切 tab 时保存，切回时恢复。
- **「跳到底部」浮钮** —— 向上滚动时出现，点击跳到最新输出。

### 背压与流控

- **源头背压** —— `BackpressureController` 在高水位暂停 PTY（`pty.pause()`），在低水位恢复（`pty.resume()`），对齐 VS Code 的 `TerminalProcess` 流控。
- **双段缓冲** —— 主进程端（5ms 时间窗聚合）和渲染端（5ms 写防抖）分别缓冲 PTY 输出后再转发/写入，消除流式高频重绘的中间帧闪烁。
- **IPC Ack 批量** —— `AckDataBufferer` 累积消费字节数，按可配置间隔批量发送 IPC，避免每次 write 回调都触发 IPC 开销。

### 窗口与 UI

- **无边框窗口** —— 移除了原生菜单条与系统标题条，改用自建标题条（应用名 + 设置齿轮 + 最小化 / 最大化 / 关闭），其配色随当前主题变化。
- **8 向缩放热区** —— 自建边缘缩放区域，补回无边框所丢失的原生边缘缩放能力。
- **亮色 / 暗色主题** —— 内置 GitHub 风格暗色与亮色两套主题；标题条右侧的齿轮按钮打开「设置」面板即可切换，选择记忆在 `localStorage`，重启后保留。
- **系统托盘** —— 常驻托盘图标，右键菜单「显示 / 退出」，双击显示窗口。
- **白闪修复** —— 使用透明桥接技术（`setOpacity(0)` → show → `setOpacity(1)`），防止 Windows 无边框暗色窗口显示时出现一瞬白屏。
- **窗口状态持久化** —— 窗口位置、大小、最大化状态保存至 `config.json`，下次启动时恢复。
- **单实例锁** —— 防止启动多个应用实例。

### 设置面板

- **常规** —— 主题、关闭按钮行为。
- **会话管理** —— 展示全部磁盘会话（按目录分组），支持单条删除、清空目录、批量删除。
- **终端** —— 字体大小配置。
- **Pi 配置** —— 集成 pi-tool 的配置管理功能：
  - **配置文件** —— 编辑 `~/.pi/agent/settings.json`（全局/项目）。
  - **模型配置** —— 编辑 `~/.pi/agent/models.json`（提供方与模型）。
  - **MCP 管理** —— 管理多层 MCP 配置（用户全局、Pi 全局、项目共享、项目 Pi）。
  - **Skills 管理** —— 列出、启用、禁用、删除 pi agent skills。
  - **扩展管理** —— 从 `~/.pi/agent/settings.json` 列出已安装扩展。

### 安全与沙箱

- **安全清理** —— 关闭应用会杀掉所有运行中的 `pi` 和 shell 进程。
- **渲染进程沙箱化** —— `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`。所有进程 / PTY 管理只在主进程，渲染进程纯做视图。
- **文件系统桥** —— 所有文件 I/O 通过 `fsBridge` IPC 处理，带根目录边界检查。
- **外部 URL 安全** —— 通过 `exec()` 而非 `shell.openExternal` 打开外部链接，避免 Electron 30+ 的安全确认对话框。
- **Shell Integration 安全** —— 注入脚本使用每会话 nonce 和权限受限的临时目录。

## 技术栈

| 层级       | 选型                                                                    |
| ---------- | ----------------------------------------------------------------------- |
| 外壳       | Electron 32 + electron-vite                                             |
| 主进程     | Node + `node-pty`（Windows 走 conpty）+ TypeScript                      |
| 渲染进程   | React 18 + TypeScript + Vite                                            |
| 状态管理   | Zustand                                                                 |
| 终端       | `@xterm/xterm`@6 + `@xterm/addon-webgl` + `@xterm/addon-fit` + `@xterm/addon-search` + `@xterm/addon-clipboard` + `@xterm/addon-unicode11` + `@xterm/addon-serialize` |
| Markdown   | `react-markdown` + `remark-gfm` / `remark-math` + `rehype-highlight` / `rehype-katex` |
| 富文本     | TipTap 3 + `tiptap-markdown`                                            |
| 代码编辑器 | Monaco Editor（`@monaco-editor/react`）                                 |
| 图表       | Mermaid                                                                 |
| 拖拽       | `@dnd-kit/core` + `@dnd-kit/sortable`                                   |
| 测试       | Vitest（单元）+ Playwright（E2E，真实 Electron）                         |
| 打包       | electron-builder（NSIS / DMG / AppImage）                                |

## 环境依赖

- **Node.js**（本仓库用 `mise` 管理）与 **pnpm**
- 你的 `PATH` 中需有 **`pi` CLI**（或用 `PI_BIN` 指定其绝对路径）
- **`node-pty`** 原生构建工具：
  - Windows：Visual Studio 生成工具（或直接使用预编译二进制）
  - macOS / Linux：可用的 C/C++ 工具链

> 应用在运行时解析 `pi` 可执行文件（以及 `pi` 启动脚本所用的 `node`，包含常见的 pnpm 全局 bin 路径），
> 因此即使以双击 `.exe` 方式启动、未继承用户 shell 的 `PATH`，也能正常找到。

## 快速开始

```bash
pnpm install

# 开发模式（Electron + Vite HMR）
pnpm dev

# 生产构建
pnpm build

# 预览构建产物
pnpm start

# 类型检查（node + renderer）
pnpm typecheck

# 构建可分发包（平台默认）
pnpm dist

# 构建 Windows NSIS 安装程序（非一键安装）
pnpm dist:win
```

## 测试

```bash
# 单元测试（SessionPool、React 组件）—— 快速，无需显示环境
pnpm test

# 监听模式
pnpm test:watch

# 端到端测试（通过 Playwright 启动真实 Electron 应用）
pnpm test:e2e
```

E2E 使用一个假的 `pi`（`PI_DESKTOP_FAKE=1`，见 `src/main/fake-pi.mjs`）：它打印心跳信号，并在首次收到输入时写出一个真实的 `.jsonl` 文件，
从而可以在**不需要凭据或模型**的情况下，演练「文件系统 → 侧边栏晋升」的完整流程。

## 架构

### 主进程

主进程管理两大核心模块：

- **`UnifiedTerminalPool`**（`src/main/unifiedTerminalPool.ts`）—— 所有终端进程的唯一事实来源，统一了 pi 会话（`command === 'pi'`）和集成 shell 终端（`command === undefined`）。负责创建、写入、调整尺寸、销毁、全杀、背压控制以及文件系统到 live 会话的关联（reconcile）。
- **`SessionFileManager`**（`src/main/sessionFileManager.ts`）—— 管理磁盘上的 `.jsonl` 会话文件：列出、删除、清空目录、从首条用户消息解析会话名。

```
主进程
  ├─ UnifiedTerminalPool（统一 PTY 池）
  │   ├─ pi 会话：    spawn('pi', ['--session', file|'--name', name])
  │   │   id = 'live-<uuid>'
  │   ├─ shell 终端：  spawn(shell, [注入后的参数])
  │   │   id = 'term-<uuid>'
  │   └─ 每实例自带 BackpressureController（暂停/恢复）
  ├─ SessionFileManager（磁盘 .jsonl 管理）
  ├─ config.json 持久化（防抖写盘）
  ├─ 系统托盘（常驻）
  └─ 窗口状态管理
      ▲  IPC（ipcMain / ipcRenderer）
      │
渲染进程（React）
  ├─ TitleBar          —— 自建无边框标题栏 + 主题感知配色
  ├─ Sidebar           —— 按 cwd 分组的会话树 + 绿点 + 右键菜单
  │                       + 目录置顶 + 多选批量删除
  ├─ CenterPane        —— Tab 条（每 cwd 独立）+ Tab 内容（keep-alive）
  │   ├─ SessionPane   —— pi 会话终端宿主
  │   ├─ IntegratedPane—— shell 终端宿主
  │   ├─ PreviewTab    —— Markdown 预览/编辑器（3 种模式）
  │   └─ DiffTab       —— Git diff 查看器
  ├─ RightPanel        —— 文件树 + Git（可调宽度）
  └─ SettingsPanel     —— 常规 / 会话管理 / 终端 / Pi 配置
                          （模型、MCP、Skills、扩展）
```

### 数据流

- **`sessionKey`** —— 会话 `.jsonl` 文件的绝对路径（新建会话使用 `pi` 生成的 key，如 `live-<uuid>`）。无磁盘文件的 live 会话直接使用 `live-<uuid>`。
- **打开 / 重新打开** —— `session:open{ key?, cwd?, name? }`。打开一个基于磁盘文件的会话时，**复用**该文件对应的、已在运行的进程（**不会**再 spawn 一个重复的），因此切回是瞬时的、且任务持续运行；若该进程已退出，则在打开时重新启动。对于 shell 终端，使用 `terminal:spawn{ command: undefined, cwd, profile }`。
- **切走** —— 终端面板被隐藏（CSS `display`），但仍持续接收 PTY 数据，缓冲区得以保留、任务继续。
- **输入** —— `Terminal.onData` → `terminal:input` → `pty.write`。
- **输出** —— `pty.on('data')` → 主进程 5ms 聚合窗口 → `terminal:data` → XtermTerminal 5ms 写防抖 → `term.write()`。双段缓冲消除流式高频重绘的中间帧闪烁。
- **背压** —— 每 PTY 的输出字节在源头（`pty.on('data'）`）立即计数，入缓冲之前。高水位时暂停 PTY（`pty.pause()`）；收到渲染端 IPC ack（`terminal:ack`）后计数下降，低水位时恢复 PTY（`pty.resume()`）。
- **尺寸变化** —— `FitAddon` 计算 `cols` / `rows`，随后**同时**调用 `Terminal.resize()` 与 `pty.resize()`，这样 `pi` 的 TUI 才会重新排版。
- **终端通道抽象** —— `TerminalChannel` 将数据流与全局 API 引用解耦。`PaneManager` 在获取终端面板时根据类型（session / integrated）选择正确的通道。
- **Shell Integration** —— 为 bash、zsh、fish、powershell 自动注入 VS Code shell integration 脚本（通过 `--init-file`、`-command`、`ZDOTDIR` 覆盖）。支持 OSC 633 序列解析以实现命令开始/结束标记和自动 cwd 追踪（`updateCwd` IPC）。

### IPC 契约

渲染进程 → 主进程：

| 通道                        | 载荷                                                     | 说明                              |
|-----------------------------|----------------------------------------------------------|-----------------------------------|
| `terminal:spawn`            | `{ command?, cwd, profile?, sessionFile?, name?, key? }`| 创建终端（pi 或 shell）           |
| `terminal:input`            | `{ id, data }`                                           | 键盘输入到 PTY                   |
| `terminal:resize`           | `{ id, cols, rows }`                                     | 调整 PTY 尺寸                    |
| `terminal:ack`              | `{ id, bytes }`                                          | 背压确认（渲染端已消费 N 字节）  |
| `terminal:destroy`          | `id: string`                                             | 销毁 shell 终端                  |
| `terminal:saveBuffer`       | `{ id, data }`                                           | 保存滚动缓冲快照                  |
| `terminal:loadBuffer`       | `id: string`                                             | 加载滚动缓冲快照                  |
| `terminal:updateCwd`        | `{ id, cwd }`                                            | Shell integration cwd 更新       |
| `terminal:listProfiles`     | —                                                        | 列出可用 shell profile           |
| `terminal:list`             | —                                                        | 列出所有终端实例                  |
| `terminal:create`           | `{ profile, cwd }`                                       | 旧版：创建 shell 终端            |
| `session:open`              | `{ key?, cwd?, name? }`                                  | 打开 / 新建 pi 会话              |
| `session:terminate`         | `key: string`                                            | 终止 pi 会话                     |
| `session:delete`            | `key: string`                                            | 删除单个会话                      |
| `session:deleteMany`        | `{ keys }`                                               | 批量删除会话                      |
| `session:clearDirectory`    | `{ cwd }`                                                | 清空某目录下全部会话              |
| `session:pickDirectory`     | —                                                        | 原生文件夹选择器                  |
| `session:debug`             | —                                                        | 进程池诊断信息                    |
| `window:minimize`           | —                                                        | 最小化窗口                        |
| `window:toggle-maximize`    | —                                                        | 切换最大化 / 还原                 |
| `window:close`              | —                                                        | 关闭窗口（隐藏，非退出）          |
| `window:get-bounds`         | —                                                        | 读取窗口几何                      |
| `window:set-bounds`         | `{ x, y, width, height }`                                | 设置窗口几何（缩放热区用）        |
| `window:open`               | —                                                        | 显示/聚焦窗口（托盘回调）         |
| `app:config:get`            | —                                                        | 获取应用配置                      |
| `app:config:set`            | `{ partial }`                                            | 更新应用配置                      |
| `app:openExternal`          | `url: string`                                            | 在系统浏览器中打开外部 URL        |
| `fs:openWithSystem`         | `absPath: string`                                        | 用系统默认程序打开文件            |
| `fs:*`                      |（多种）                                                   | 文件系统桥操作                    |
| `git:*`                     |（多种）                                                   | Git 操作（状态/日志/diff）        |
| `pi:settings:get`           | `scope: 'global' \| 'project'`                           | 读取 pi settings.json             |
| `pi:settings:set`           | `{ scope, data?, raw? }`                                  | 写入 pi settings.json             |
| `pi:models:get`             | —                                                        | 读取 pi models.json               |
| `pi:models:set`             | `data`                                                   | 写入 pi models.json               |
| `pi:mcp:configs`            | —                                                        | 列出 MCP 配置文件                |
| `pi:mcp:configs:save`       | `{ id, config }`                                         | 保存 MCP 配置                    |
| `pi:mcp:status`             | —                                                        | 检查 pi-mcp-adapter 安装状态     |
| `pi:skills:list`            | —                                                        | 列出 pi skills                   |
| `pi:skills:enable`          | `name: string`                                           | 启用 skill                       |
| `pi:skills:disable`         | `name: string`                                           | 禁用 skill                       |
| `pi:skills:delete`          | `name: string`                                           | 删除 skill                       |
| `pi:extensions:list`        | —                                                        | 列出 pi 扩展                     |

主进程 → 渲染进程：

| 通道                        | 载荷                                                     | 说明                              |
|-----------------------------|----------------------------------------------------------|-----------------------------------|
| `term:data`                 | `{ id, data }`                                           | PTY 输出字节                     |
| `term:exit`                 | `{ id }`                                                 | 进程退出                          |
| `term:list`                 | `{ list }`                                               | 终端列表变更                      |
| `session:status`            | `{ key, status }`                                        | 会话状态（驱动绿点）              |
| `session:relink`            | `{ from, to }`                                           | Live 会话晋升到磁盘               |
| `session:index`             | `{ groups }`                                             | 文件系统监听推送（新会话晋升）    |
| `window:maximize-change`    | `{ maximized }`                                          | 最大化状态变化                    |
| `window:initial-config`     | `config`                                                 | 初始配置（preload）               |

## 环境变量

| 变量                        | 用途                                              |
| --------------------------- | ------------------------------------------------- |
| `PI_BIN`                   | `pi` 可执行文件的绝对路径                          |
| `PI_DESKTOP_SESSIONS_DIR`  | 覆盖 `~/.pi/agent/sessions`（E2E 使用）           |
| `PI_DESKTOP_FAKE`          | 使用假的 `pi` 替代真实的（E2E 使用）              |

## 配置

应用配置存储在 `~/pi-desktop/config.json`。关键配置项：

- `theme` —— `'dark'` 或 `'light'`
- `sidebarWidth` —— 侧边栏宽度（像素）
- `rightPanelWidth` —— 右栏宽度（像素）
- `window.bounds` —— 窗口位置和大小（`{ x, y, width, height }`）
- `window.maximized` —— 窗口是否最大化
- `appWorkDir` —— 集成终端的默认工作目录
- `pinnedDirs` —— 侧边栏置顶目录列表
- `closeAction` —— 关闭按钮行为（`'hide'` 或 `'quit'`）
- `fontSize` —— 终端字体大小

## 项目结构

```
pi-desktop/
├── src/
│   ├── main/                 # Electron 主进程
│   │   ├── index.ts          # 应用入口、IPC 处理、窗口/托盘
│   │   ├── unifiedTerminalPool.ts   # 统一 PTY 池（pi + shell）
│   │   ├── sessionPool.ts           # 旧版仅 pi 池（保留兼容）
│   │   ├── sessionFileManager.ts    # 磁盘会话文件管理
│   │   ├── integratedTerminalPool.ts # 旧版 shell 池（保留兼容）
│   │   ├── config.ts                # 配置解析与合并（纯函数）
│   │   ├── backpressure.ts          # 源头流控
│   │   ├── windowState.ts           # 窗口几何持久化
│   │   ├── fsBridge.ts              # 文件系统 IPC 桥
│   │   ├── gitBridge.ts             # Git 操作 IPC 桥
│   │   ├── shellProfiles.ts         # 检测终端 profile
│   │   ├── shell-integration/        # VS Code shell integration 脚本
│   │   │   ├── inject.ts            # 注入逻辑
│   │   │   ├── shellIntegration.ps1 # PowerShell integration
│   │   │   ├── shellIntegration-bash.sh
│   │   │   ├── shellIntegration.fish
│   │   │   ├── shellIntegration-rc.zsh
│   │   │   ├── shellIntegration-profile.zsh
│   │   │   ├── shellIntegration-env.zsh
│   │   │   └── shellIntegration-login.zsh
│   │   ├── assets/             # 图标
│   │   ├── fake-pi.mjs         # E2E 测试用假 pi
│   │   └── __tests__/          # 主进程测试
│   ├── renderer/               # Electron 渲染进程
│   │   └── src/
│   │       ├── App.tsx              # 根 React 组件
│   │       ├── components/
│   │       │   ├── Sidebar.tsx      # 会话侧边栏
│   │       │   ├── CenterPane.tsx   # 主内容区域（tab）
│   │       │   ├── RightPanel.tsx   # 文件树 + Git
│   │       │   ├── TabBar.tsx       # 可拖拽重排的 tab 条
│   │       │   ├── SessionPane.tsx  # Pi 会话终端宿主
│   │       │   ├── IntegratedPane.tsx # Shell 终端宿主
│   │       │   ├── XtermTerminal.ts # xterm.js 封装类
│   │       │   ├── TitleBar.tsx     # 自建无边框标题条
│   │       │   ├── SettingsPanel.tsx # 设置 UI（含 Pi 配置）
│   │       │   ├── FileTree.tsx     # 项目文件树
│   │       │   ├── FileIcons.tsx    # 文件类型图标
│   │       │   ├── GitView.tsx      # Git 状态/日志/diff
│   │       │   ├── DiffTab.tsx      # Diff 查看器
│   │       │   ├── PreviewTab.tsx   # Markdown 预览/编辑器
│   │       │   ├── MarkdownPreview.tsx    # 渲染版 Markdown
│   │       │   ├── RichMarkdownEditor.tsx # TipTap 所见即所得
│   │       │   ├── MermaidBlock.tsx       # Mermaid 图表渲染
│   │       │   ├── ImagePreview.tsx       # 图片查看器
│   │       │   ├── ContextMenu.tsx        # 右键菜单
│   │       │   ├── ConfirmDialog.tsx      # 确认对话框
│   │       │   ├── WindowResizeZones.tsx  # 8 向缩放区域
│   │       │   ├── paneManager.ts         # 面板生命周期 & 通道抽象
│   │       │   ├── terminalChannel.ts     # 数据流通道抽象
│   │       │   ├── terminalDataBufferer.ts # 渲染端 5ms 写缓冲
│   │       │   ├── terminalLinks.ts      # VS Code 风格链接检测
│   │       │   ├── terminalCapabilities.ts # 终端能力模型
│   │       │   ├── decorationAddon.ts    # VS Code 风格装饰
│   │       │   ├── markNavigationAddon.ts # VS Code 风格标记导航
│   │       │   ├── terminalResizeDebouncer.ts # 分轴 resize 防抖
│   │       │   ├── tabGrouping.ts        # Tab 自动分组逻辑
│   │       │   ├── sidebarGeometry.ts    # 侧边栏/面板缩放几何
│   │       │   ├── icons.tsx             # SVG 图标组件
│   │       │   ├── editor/              # Markdown 编辑器工具
│   │       │   └── pi-settings/         # Pi 配置面板组件
│   │       ├── store/
│   │       │   └── tabStore.ts          # Zustand tab 存储（多 cwd）
│   │       ├── ipc.ts              # IPC 客户端助手
│   │       ├── theme.ts            # 主题管理
│   │       ├── fontSize.ts         # 字体大小状态
│   │       ├── types.ts            # 共享 TypeScript 类型
│   │       └── lib/                # 工具模块
│   ├── preload/              # Electron preload 脚本
│   └── shared/               # 共享常量/类型
├── scripts/
│   └── copy-assets.mjs       # 资源拷贝脚本
├── electron-vite.config.ts
├── tsconfig.json
├── tsconfig.node.json
└── package.json
```

## 许可证

详见仓库设置。
