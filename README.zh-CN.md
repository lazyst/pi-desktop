# pi-desktop

一款桌面应用：把 [`pi`](https://github.com) CLI 的**真实终端界面（TUI）**封装进多个相互隔离的终端，并通过侧边栏式的会话列表进行管理。

基于 Electron、React 与 xterm.js 构建。每个会话都是一个真实的 `node-pty` 进程在运行 `pi`，因此你看到的是**原汁原味的 `pi` TUI**，而非重新实现。

## 功能特性

- **多个隔离终端** —— 每个会话一个真实的 `pi` 进程，各自拥有独立的终端面板。
- **侧边栏会话管理** —— 会话按工作目录（项目 `cwd`）分组展示，运行中的会话显示绿点，hover 显示「终止」按钮。
- **新建目录 / 新建会话** —— 选择真实文件夹，或在任意分组下启动一个新的 `pi` 会话。
- **清空目录下会话** —— 组 header 的「🗑 清空」图标：一键终止该目录下所有运行中的进程并删除其对应的全部 `.jsonl` 文件，整组从侧边栏消失。
- **批量删除会话** —— 侧边栏「管理」进入多选模式，每条会话出现勾选框，可跨目录任意多选；顶部显示「已选 N 项 · 删除 · 取消」，确认后批量终止并删除。
- **删除单个会话** —— 右键会话 →「删除会话」，弹窗确认后终止进程并删除其 `.jsonl` 文件。
- **切换不杀进程** —— 切到别的会话时，上一个会话的进程在后台**继续运行**，绿点保留；切回时**复用同一个仍在运行的进程**（瞬时切换，不重启）。
- **亮色 / 暗色主题** —— 内置 GitHub 风格暗色与亮色两套主题；标题条右侧的齿轮按钮打开「设置」面板即可切换，选择记忆在 `localStorage`，重启后保留。
- **无边框窗口** —— 移除了原生菜单条与系统标题条，改用自建标题条（应用名 + 最小化 / 最大化 / 关闭），其配色随当前主题变化；无边框所丢失的原生边缘缩放，由自建的 8 向缩放热区补回。
- **安全清理** —— 关闭应用会杀掉所有运行中的 `pi` 进程。
- **渲染进程沙箱化** —— `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`。所有进程 / PTY 管理只在主进程，渲染进程纯做视图。

## 技术栈

| 层级       | 选型                                             |
| ---------- | ------------------------------------------------ |
| 外壳       | Electron                                          |
| 主进程     | Node + `node-pty`（Windows 走 conpty）          |
| 渲染进程   | React + TypeScript（Vite / electron-vite）       |
| 终端       | `@xterm/xterm` + `@xterm/addon-fit`             |
| 测试       | Vitest（单元）+ Playwright（E2E，真实 Electron）|

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
```

## 测试

```bash
# 单元测试（SessionPool、React 组件）—— 快速，无需显示环境
pnpm test

# 端到端测试（通过 Playwright 启动真实 Electron 应用）
pnpm test:e2e
```

E2E 使用一个假的 `pi`（`PI_DESKTOP_FAKE=1`，见 `src/main/fake-pi.mjs`）：它打印心跳信号，并在首次收到输入时写出一个真实的 `.jsonl` 文件，
从而可以在**不需要凭据或模型**的情况下，演练「文件系统 → 侧边栏晋升」的完整流程。

## 架构

```
主进程 —— SessionPool（唯一事实来源）
  ├─ Map<sessionKey, { pty, status: 'running' | 'dead', cwd, name }>
  ├─ spawn('pi') / kill / 转发 I/O
  ▲  IPC（ipcMain / ipcRenderer）
  │
渲染进程（React）
  ├─ Sidebar      —— 按 cwd 分组的会话树 + 绿点 + hover 终止 + 清空/多选批量删除
  └─ TerminalPane —— 每个已打开会话一个 xterm.js，按 `active` 显隐
```

- **`sessionKey`** = 会话 `.jsonl` 文件的绝对路径（新建会话使用 `pi` 生成的 key，如 `live-<uuid>`）。
- **打开 / 重新打开** —— `session:open{ key?, cwd?, name? }`。打开一个基于磁盘文件的会话时，
  **复用**该文件对应的、已在运行的进程（**不会**再 spawn 一个重复的），因此切回是瞬时的、且任务持续运行；
  若该进程已退出，则在打开时重新启动。
- **切走** —— 终端面板被隐藏（CSS `display`），但仍持续接收 PTY 数据，缓冲区得以保留、任务继续。
- **输入** —— `Terminal.onData` → `session:input` → `pty.write`。
- **输出** —— `pty.on('data')` → `session:data` → `Terminal.write`。
- **尺寸变化** —— `FitAddon` 计算 `cols` / `rows`，随后**同时**调用 `Terminal.resize()` 与 `pty.resize()`，
  这样 `pi` 的 TUI 才会重新排版。

### IPC 契约

渲染进程 → 主进程：

- `session:list` —— 请求会话分组列表
- `session:open{ key?, cwd?, name? }` —— 打开 / 新建会话
- `session:input{ key, data }` —— 终端按键
- `session:resize{ key, cols, rows }` —— 尺寸变化
- `session:terminate{ key }` —— 终止会话
- `session:delete{ key }` —— 删除单个会话（杀进程 + 删 `.jsonl`）
- `session:deleteMany{ keys }` —— 批量删除多个会话（杀进程 + 删文件）
- `session:clearDirectory{ cwd }` —— 清空某目录下全部会话（杀进程 + 删文件）
- `session:pickDirectory` —— 原生文件夹选择器
- `session:debug` —— 进程池诊断信息（进程数 / pid）
- `window:minimize` —— 最小化窗口
- `window:toggle-maximize` —— 切换最大化 / 还原
- `window:close` —— 关闭窗口
- `window:get-bounds` —— 读取窗口几何（`{ x, y, width, height }`）
- `window:set-bounds` —— 设置窗口几何（自建边缘缩放热区用）

主进程 → 渲染进程：

- `session:list{ groups }` —— 启动 / 变更时推送分组列表
- `session:data{ key, data }` —— PTY 输出字节
- `session:status{ key, status }` —— `running` / `dead`（驱动绿点）
- `session:exit{ key }` —— 进程退出
- `session:index{ groups }` —— 文件系统监听推送（新会话晋升进侧边栏）
- `window:maximize-change{ maximized }` —— 窗口最大化状态变化（驱动标题条最大化 / 还原图标）

## 环境变量

| 变量                        | 用途                                         |
| --------------------------- | -------------------------------------------- |
| `PI_BIN`                   | `pi` 可执行文件的绝对路径                    |
| `PI_DESKTOP_SESSIONS_DIR`  | 覆盖 `~/.pi/agent/sessions`（E2E 使用）     |
| `PI_DESKTOP_FAKE`          | 使用假的 `pi` 替代真实的（E2E 使用）      |

## 许可证

详见仓库设置。
