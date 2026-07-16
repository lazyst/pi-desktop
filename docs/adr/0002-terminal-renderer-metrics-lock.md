# 0002 终端渲染：VS Code 风格薄封装（渲染器锁定 + 度量锁定 + 数据缓冲）

重构终端实现以修复"流式输出时终端频繁上下跳动"（B 类视口滚动跳动 + C 类行重排跳动，非 A 类闪烁），并把终端渲染逻辑收编为 VS Code 风格的薄封装。根因定位为两层：(1) WebGL 与内建 DOM 渲染器的字符单元度量不一致，且现有代码允许上下文丢失后自愈回退/重连，导致会话中途度量跳变；(2) 字体栈混入不含 CJK 的等宽字体，中英混排时浏览器回退到系统 CJK 字体、墨迹高度与 ASCII 不同，DOM 渲染器下 cell 高度微变。

## Status

accepted（经一次修订：见下方"修订记录"）

## 修订记录

- **v1（原 accepted）**：选 R1 最小修复 + 吸收 VS Code 度量/CSS，保留 `TerminalPane` 单体架构。
- **v2（本次修订）**：在 R1 已验证的行为契约（S1/T1/5ms/CJK/blink）之上，进一步把 `TerminalPane.tsx` 内全部 xterm 逻辑收编进新建的 `XtermTerminal` 薄封装类，`TerminalPane` 退化为 React 生命周期壳。本质是从 R1 走到 **R2 的一个收敛子集**（只取 VS Code 终端的"渲染 / PTY 对接 / 数据缓冲"那一层，不搬 DI/workbench 体系）。

  > 注：本 ADR 采用就地修订而非新开 0003，故此处不保留 v1 与 v2 之间的完整决策演进轨迹，也不标 `superseded_by`。这是一次有意的取舍：用"收敛子集"规避了 v1 否决 R2 时担忧的两点（抹掉 pi-tui 精准 patch、风险高）——本次通过"契约保形 + 零接触 PTY + 单文件薄封装"规避，故可行。

## Considered Options

- **R1 最小修复 + 吸收 VS Code 度量/CSS**：保留 `TerminalPane` 单体架构，只解决度量锁定。（v1 选定，已被 v2 收敛。）
- **R2 包装层移植**（本次采用，收敛子集）：抽 `XtermTerminal` 薄封装收编渲染/缓冲/度量，但**契约保形**（props、IPC 信道、行为语义与原 `TerminalPane` 完全一致，对 `App.tsx`/主进程/preload 透明）、**零接触 PTY 链路**（`sessionPool.ts`/preload `ipc.ts`/IPC 信道名一律不动）、**单文件浅封装**（不拆成 VS Code 那套 Instance/XtermTerminal/DataBufferer/ConfigHelper 四层）。
- **R3 彻底重写（TerminalGroupView / TerminalInstance 模型）**：远超修跳动的需求，过度。

## 对外契约（契约保形，B2-a）

新 `XtermTerminal` 只通过构造传入的 `pi` 接口收发数据，不触碰主进程 / preload / IPC 信道名。PTY 链路零接触。行为契约原样平移：

- **S1** 渲染器在 `open` 前同步探测 WebGL、`open` 后整个会话恒定、绝不中途切换（放弃上下文丢失自愈回退）。
- **T1** 流式窗口内冻结 resize（`RESIZE_QUIET_MS=80ms`），安静后用锁定单元度量精准 refit。
- **5ms 合并缓冲** 对齐 VS Code `TerminalDataBufferer`：固定时间窗累积到达数据块，窗口结束一次性 `term.write`，消除流式高频重绘的中间帧闪烁。
- **F1** 字体栈前置含 CJK 的等宽字体（Sarasa Mono SC / Microsoft YaHei Mono），让 ASCII 与 CJK 落同一字宽网格，消除中英混排度量漂移。
- **blink 抑制** 流式活跃时关闭 `cursorBlink`、停止 `BLINK_RESTORE_MS=400ms` 后恢复，防逐帧光标闪。
- **不强制置底** 不调用 `scrollToBottom`，保留用户上滚浏览；未贴底时由 `onShowJump` 回调驱动置底按钮。
- **右键菜单** 有选区复制并清空、无选区粘贴（对齐原 `handleContextMenu`）。

## Consequences

- 渲染器在 open 前同步探测、open 后整个会话恒定，禁止中途切换（S1）——放弃上下文丢失自愈回退 WebGL 的能力，因其正是度量断裂的来源之一。
- 字体栈前置一个含 CJK 的等宽字体（更纱黑体/Sarasa Mono SC），让 ASCII 与 CJK 落在同一字宽网格（F1），从根消除中英混排度量漂移。
- 流式窗口内绝对冻结 resize（T1，阈值 ~80ms），安静后用锁定单元度量精准 refit；窗口拖拽流式快时不跟手，与 VS Code/iTerm 通用行为一致。
- A 类闪烁不再依赖 WebGL 整屏合成，改由已验证的 5ms 合并缓冲兜底（对齐 VS Code `TerminalDataBufferer`）。
- 终端逻辑收编进 `XtermTerminal` 单文件薄封装，可被独立单测覆盖（`XtermTerminal.test.ts`），`TerminalPane` 退化为壳、只测生命周期/右键/置底按钮。改动面压到最小，对上层完全透明。
