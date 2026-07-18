/**
 * TerminalDataBufferer —— 移植自 VS Code src/vs/platform/terminal/common/terminalDataBuffering.ts。
 *
 * 作用：把高频到达的 PTY 输出块在固定时间窗（默认 5ms）内聚合，窗口结束一次性回调写出。
 * 这能消除「流式高频重绘的中间帧闪烁」，是 VS Code 与本项目终端对齐的核心装配点之一。
 *
 * 与 VS Code 原版的差异（仅适配，不改语义）：
 *   - VS Code 用 `Event<string | IProcessDataEvent>` 订阅；本项目用 `(key, data) => void` 回调订阅，
 *     故 startBuffering 接收 `subscribe`（一个把内部 handler 接到数据源、并返回 unsubscribe 的函数）。
 *   - 返回 unsubscribe 函数（而非 IDisposable），更贴合本项目 React/纯 TS 环境。
 */
export interface TerminalDataBuffer {
  data: string[];
  timeoutId: ReturnType<typeof setTimeout> | null;
}

export class TerminalDataBufferer {
  private readonly _bufferMap = new Map<string, TerminalDataBuffer>();

  constructor(private readonly _callback: (id: string, data: string) => void) {}

  dispose(): void {
    for (const buffer of this._bufferMap.values()) {
      if (buffer.timeoutId != null) clearTimeout(buffer.timeoutId);
    }
    this._bufferMap.clear();
  }

  /**
   * 开始对某 id 的数据做时间窗聚合。
   * @param id 会话标识（本项目为 sessionKey）
   * @param subscribe 把内部 handler 接到数据源的函数；返回值是取消订阅的函数。
   *                  调用方通常传 `(handler) => pi.onData(handler)`。
   * @param throttleBy 时间窗毫秒，默认 5（对齐 VS Code TerminalDataBufferer）
   * @returns 取消缓冲的函数（停止订阅 + 清空缓冲）
   */
  startBuffering(id: string, subscribe: (handler: (id: string, data: string) => void) => () => void, throttleBy = 5): () => void {
    const handler = (dataId: string, data: string) => {
      let buffer = this._bufferMap.get(dataId);
      if (buffer) {
        buffer.data.push(data);
        return;
      }
      const timeoutId = setTimeout(() => this._flushBuffer(dataId), throttleBy);
      buffer = { data: [data], timeoutId };
      this._bufferMap.set(dataId, buffer);
    };

    const unsubscribe = subscribe(handler);

    return () => {
      unsubscribe();
      this.stopBuffering(id);
    };
  }

  stopBuffering(id: string): void {
    const buffer = this._bufferMap.get(id);
    if (buffer?.timeoutId != null) clearTimeout(buffer.timeoutId);
    this._bufferMap.delete(id);
  }

  private _flushBuffer(id: string): void {
    const buffer = this._bufferMap.get(id);
    if (buffer) {
      this._bufferMap.delete(id);
      const data = buffer.data.join('');
      this._callback(id, data);
    }
  }
}
