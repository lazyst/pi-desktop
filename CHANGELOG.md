# Changelog

## v1.0.5 (2026-08-07)

### 修复

- **终端：pi-tui fullscreen → regular 切换时终端被误关** — 根因：Windows conpty 在处理 `\x1b[?1049l`（退出 alternate screen）时可能误关输出管道，导致 node-pty 触发假的 pty `exit` 事件（shell 进程仍存活），终端 tab 被错误关闭。
  - 移除了脆弱的 `detectPiExit` 机制——原实现依赖 shell prompt 的 OSC 133 D 间接信号判断 pi 退出，该序列易在多种场景下误判（切换 TUI 模式时 conpty 重发主缓冲区、消息内容嵌入等）。终端 tab 生命周期改为跟随 shell 进程：pi 退出后 tab 保持打开，仅当 shell 真正退出或用户主动终止时才关闭。
  - 抑制 conpty 误报的 pty `exit` 事件——在 data handler 中检测 `\x1b[?1049l` 序列并记录时间戳，若 pty `exit` 紧跟其后（1 秒窗口内）视为 conpty 误报并忽略。
  - 新增 3 个 `UnifiedTerminalPool` 覆盖测试。

### 技术

- 新增 `UnifiedTerminalPool` conpty 误报抑制相关测试。

---

## v1.0.4 (2026-08-07)

### 修复

- **终端：pi-tui fullscreen 滚动条在 emoji 行占 2 列** — 根因：xterm 的 Unicode 宽度表未激活为 11，Unicode11Addon 仅注册版本提供者，xterm 默认使用 Unicode 6.3 导致 emoji 被视为宽度 1 的普通字符，`_fixTuiScrollbarWideChars` 检测 `getWidth() === 0` 永远不匹配。修复：激活 Unicode 11 宽度表（`term.unicode.activeVersion = '11'`），用 `term.write` 包装替代事件触发确保每次写后执行修复，改进检测逻辑覆盖 `getWidth() === 0/2` 两种场景。
- **终端：xterm overview ruler z-index 覆盖问题** — 修复 overview ruler 被其他元素遮挡的问题，改用裸选择器 + `!important` 确保 z-index 优先级。

### 特性

- **终端设置：Custom Glyphs 与 GPU Acceleration** — 设置面板新增「渲染」区域，支持运行时切换自定义字形开关（`customGlyphs`）与 GPU 加速模式（`gpuAcceleration`：auto/on/off），对齐 VS Code 终端设置。

### 技术

- 添加 `XtermTerminal` 与 `SettingsPanel` 覆盖测试。

---

## v1.0.3 (2026-03-27)

### 修复
- **终端：pi-tui 全屏 TUI 宽字符滚动条错位** — 在 xterm 写完成后检测最右列 null continuation cell（宽字符延伸），仅对含宽字符的行写入校正序列替换为单列空格，消除滚动条 2 列宽偏移。对齐 VS Code 的 buffer 后处理方案。
- **终端：pi-tui 全屏 TUI 鼠标滚轮不滚动** — 在进入 alternate screen 时自动激活 xterm mouse tracking（`\x1b[?1003h` + `\x1b[?1006h`），使 pi-tui 能接收鼠标滚轮事件滚动消息区。
- **终端：/name 命令后侧边栏会话名不更新** — 修复会话名变更后侧边栏未同步更新的问题。
- **终端：阻止 pi-tui 全屏 TUI 渲染时终端视口跳动** — 抑制差分渲染与视口贴底的冲突导致的跳动。

### 终端渲染重构（6 阶段 14 项）

- **写入路径对齐 VS Code** — 升级 xterm 6.1.0-beta.292，重构写入管道完全对齐 VS Code 的 `_writeProcessData` 路径，消除自研 hack（5ms 行切片、亚像素阈值等），修复滚动条白边。
- **防闪烁优化** — 重写终端渲染管线，解决流式输出闪烁、光标抖动、滚动跳动等 14 项问题。
- **写入管道优化** — 启用 parse-clock pacer + 渲染端二次聚合器（5ms 时间窗 + 64KB 上限），双层减少 IPC 消息量。
- **WebGL 渲染器可重试** — 移除永久锁定，上下文丢失后可自动重建 WebGL 上下文。
- **WebGL 去同步检测器** — 检测 WebGL 渲染器与 xterm 缓冲区之间的去同步状态并在恢复时自动修复。
- **WebGL 附加失败防抖锁** — 防止 WebGL 附加失败时高频重试。
- **DOM 事件驱动的滚动意图跟踪** — 精确跟踪用户滚动意图，避免流式输出时意外跳转。
- **结构重放协调器** — 清屏/重放时保护滚动意图，确保视口位置精确恢复到用户阅读位置。
- **稳定硬件光标** — 6 项改进对齐 Orca 方案，消除光标闪烁/抖动。
- **滚动意图核心 + 重建保护** — 滚动意图与 xterm 集成，终端重建时恢复滚动位置。
- **滚动意图跟踪 + 可见性记忆 + 渲染暂停修复** — 完整终端滚动状态管理，标签页切换后恢复滚动位置。

### 其他
- **会话查看页面** — 添加复制文件路径/会话ID按钮及 toast 提示。
- **用 @xterm/addon-web-links 替换自定义文件路径链接检测** — 消除安全对话框，使用 Ctrl+click 打开链接。
- **Pi 扩展 spinner + OSC 标题提取 + 侧效果处理器 + 渲染帧同步** — 优化终端渲染稳定性。
- 删除计划文件 `plan.md`。

---

## v1.0.2 (2026-03-18)

### 修复
- 修复打包构建后终端始终使用暗色主题的问题。
- 其他稳定性修复。

---

## v1.0.1 (2026-03-16)

- 版本号更新。

---

## v1.0.0 (2026-03-16)

初始发布：pi-workbench 桌面 IDE，包装 pi CLI 的实时终端 UI。