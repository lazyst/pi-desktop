// 主进程侧 PTY 输出背压（对齐 VS Code acknowledgeDataEvent 的源头流控）。
//
// VS Code 的 TerminalProcess 在 pty 每吐一块数据时累加「已发未确认」字符数，
// 超 HighWatermark 即调用 ptyProcess.pause() 直接掐断 PTY 进程输出（shell 被 OS
// 管道阻塞，数据堵在内核缓冲而非 VS Code 内存），渲染端 ack 追上降到 LowWatermark
// 以下再 ptyProcess.resume() 恢复。三层阈值见下方 FlowControlConstants。
//
// 本项目数据流：PTY → 主进程 5ms 聚合(emitData) → IPC(term:data / session:data)
// → 渲染端 5ms 聚合 → xterm.write → ack 经 IPC 回传主进程。
// 由于 node-pty 的 IPty 原生提供 pause()/resume()（VS Code 同款接口），本项目
// 采用与 VS Code 完全一致的「源头反压」：BackpressureController 在翻转阈值时
// 经 onPause/onResume 回调直接 pause/resume 底层 PTY，而非把数据堆在主进程内存里。
// 这样 `cat` 大文件时 shell 被 OS 管道阻塞、几乎不占主进程内存，与 VS Code 行为等价。

/** 对齐 VS Code FlowControlConstants（字符数，非字节）。 */
export const FlowControlConstants = {
  /** 已发未确认字符数超此即 pause PTY（VS Code: 100000 ≈ 98KB）。 */
  HighWatermarkChars: 100000,
  /** 降到此以下才 resume PTY（VS Code: 5000 ≈ 4.9KB）。 */
  LowWatermarkChars: 5000,
} as const;

export class BackpressureController {
  /** 已下发、尚未收到渲染端 ack 的累计字符数（对齐 VS Code _unacknowledgedCharCount）。 */
  private inflight = 0;
  /** 当前是否处于暂停（超 HighWatermark）状态（对齐 VS Code _isPtyPaused）。 */
  private paused = false;
  /** 翻转至高水位时调用：掐断底层 PTY 输出（从源头反压）。 */
  private readonly onPause: () => void;
  /** 翻转至低水位时调用：恢复底层 PTY 输出。 */
  private readonly onResume: () => void;

  constructor(onPause: () => void, onResume: () => void) {
    this.onPause = onPause;
    this.onResume = onResume;
  }

  /**
   * 主进程从 PTY 读到一块数据时调用，累加未确认计数；
   * 若未暂停且超过高水位，触发 onPause（暂停 PTY 输出）。
   */
  onData(charCount: number): void {
    this.inflight += charCount;
    if (!this.paused && this.inflight > FlowControlConstants.HighWatermarkChars) {
      this.paused = true;
      this.onPause();
    }
  }

  /**
   * 渲染端回传已消费字符数。推进 inflight；若已暂停且降到低水位以下，
   * 触发 onResume（恢复 PTY 输出）。
   */
  acknowledge(charCount: number): void {
    this.inflight = Math.max(0, this.inflight - charCount);
    if (this.paused && this.inflight < FlowControlConstants.LowWatermarkChars) {
      this.paused = false;
      this.onResume();
    }
  }

  /** 实例销毁 / 进程退出时强制恢复（对齐 VS Code clearUnacknowledgedChars）。 */
  dispose(): void {
    if (this.paused) {
      this.paused = false;
      this.onResume();
    }
    this.inflight = 0;
  }

  /** 当前是否在反压暂停中（测试 / 诊断用）。 */
  isPaused(): boolean {
    return this.paused;
  }
}
