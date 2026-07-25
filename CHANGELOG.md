# Changelog

## [0.3.0] — 2025-07

### 新增

- **终端设置面板新增 12 项可配置项**（按类别分组）：
  - **光标**：cursorBlink（闪烁开关）、cursorStyle（block/bar/underline）、cursorInactiveStyle（非活跃样式）、cursorWidth（1-25px）
  - **字体**：fontFamily（文本输入 + 8 种常用等宽字体预设）、lineHeight（0.5-3.0）、letterSpacing（-5~20px）、fontWeight / fontWeightBold（9 级字重）
  - **滚动**：smoothScrolling（平滑滚动开关）、scrollSensitivity（0.1-20）、fastScrollSensitivity（1-100）
  - **滚动条**：scrollbarWidth（6-40px）
  - 所有配置项修改后即时生效到所有存活终端，新建终端自动读取持久化值

### 修复

- 设置面板终端页内容区无法滚动（`overflow:hidden` → `overflow-y:auto`）
- 数字输入框布局居中问题（输入框+单位包裹为 `input-unit-group`，靠右对齐）

---

## [0.2.1] — 2025-07

## [0.2.0] — 2025-07

### 新增

- **终端背压流控全面对齐 VS Code**：
  - 背压计数时点从 5ms 聚合窗口移至 PTY 源头实时计数
  - IPC ack 累积（`AckDataBufferer`，`CharCountAckSize=5000`），减少高频 IPC 通信量
  - 同步写模式（`writeSync`），高优先级消息不受背压阻塞
- **目录分组折叠**：左侧栏目录分组可折叠，折叠状态持久化到 config
- **会话内容查看**：会话管理面板支持查看 Pi 会话完整内容
- **Pi 工具配置管理**：集成到设置面板

### 修复

- 目录分组操作按钮改为绝对定位，不占用标题行空间
- `_writeProcessDataUnsafe` 对齐 VS Code 发送 ack，背压水位准确

---

## [0.1.1] — 2025-07

### 新增

- **终端深度对齐 VS Code 集成终端**：
  - 命令检测（CommandDetectionCapability，OSC 633 序列）
  - CWD 检测（CwdDetectionCapability）
  - 链接检测与打开（OSC 8 超链接、文件路径、编辑器打开）
  - 查找（SearchAddon）
  - 缓冲区持久化
  - 滚动稳定与 scrollback 可配置
  - 标记导航（MarkNavigationAddon）
- **设置面板**：常规（主题、关闭行为、字号）、会话管理、终端配置

### 修复

- 终端链接交互：修饰键激活、hover 装饰、文件协议处理
- 安全对话框绕过：改用 `child_process.exec` 打开外部 URL
- 多次 revert 后重新稳定链接交互

---

## [0.1.0] — 2025-06

### 新增

- **集成终端（VS Code 式）**：
  - XtermTerminal 薄封装，对齐 VS Code 装配（WebGL 渲染、FitAddon、SearchAddon、ClipboardAddon）
  - 按工作目录分组 + 计数徽标
  - 应用工作目录分组（收容无关会话）
  - 外部拖入文件转绝对路径粘贴
  - 右键复制/粘贴
  - 置底按钮（Jump-to-bottom FAB）
  - 平滑滚动
- **编辑器**：
  - Monaco 编辑器集成（Markdown 渲染预览 + 源码编辑 + TipTap 富文本）
  - MonacoDiffEditor 单栏 diff 视图
  - 文件预览（文本/图片/Markdown）
  - 字号跟随全局字体缩放
  - Ctrl+S 保存
- **文件管理器**：
  - 文件树（新建/重命名/删除/移动/复制粘贴/多选）
  - 拖拽到终端粘贴为路径
  - 外部变更自动刷新（FileWatcher）
  - 文件面板宽度可拖拽调整（持久化到 config）
- **Git 工作区**：事件驱动实时刷新、右栏单栏 diff
- **侧边栏**：
  - 按目录分组展示会话
  - 会话状态指示（运行中/已退出）
  - 终止进程、切换会话
  - 拖拽重排（@dnd-kit）
  - 宽度可拖拽调整（持久化到 config）
- **Tab 系统**：
  - 多类型 Tab 混排（session/preview/diff）
  - 按工作目录自动分组（TabAutoGroup）
  - 拖拽重排
- **设置面板**：主题（暗/亮）、关闭行为（关闭/最小化到托盘）、全局字号、终端配置
- **系统托盘**：常驻托盘，关闭按钮可配置为最小化到托盘
- **窗口管理**：单实例锁、窗口位置记忆、无边框+自建标题条
- **启动动画**（splash screen）
- **Pi 工具集成**：模型配置、MCP 管理、Skills 管理、扩展管理（设置面板中）

### 修复

- 终端流式输出闪烁（对齐 VS Code 渲染管线）
- 终端新建后黑屏（IPC 载荷格式不匹配、config.ts 沙箱崩溃）
- 终端退出后 resize 崩溃
- 终端 tab 重复/切换失效
- 终端链接安全对话框
- 文件树根目录异步到达后永久为空
- 预览 tab 未保存改动静默丢弃
- 侧边栏目录/会话/终止进程状态
- 主进程 `config.ts` 的 `node:os/path` 导入导致 renderer 沙箱崩溃
- 无边框窗口白屏闪屏
- 全屏下外壳多余滚动条

### 重构

- 终端完全采用 VS Code 集成终端同款组件与装配
- 终端渲染抽为 XtermTerminal 薄封装
- 终端主题/字号刷新抽为单点订阅（terminal-registry）
- 三栏布局（侧边栏 / 文件面板 / 主内容区）
- 通用 Tab 框架（中间区统一混排 session/preview/diff）
- 状态管理迁移至 zustand（tabStore）
- 主进程 config.json 作为设置唯一真源（ADR-0001）
- 移除 CodeMirror 依赖，完成 Monaco 接管
- 移除 PDF 预览、二进制交系统打开

### 文档

- README 中英文版
- ADR 架构决策记录
- 实现计划与设计规格文档
- Agent 工作流文档（issue-tracker / triage / domain）

---

## [0.0.1] — 2025-06

### 新增

- 项目脚手架：Electron + React + Vite（electron-vite）
- IPC 桥接层（preload + main handler）
- SessionPool：PTY 进程管理（spawn/kill/status/list）
- 基础侧边栏 + 终端面板组合
- Playwright E2E 测试框架（fake backend）
- 设计令牌（tokens.css）与 UI 组件样式
- JetBrains Mono 字体嵌入