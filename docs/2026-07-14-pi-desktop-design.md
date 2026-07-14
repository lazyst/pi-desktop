# Pi Desktop — 设计文档（Spec）

- **日期**：2026-07-14
- **状态**：已确认（brainstorming 设计阶段通过，待进入实现计划）
- **原型**：`pi-desktop/prototype.html`（静态 HTML mockup，仅验证布局/交互，不接真实 pi/PTY）

## 1. 目标与范围

构建一个**桌面应用**，用多个相互隔离的终端包装 `pi` CLI 的真 TUI，满足两个核心需求：

1. **左侧会话管理栏**：按目录（项目 cwd）分组展示 `pi` 会话；可新建目录（选真实文件夹）、新建会话；运行中会话显示绿点；hover 显示"终止会话"按钮。
2. **主会话区（终端 TUI）**：像普通终端一样展示 `pi` 的真 TUI。在一个会话里发出任务（prompt）后，切到别的会话时，**正在跑的任务不能断，必须继续执行**。

**范围内（v1）**：
- 单终端主区 + 侧栏切换（同时只显示一个终端）
- 侧栏按目录分组、绿点状态、hover 终止
- 新建目录（文件选择器选真实文件夹）/ 新建会话
- 任务续跑（切走不杀进程）
- 关闭应用杀掉所有运行进程；重启后侧栏只列会话文件（无绿点）

**范围外（v1 不做）**：
- 多终端分屏（split pane）
- 顶部标签页（tab）
- 应用内"默认模型"设置（直接用 pi 自身默认模型）
- 关闭应用后自动恢复在跑会话
- 结构化事件访问 / 自定义部件（终端是不透明字符流）

## 2. 技术栈与构建

- **框架**：Electron（主进程 Node + 渲染进程）
- **渲染进程**：React + TypeScript，Vite 构建/开发
- **终端渲染**：`@xterm/xterm` + `@xterm/addon-fit`（自动算列宽行高）
- **PTY**：`node-pty`（仅主进程；Windows 走 conpty）
- **安全**：渲染进程 `nodeIntegration:false`、`sandbox:true`；PTY 与进程管理只在主进程
- **无后端服务器**

## 3. 架构与数据流

```
主进程 SessionPool（唯一事实来源）
  ├─ Map<sessionKey, { pty, status:'running'|'dead', cwd, name }>
  ├─ spawn('pi') / kill / 转发 I/O
  ▲  IPC (ipcMain / ipcRenderer)
  │
渲染进程 (React)
  ├─ Sidebar    —— 按目录分组的会话树 + 绿点 + hover 终止 + 新建
  └─ TerminalPane —— xterm.js，按 sessionKey 显隐切换
```

- `sessionKey` = 会话文件绝对路径（新建会话用 pi 生成/返回的路径）。
- 主进程持有进程池；渲染进程只是视图，所有状态以主进程为准。

## 4. 会话模型与进程池（绿点/终止核心）

- **打开会话**：`pty.spawn('pi', args, { cwd, cols, rows, name: 'pi' })`
  - 续跑已有会话：`pi --session <sessionFile>`
  - 新建会话：`pi`（进程 cwd = 所选文件夹）；可选 `--name <name>`
  - 记录进 Map，`status='running'` → 侧栏该项显示绿点
- **切走**：不 kill，进程继续跑（任务续跑），绿点保留
- **终止（hover 按钮）**：`pty.kill()` → `status='dead'` → 绿点消失、终止按钮隐藏
- **关闭应用**：`SessionPool.killAll()` 杀掉所有 running 进程；重启后侧栏只列文件（全 dead）

## 5. 左侧栏

- **枚举**：读 `~/.pi/agent/sessions/`，顶层目录 = sanitized cwd（如 `--C--Users-hcz-.pi-agent--`），还原成真实路径作分组标题；其下每个 `<timestamp>_<uuid>.jsonl` 为一项。按文件 mtime 排序。
- **展示**：`真实路径 / 会话名(或时间戳)`，运行中项带绿点。
- **新建会话**：在当前选中分组（cwd）下开新 `pi`（spawn cwd=该文件夹），新项出现在该分组。
- **新建目录**：系统文件选择器选真实文件夹 → 作为新分组；可立即在其下开新会话。
- **hover 终止**：项 hover 显示"终止"按钮（仅 running 时），点 → IPC `session:terminate`。

## 6. 主区终端（xterm.js）

- 每个**已打开**会话持有一个 `Terminal` 实例，渲染在各自 `div`；切换 = 改 CSS `display`（显示当前、隐藏其他）。隐藏项仍收 PTY 数据（任务继续、缓冲保留），切回即见最新画面。
- **输入**：`Terminal.onData` → IPC `session:input` → 主进程 `pty.write()`
- **输出**：主进程 `pty.on('data')` → IPC `session:data` → 对应 `Terminal.write()`
- **Resize**：面板/`FitAddon` 算 cols/rows → 同时 `Terminal.resize()` 与 `pty.resize()`，pi TUI 才会重排
- **懒加载**：首次打开才创建 `Terminal`；关掉面板不销毁（保持进程/缓冲）

## 7. IPC 契约（主 ↔ 渲染）

渲染 → 主：
- `session:list` —— 请求会话列表
- `session:open{ key?, cwd?, name? }` —— 打开/新建会话
- `session:input{ key, data }` —— 终端按键
- `session:resize{ key, cols, rows }` —— 尺寸变化
- `session:terminate{ key }` —— 终止会话

主 → 渲染：
- `session:list{ groups }` —— 启动/变更时推送分组列表
- `session:data{ key, data }` —— PTY 输出字节
- `session:status{ key, status }` —— running / dead 变更（驱动绿点）
- `session:exit{ key }` —— 进程退出

## 8. 生命周期与边界情况

- 启动：主进程扫 sessions 目录 → 推 `session:list`；所有项默认 dead
- 打开不存在的会话文件 / spawn 失败：主进程回 `session:status{dead}` + 错误提示，不崩
- `pi` 首启 trust 弹窗：对未信任目录按 pi 默认行为；新建目录选的是用户主动选的文件夹，通常可信任（后续可加信任参数）
- 模型：用 pi 自身默认（不传 `--model`），无设置面板
- 多开：每个 running 会话一个 `pi` 进程，内存由用户自行控制

## 9. 验证方式

- **主进程单测**：`SessionPool` 的 spawn / kill / status（mock `node-pty`）
- **手动 E2E**：
  1. 启动 app → 新建目录 + 会话
  2. 发一个长任务 → 切到另一个会话（任务继续、绿点保留）
  3. 切回看到任务仍在跑
  4. hover 终止 → 绿点消失
  5. 关闭 app 再开，侧栏列文件但无绿点

## 10. 风险与对策

- `node-pty` 原生模块在 Windows 需构建工具/noble 预编译——安装时确认预编译可用，必要时 `npm install --build-from-source` + VS Build Tools。
- 隐藏终端长期收数据导致滚动缓冲增长——v1 接受（用户自行控制开几个）；后续可限制 scrollback。
- xterm 在隐藏时 resize 可能错位——切回时主动触发一次 `fit()` + `pty.resize()`。
