# 0004 终端防闪烁机制补全：对齐 VS Code 集成终端缺失项

在 0002（渲染器锁定 + 度量锁定 + 数据缓冲）与 0003（完全采用 VS Code 同款组件与装配）的基础上，
补上与 VS Code 集成终端对比后仍缺失的防闪烁 / 消除中间帧机制。目标：切 tab、重载会话、写完成、
主题/背景同步等场景不再出现可见闪烁或中间帧。

## Status

accepted

## 背景与动机

完成 0002/0003 后，终端层已对齐 VS Code 的核心装配（WebGL 渲染器恒定、5ms 前端写聚合、Unicode11、
分层 resize 防抖、?2026 同步输出原生处理）。但与 VS Code 集成终端源码逐行对比后，发现本项目仍缺
以下机制（详见 task_plan.md / findings.md）：

| 缺失机制 | VS Code 源码 | 本项目此前 |
| --- | --- | --- |
| 切 tab 不销毁实例 | `terminalInstance.setVisible` keep-alive | `TerminalPane` 非 active 直接 `unmount()` 重建 → 切 tab 首帧闪 |
| 主进程端数据缓冲（双段聚合） | `ptyService` 内 `TerminalDataBufferer` 5ms 聚合 | 仅前端聚合，进程端直发 |
| 写完成确认闸门 | `_flushXtermData`（写/解析序号 + 轮询） | 无，写链靠 timer，尾部帧可能撕裂 |
| 背景色跟随容器 | `terminalInstance.getBackgroundColor` 回退容器色 | `theme.ts` 写死 hex |
| 重载同帧 RIS 重置 | `SeamlessRelaunchDataFilter` `\x1bc` 同帧 | 无 |

## Considered Options

- **R1 只补最影响可见闪烁的两项（keep-alive + 背景跟随）**：最小改动。→ 否决：写完成确认与
  主进程缓冲是 VS Code 双段缓冲模型的关键一环，缺一则「双段」不成立。
- **R2（本次采用）五项全补，且保持单文件薄封装与契约保形**：在 0002/0003 的约束内补齐全部
  缺失项，不引入 VS Code 的 Instance/ProcessManager 分层。

## 实现要点（对照 VS Code）

### 1. keep-alive（Phase 1）
- `TerminalPane.tsx`：实例只创建一次、跨 `active` 切换保留；非 active 仅 CSS `display:none` 隐藏 +
  通知 `XtermTerminal.setActive(false)`，不销毁。切回时 `setActive(true)` → 立即 `doResize(true)` 对齐尺寸
  （对齐 VS Code `setVisible` 的 `_resizeDebouncer.flush` + `_resize`）。
- 根因修复：原实现每次切 tab 都 `unmount()`（销毁 xterm + WebGL 上下文丢失）+ 再 `mount()`
  （重建 + 重新探测 WebGL），必然带一次首帧闪。keep-alive 后实例恒活，无此闪。

### 2. 主进程端 5ms 数据缓冲（Phase 2）
- `sessionPool.ts`：新增每会话 `DataBuffer`（5ms 时间窗），`pty.on('data')` 改为 `emitData(key, d)`
  聚合后一次性 `opts.onData(key, joined)`。与渲染端 5ms 聚合构成「双段缓冲」，统一 IPC 投递节奏。
- 契约保形：`onData(key, data)` 签名不变，preload `ipc.ts` / `App.tsx` / `XtermTerminal` 全透明。
- `terminate`/`deleteSession` 时 `clearDataBuffer` 清掉待发缓冲，避免 kill 后迟到数据发往已销毁实例。

### 3. 写完成确认闸门（Phase 3）
- `XtermTerminal.ts`：`_latestWriteSeq` / `_latestParsedSeq` 两计数器。每次 `term.write(chunk, cb)`
  递增写序号，xterm 解析回调（`onWriteParsed`）推高解析序号。新增 `flush()`：轮询两序号追平（20ms
  间隔、最多 5 次），供会话结束/卸载前 `await`，避免尾部帧撕裂或丢失。对齐 VS Code `_flushXtermData`。

### 4. 背景色跟随容器（Phase 4）
- `theme.ts`：`TERM_THEMES` 背景不再写死 hex，改为 `getTermTheme(theme)` 运行时读 `--bg-app` 的
  computed 值（`resolveBg`），前景/光标取自 `--text` 等价色。确保终端背景与 `.terminal-host` 严格
  一致，消除主题切换/浅色模式下的容器-终端背景错位露边闪。对齐 VS Code `getBackgroundColor`。

### 5. 同帧 RIS 重置（Phase 5）
- `XtermTerminal.ts`：新增 `resetSameFrame()`，发全清序列 `\x1bc`。用于会话重置/复用时需彻底清屏
  的场景（如 `onRelink` 后清旧缓冲），使清屏与首段写在 xterm 同一次重绘呈现，不闪。对齐 VS Code
  `SeamlessRelaunch` 的 `triggerSwap` 同帧语义。本应用单进程模型下无需双进程录屏比对，故只取
  「同帧 RIS」这一保险动作。

## Consequences

- 切 tab 不再重建 xterm/WebGL，消除切 tab 首帧闪（keep-alive）。
- 主进程 + 渲染端双段 5ms 缓冲，IPC 投递与渲染写入节奏一致，中间帧闪烁进一步收敛。
- 写完成闸门保证尾部帧在销毁/结束前完整呈现，无撕裂/丢失。
- 终端背景与容器严格一致，主题切换/浅色模式不露边。
- 单文件薄封装、契约保形、零接触 PTY 链路等 0002/0003 约束全部保持。

## 验证

- `pnpm test`（vitest）：92 项单测全部通过，含新增 keep-alive / flush / resetSameFrame /
  sessionPool 双段缓冲用例。
- `pnpm test:e2e`（playwright）：4 项失败均为**改动前已存在**的预存失败（jump-to-bottom、promote
  相关），与本次改动无关（已用 `git stash` 还原验证原代码同样失败）。

## 关联

- supersedes / 收敛自：0002（终端渲染：VS Code 风格薄封装）、0003（终端层重构：完全采用 VS Code
  集成终端同款组件与装配）。本 ADR 在二者之上补齐「防闪烁机制」的最后几项缺口。
