# 0006 终端流式输出与差分渲染：全面对齐 VS Code 集成终端

在 0002（渲染器/度量锁定 + 数据缓冲）、0003（同款组件与装配）、0004（防闪烁机制）的基础之上，
把 VS Code 集成终端源码（`vscode-src/.../contrib/terminal/`）中与「流式输出」和「差分渲染」相关的
处理方式**逐项目**对齐到本项目的终端层，补齐此前对比仍缺失的机制。目标：终端在高速流式输出、
GPU 上下文丢失、主题切换、命令级输出差分等场景下的表现与 VS Code 一致。

## Status

accepted

## 背景与动机

完成 0002/0003/0004 后，本项目已对齐 VS Code 的核心装配（WebGL 恒定、5ms 前端聚合、Unicode11、
分层 resize 防抖、?2026 同步输出原生处理、keep-alive、双段缓冲、flush 闸门、背景跟随、同帧 RIS）。
但与 VS Code 集成终端源码**逐行对比**后，发现本项目在「流式输出 / 差分渲染」处理上仍有以下缺口
（详见对话分析 findings）：

| 缺失机制 | VS Code 源码 | 本项目此前 |
| --- | --- | --- |
| WebGL 上下文丢失恢复 | `_enableWebglRenderer` 注册 `onContextLoss` → 降级 DOM + 重测尺寸 | 无，上下文丢失即黑屏 |
| 强制重绘 / 清纹理图集 | `forceRedraw()` = `clearTextureAtlas()` | 主题切换只设 `options.theme`，无清图集 |
| Shell Integration 流分割 | `TerminalInstance._onProcessData` 按 OSC 633 切段写入 | 5ms 聚合后整体写出，无命令边界切分 |
| 背压回传 | `_writeProcessData` 回调 `acknowledgeDataEvent(data.length)` | 写回调只 fire/解析序号，无 acknowledge |
| 条件平滑滚动 | `MouseWheelClassifier` 仅物理滚轮启用 `smoothScrollDuration` | 固定 125ms，不区分输入设备 |
| 不可见 idle 延迟 resize | `TerminalResizeDebouncer` 不可见时 `runWhenWindowIdle` | 隐藏面板仍走 100ms 防抖立即重排 |
| Decoration 覆盖层（差分 overlay） | `DecorationAddon` 命令/gutter/overview-ruler DOM 覆盖 | 无，命令状态只能进 VT 流 |
| 数据重放 | `basePty.handleReplay` + `onProcessReplay` | 无 |

## Considered Options

- **R1 只补「会黑屏」的硬伤（context-loss + clearTextureAtlas）**：最小改动。→ 否决：Shell
  Integration 流分割与背压是 VS Code 差分写入模型的关键一环，Decoration 层是真正的「差分渲染」
  基座，缺一则终端层仍与 VS Code 有本质差距。
- **R2（本次采用）全部对齐，保持单文件薄封装 + 契约保形 + 零接触 PTY 链路**：在 0002/0003/0004
  的约束内一次性补齐全部缺口，不引入 VS Code 的 Instance/ProcessManager/DecorationAddon 分层
  （Decoration 只做最小基座 API，不搬完整能力体系）。

## 实现要点（对照 VS Code）

### 1. WebGL 上下文丢失恢复（对齐 `_enableWebglRenderer` 的 `onContextLoss`）
- `XtermTerminal.enableWebgl()`：WebGL addon 装载后注册 `addon.onContextLoss(...)`。上下文丢失时
  整会话降级 DOM 渲染器（`rendererLocked` 仍恒定，不切回 WebGL 以免度量再跳变），并 `doResize(true)`
  触发一次尺寸重测。保存 `this.webgl` 引用以便 `forceRedraw` / 卸载时清理。
- 关键不变量：上下文丢失**不重建 WebGL**，与 0002 S1「会话内渲染器恒定」一致，避免度量断裂。

### 2. 强制重绘 / 清纹理图集（对齐 `forceRedraw` / `clearTextureAtlas`）
- 新增 `forceRedraw()`：`this.webgl?.clearTextureAtlas()`（无 WebGL 时静默跳过）。
- 主题切换回调（`onThemeChange`）在更新 `options.theme` 后调用 `forceRedraw()`，避免 WebGL 下
  旧配色/旧字形纹理残留闪留。

### 3. Shell Integration 流分割（对齐 `TerminalInstance._onProcessData`）
- 新增 `segmentByShellIntegration(data)`：按正则 `/\x1b\]633;(?:C|D(?:;\d+)?)\x07/g` 匹配 OSC 633
  命令开始/结束序列，在边界把数据切成多段。5ms 窗口 flush 后、切片前对各段独立走 `flushBatched`
  写入。无 OSC 633 时原样单段（零开销），且不破坏 ?2026 同步帧（xterm 仍合并未闭合同步帧）。
- 语义收益：命令边界成为独立写入单元，为命令级差分/Decoration 层提供干净切分点。

### 4. 背压回传（对齐 `acknowledgeDataEvent`）
- 每批 `term.write(chunk, cb)` 的回调里调用 `this.pi.acknowledgeDataEvent?.(key, chunk.length)`。
- 链路打通：`ipc.ts` 增加 `acknowledgeDataEvent?`（可选，旧实现兼容）→ preload `session:ack`
  IPC → main `ipcMain.on('session:ack')` → `SessionPool.acknowledgeDataEvent(key, bytes)` 记账。
- 当前 node-pty 模型下内核 PTY 缓冲已天然流控，故主进程仅累计消费字节数并透传 opts 钩子，接口
  语义与 VS Code 一致，为后续按需流控/诊断留好接入点。

### 5. 条件平滑滚动（对齐 `MouseWheelClassifier`）
- 新增 `bindWheelClassifier()`：在 xterm element 上监听 `wheel`，按 `deltaX===0 && 整数 deltaY`
  判定物理滚轮，仅物理滚轮时启用 `smoothScrollDuration=125`，触控板滚动设为 0（避免轻滚拖影）。

### 6. 不可见 idle 延迟 resize（对齐 `runWhenWindowIdle`）
- `scheduleResize()`：当终端非 active（keep-alive 隐藏）且非 force 时，用 `requestIdleCallback`
  （缺失时降级 `setTimeout(0)`）延迟 `doResize`，避免后台隐藏面板抢占主线程做整屏重排。
  可见时仍走原 100ms 防抖，跟手优先。

### 7. Decoration 覆盖层（差分 overlay 基座，对齐 `DecorationAddon`）
- 新增 `registerLineDecoration(marker, opts)`（经 `term.registerDecoration` 锚定 buffer 行）与
  `clearDecorations()`。装饰以 `marker.id` 为 key 存入 `this.decorations`，渲染为 DOM 覆盖层，
  命令状态变化只更新 overlay 而不进 VT 流——这是 VS Code 真正「差分渲染」的最小可用基座。
- 注意：本 ADR **只落地基座 API**，不搬 VS Code 完整的 `CommandDetection`/`BufferMarkDetection`
  能力体系与上下文菜单/悬停（超出本应用 TUI 需求）。基座已就位，后续如需命令状态圆点/gutter
  标记可在此之上增量构建。

### 8. 数据重放（对齐 `basePty.handleReplay`）
- 新增 `replayData(data)`：按与普通输出相同的 5ms 聚合路径写入，供主进程 replay 钩子使用
  （当前单进程短会话场景较少触发，API 已就位）。

## Consequences

- GPU 上下文丢失不再黑屏：自动降级 DOM + 重测尺寸，且会话内不重建 WebGL，度量不跳变。
- 换主题不再 WebGL 纹理残留：清纹理图集强制整屏重绘。
- 命令级输出可被差分切分（OSC 633 边界），为命令状态/Decoration 层提供干净切分点。
- 渲染端消费进度经背压链路回传主进程记账，接口语义与 VS Code 一致。
- 触控板轻滚不再触发平滑动画拖影；后台隐藏面板 resize 推迟到 idle，不抢占主线程。
- Decoration overlay 基座就位，命令状态/进度等可脱离 VT 流做轻量差分更新。
- 单文件薄封装、契约保形、零接触 PTY 链路等 0002/0003/0004 约束全部保持。

## 验证

- `tsc --noEmit` 零报错（renderer / main / preload）。
- `vitest run`：100 项全过（原 94 项 + 新增 6 项：context-loss 恢复、forceRedraw 清图集、
  OSC 633 流分割、acknowledgeDataEvent 背压回传、Decoration register/clear、idle 延迟 resize）。
- `electron-vite build`：main / preload / renderer 三段全部构建通过。

## 关联

- 收敛自：0002（渲染器/度量锁定 + 数据缓冲）、0003（同款组件与装配）、0004（防闪烁机制）。
- 关联分析来源：VS Code 集成终端源码 `vscode-src/.../contrib/terminal/browser/`
  `xtermTerminal.ts` / `terminalInstance.ts` / `terminalResizeDebouncer.ts` / `decorationAddon.ts`。
