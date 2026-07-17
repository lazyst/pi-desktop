# 0003 终端终端层重构：完全采用 VS Code 集成终端同款组件与装配

把 `XtermTerminal`（见 0002）从"自研薄封装 + 大量自研 hack"重构为**完全采用 VS Code 集成终端同款的官方 `@xterm` 组件与标准装配**：组件升级到正式稳定版，移除此前为修"流式跳动/闪"而叠加的全部自研 hack，改由 xterm / VS Code 同款装配以开箱即用方式驱动。

## Status

accepted

## 背景与动机

0002 在修"流式输出跳动"时，于 `XtermTerminal` 内叠加了大量自研 hack：

- 同步帧切分（`?2026h … ?2026l` 逐帧 `term.write`）；
- `hasOpenSyncFrame` 半帧判定 + 兜底 `setTimeout(0)` 防提前 flush；
- `writeBuffer` / `pendingFrames` 串行写队列；
- 输出文本镜像（`dataset.output`，用于 e2e 可观测）；
- 流式期间 `cursorBlink` 抑制；
- 含 CJK 的等宽字体栈（Sarasa / YaHei）硬塞进 metrics 锁。

这些 hack 与 VS Code 集成终端的真实做法**完全背离**——VS Code 不切分同步帧（xterm 原生处理 `?2026` 序列、自行合并未闭合帧），不用字体栈兜底 CJK 度量（而是 `Unicode11Addon`），不用自管 `navigator.clipboard`（而是 `@xterm/addon-clipboard`），不用输出镜像（而是 DOM 渲染器的真实文本层 / WebGL 下用 buffer API）。

同时，依赖仍停在 beta：`@xterm/xterm@6.1.0-beta.288`、`@xterm/addon-webgl@0.20.0-beta.287`，而 VS Code 同款稳定组件是正式 release（`xterm@6.0.0` 系列）。

本 ADR 决定：对齐 VS Code 集成终端的**同款组件 + 同款装配**，把前述 hack 全部移除，只保留必要的集成点（主题跟随、fit resize、置底探测、右键语义）。

## Considered Options

- **R1 仅升级版本、保留全部 hack**：零改动逻辑，只换依赖。→ 否决：hack 与"对齐 VS Code 同款"目标相悖，且 hack 依赖的 beta 行为在稳定版中可能漂移。
- **R2（本次采用）完全对齐 VS Code 同款组件与装配**：升级稳定版 + 移除 hack + 改用官方 addon（clipboard / unicode11）+ 保留契约保形。
- **R3 改写为 VS Code 那套 Instance / TerminalInstance / TerminalProcessManager 分层**：→ 否决：远超本应用需求，且与本应用的 node-pty + Electron 架构不匹配（VS Code 是 extension host 模型）。

## 对外契约（契约保形，沿自 0002-B2-a）

`XtermTerminal` 只通过构造传入的 `pi` 接口收发数据，不触碰主进程 / preload / IPC 信道名。PTY 链路零接触。`TerminalPane`（React 壳）的 props / 方法契约完全不变；`App.tsx` / 主进程 / preload 透明。

## 与 VS Code 集成终端的装配对齐点（源码参照 `vscode-src/.../xterm/xtermTerminal.ts`）

| 维度 | VS Code 集成终端 | 本重构后 |
| --- | --- | --- |
| xterm 组件 | `@xterm/xterm@^6.1.0-beta`（自研同代） | `@xterm/xterm@^6.0.0`（正式稳定版） |
| WebGL 渲染器 | `addon-webgl`，`open` 后 `loadAddon` 启用、`_suggestedRendererType` 恒定 | `addon-webgl`，`open` 前 `loadAddon` 锁定、`open` 后整会话恒定（S1 度量不跳变） |
| 剪贴板 | `@xterm/addon-clipboard`（动态 import，`ClipboardAddon`） | `@xterm/addon-clipboard`，`loadAddon(new ClipboardAddon())` 接管复制/粘贴 |
| Unicode / CJK | `Unicode11Addon`（`_updateUnicodeVersion`） | `Unicode11Addon`，宽字符度量交给 xterm 原生 |
| 数据缓冲 | `TerminalDataBufferer`（固定时间窗聚合） | 5ms 固定时间窗聚合到达块，窗口结束一次性 `term.write` |
| 构造选项 | `allowProposedApi` / `scrollOnEraseInDisplay: true` / `minimumContrastRatio` / `drawBoldTextInBrightColors` / `tabStopWidth` / `cursorBlink` / `letterSpacing` / `lineHeight: 1` | 逐项对齐（见 `XtermTerminal.mount`） |
| 字体栈 | VS Code 默认等宽（不靠 CJK 字体栈兜底度量） | 等宽优先 + 系统 CJK 兜底（不再前置含 CJK 字体栈 hack） |
| 右键菜单 | 由 `ClipboardAddon` + 自建 context menu 处理 | 有选区复制并清空、无选区粘贴（保留原语义，粘贴经系统剪贴板读取） |

## 移除的自研 hack（及替代）

- **同步帧切分 / `hasOpenSyncFrame` / 兜底 `setTimeout(0)`**：xterm 原生处理 `?2026` 同步输出序列，自行合并未闭合帧；数据改用 5ms 时间窗一次性 `term.write`。
- **`writeBuffer` 串行写队列 (`pendingFrames` / `dispatchFrame`)**：简化为单个 5ms 聚合缓冲。
- **输出文本镜像 (`dataset.output`)**：WebGL 下恢复为用 buffer API 驱动置底探测；e2e 改以 fake-pi 写盘 + 侧边栏晋升断言（不再依赖终端 DOM 文本）。
- **`cursorBlink` 流式抑制**：恢复 VS Code 默认 `cursorBlink: true`，由 pi-tui 自身的 `?25h/l` 序列控制光标显隐。
- **含 CJK 字体栈 hack**：由 `Unicode11Addon` 处理宽字符度量，从源头消除中英混排漂移。

## 实现期修正（Implementation note）

重写时一度把 resize 防抖 timer 与写聚合 timer 复用了同一字段 `writeTimer`：
`TerminalPane` 的 `ResizeObserver` 在布局稳定前会频繁触发 `scheduleResize()`，
它 `clearTimeout(this.writeTimer)` 后再设成 `doResize` 的 timer，从而**取消了正在
聚合的写操作**，导致 PTY 输出（recv 持续累积）永远不 `term.write`（wrote 始终为 0）、
终端显示空白。修复：resize 防抖改用独立字段 `resizeTimer`，与写聚合 `writeTimer` 解耦
（见 `XtermTerminal.scheduleResize` / `unmount`）。该回归由 e2e `jump-to-bottom` 测试
配合运行时诊断（`dataset.recv` / `dataset.wrote`）定位并修复。

## Consequences

- 终端层与 VS Code 集成终端采用**同款组件 + 同款装配**，行为可预期、随 xterm 上游演进。
- 移除全部自研 hack，终端逻辑回归"构造 → 装 addon → open → 5ms 聚合写"，可维护性显著提升。
- 依赖固定在正式稳定版（`@xterm/xterm@^6.0.0` + `addon-webgl@^0.19.0` + `addon-clipboard@^0.2.0` + `addon-unicode11@^0.9.0` + `addon-fit@^0.11.0`），不再依赖 beta 行为。
- 右键复制/粘贴统一经 `@xterm/addon-clipboard` 接管，在 Electron 沙箱 / 非安全上下文中表现更稳。
- 继承 0002 的契约保形与度量锁定（S1）不变量，对上层完全透明。

## 关联

- supersedes / 收敛自：0002 终端渲染：VS Code 风格薄封装（渲染器锁定 + 度量锁定 + 数据缓冲）。0002 的"薄封装 + 契约保形 + 度量锁定"主线保留，其叠加的自研 hack 被本 ADR 移除。
