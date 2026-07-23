/**
 * AckDataBufferer —— 移植自 VS Code terminalProcessManager.ts 的 AckDataBufferer。
 *
 * 作用：在渲染端累积 xterm.write 回调上报的已消费字符数，达到
 * FlowControlConstants.CharCountAckSize 阈值时一次性发送 ack IPC，
 * 减少高频小段 write 回调下的主进程 ↔ 渲染程通信量。
 *
 * 与 VS Code 原版的差异（仅适配，不改语义）：
 *   - VS Code 用 `(charCount: number) => void` 回调 + 类方法封装；
 *     本项目对齐同一设计，回调函数在构造时注入。
 *   - 增加 `flush()` 方法，用于强制刷出剩余未满阈值的字符（unmount/flush 场景）。
 *   - 增加 `dispose()` 方法，清理状态并强制刷出。
 */
import { FlowControlConstants } from '../../../main/backpressure';

export class AckDataBufferer {
  /** 已累积但尚未发送 ack 的字符数（对齐 VS Code _unsentCharCount）。 */
  private _unsentCharCount = 0;
  /** 是否已释放（dispose 后不再接受新累积）。 */
  private _disposed = false;

  /**
   * @param ackCallback 发送 ack 的回调函数。接收已消费字符数。
   *                     典型实现：`(len) => pi.acknowledgeDataEvent(sessionKey, len)`
   */
  constructor(private readonly ackCallback: (charCount: number) => void) {}

  /**
   * 上报新消费的字符数。当累积超过 CharCountAckSize 阈值时触发一次 ack 回调。
   * 使用 > 而非 >=，对齐 VS Code AckDataBufferer 的精确行为：
   * 当 _unsentCharCount 恰好等于 CharCountAckSize 时不触发，
   * 继续累积到下一次才触发，减少边界情况下的 IPC 频率。
   * dispose 后静默忽略。
   */
  ack(charCount: number): void {
    if (this._disposed || charCount <= 0) return;
    this._unsentCharCount += charCount;
    while (this._unsentCharCount > FlowControlConstants.CharCountAckSize) {
      this._unsentCharCount -= FlowControlConstants.CharCountAckSize;
      this.ackCallback(FlowControlConstants.CharCountAckSize);
    }
  }

  /**
   * 强制刷出所有剩余未满阈值的字符（对齐 VS Code 闲置清理策略）。
   * 在 unmount / flush / 空闲定时器触发时调用，确保主进程背压控制器水位准确。
   */
  flush(): void {
    if (this._disposed || this._unsentCharCount <= 0) return;
    this.ackCallback(this._unsentCharCount);
    this._unsentCharCount = 0;
  }

  /**
   * 释放实例：先 flush 刷出剩余字符，再标记为已释放。
   * 后续 ack 调用静默忽略。
   */
  dispose(): void {
    if (this._disposed) return;
    this.flush();
    this._disposed = true;
  }

  /** 当前累积未发送的字符数（测试/诊断用）。 */
  get unsentCharCount(): number {
    return this._unsentCharCount;
  }

  /** 是否已释放（测试/诊断用）。 */
  get disposed(): boolean {
    return this._disposed;
  }
}