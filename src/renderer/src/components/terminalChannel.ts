import type { PiApi } from '../ipc';

/**
 * TerminalChannel —— 终端「数据通道」抽象。
 *
 * 把「PTY 进程 ↔ 渲染层」的数据流（输出订阅 / 退出订阅 / 键盘输入 / 尺寸通知）从具体 IPC
 * 信道中解耦出来，使同一个 XtermTerminal 封装既能驱动会话终端（SessionChannel，复用 session:*
 * IPC），也能驱动集成终端（IntegratedChannel，复用 terminal:* IPC），还能驱动统一终端
 * （UnifiedChannel，统一复用 term:* IPC），而 XtermTerminal 本身不感知差异。
 *
 * UnifiedChannel 收编了 SessionChannel + IntegratedChannel 的设计，统一通过 term:* IPC 通信，
 * 是未来新代码的首选实现。SessionChannel 和 IntegratedChannel 保留作为向后兼容。
 *
 * 设计要点（与重构前会话终端行为 100% 等价）：
 *  - onData / onExit / send / resize 四个原语，覆盖原 XtermTerminal 内全部 `this.pi.input /
 *    onData / onStatus / resize` 调用。
 *  - 原「会话结束收尾 resize」由 `pi.onStatus('dead')` 触发；这里统一收敛到 `onExit`（exit 即
 *    dead，语义等价），会话终端与集成终端走同一收尾路径，XtermTerminal 无需保留 onStatus 分支。
 */
export interface TerminalChannel {
  // 订阅 PTY 输出；返回取消订阅函数
  onData(cb: (data: string) => void): () => void;
  // 订阅进程退出
  onExit(cb: () => void): () => void;
  // 键盘/粘贴输入 → PTY stdin
  send(data: string): void;
  // 通知 PTY 尺寸变化
  resize(cols: number, rows: number): void;
}

// 会话终端通道：包现有的 session:* IPC（与当前 XtermTerminal 硬编码行为一致）
export class SessionChannel implements TerminalChannel {
  constructor(
    private readonly pi: PiApi,
    private readonly sessionKey: string,
  ) {}

  onData(cb: (data: string) => void): () => void {
    return this.pi.onData((key, data) => {
      if (key === this.sessionKey) cb(data);
    });
  }

  onExit(cb: () => void): () => void {
    return this.pi.onExit((key) => {
      if (key === this.sessionKey) cb();
    });
  }

  send(data: string): void {
    this.pi.input(this.sessionKey, data);
  }

  resize(cols: number, rows: number): void {
    this.pi.resize(this.sessionKey, cols, rows);
  }
}

// 统一终端通道：同时支持 pi 会话和 shell 终端的 UnifiedChannel
// 收编 SessionChannel + IntegratedChannel，统一通过 unified `term:*` IPC 通信。
export class UnifiedChannel implements TerminalChannel {
  constructor(
    private readonly pi: PiApi,
    private readonly id: string,
  ) {}

  onData(cb: (data: string) => void): () => void {
    return this.pi.onTerminalData((id, data) => {
      if (id === this.id) cb(data);
    });
  }

  onExit(cb: () => void): () => void {
    return this.pi.onTerminalExit((id) => {
      if (id === this.id) cb();
    });
  }

  send(data: string): void {
    this.pi.terminalInput(this.id, data);
  }

  resize(cols: number, rows: number): void {
    this.pi.terminalResize(this.id, cols, rows);
  }
}

// 集成终端通道：包 terminal:* IPC（T5 壳会用）
export class IntegratedChannel implements TerminalChannel {
  constructor(
    private readonly pi: PiApi,
    private readonly terminalId: string,
  ) {}

  onData(cb: (data: string) => void): () => void {
    return this.pi.onTerminalData((id, data) => {
      if (id === this.terminalId) cb(data);
    });
  }

  onExit(cb: () => void): () => void {
    return this.pi.onTerminalExit((id) => {
      if (id === this.terminalId) cb();
    });
  }

  send(data: string): void {
    this.pi.terminalInput(this.terminalId, data);
  }

  resize(cols: number, rows: number): void {
    this.pi.terminalResize(this.terminalId, cols, rows);
  }
}
