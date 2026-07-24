import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BackpressureController, FlowControlConstants } from '../backpressure';

// 对齐 VS Code acknowledgeDataEvent 的源头流控：
// 维护「已下发未确认」字符数，超 HighWatermark 调 onPause（掐断 PTY），
// 降到 LowWatermark 以下调 onResume（恢复 PTY）。数据不从主进程内存堆积。
describe('BackpressureController (aligned with VS Code pty pause/resume)', () => {
  let pauseCalls: number;
  let resumeCalls: number;
  let bp: BackpressureController;

  beforeEach(() => {
    pauseCalls = 0;
    resumeCalls = 0;
    bp = new BackpressureController(
      () => { pauseCalls++; },
      () => { resumeCalls++; },
    );
  });

  it('does not pause while under the high-water mark', () => {
    bp.onData(1000);
    expect(bp.isPaused()).toBe(false);
    expect(pauseCalls).toBe(0);
  });

  it('pauses once in-flight chars exceed the high-water mark', () => {
    bp.onData(FlowControlConstants.HighWatermarkChars + 1);
    expect(bp.isPaused()).toBe(true);
    expect(pauseCalls).toBe(1);
    expect(resumeCalls).toBe(0);
  });

  it('does not resume until in-flight drops below the low-water mark', () => {
    bp.onData(FlowControlConstants.HighWatermarkChars + 100);
    expect(bp.isPaused()).toBe(true);
    // 只 ack 一部分（仍高于 LowWatermark）→ 不恢复。
    bp.acknowledge(50);
    expect(bp.isPaused()).toBe(true);
    expect(resumeCalls).toBe(0);
    // ack 剩余 → 降到 0，低于 LowWatermark → 恢复。
    bp.acknowledge(FlowControlConstants.HighWatermarkChars + 50);
    expect(bp.isPaused()).toBe(false);
    expect(resumeCalls).toBe(1);
  });

  it('resumes exactly once when crossing the low-water mark', () => {
    bp.onData(FlowControlConstants.HighWatermarkChars + 1);
    bp.acknowledge(FlowControlConstants.HighWatermarkChars + 1);
    expect(bp.isPaused()).toBe(false);
    expect(resumeCalls).toBe(1);
    expect(pauseCalls).toBe(1);
  });

  it('clamps in-flight at zero on over-acknowledge (no negative / no crash)', () => {
    bp.onData(100);
    bp.acknowledge(99999);
    expect(bp.isPaused()).toBe(false);
    expect(resumeCalls).toBe(0); // 从未 pause，故不会误 resume
    bp.acknowledge(1);
    expect(bp.isPaused()).toBe(false);
  });

  it('forces resume on dispose even if paused (aligns VS Code clearUnacknowledgedChars + force resume)', () => {
    bp.onData(FlowControlConstants.HighWatermarkChars + 1);
    expect(bp.isPaused()).toBe(true);
    bp.dispose();
    expect(bp.isPaused()).toBe(false);
    expect(resumeCalls).toBe(1);
  });

  it('does not double-resume on dispose when already resumed', () => {
    bp.onData(100);
    bp.dispose();
    expect(resumeCalls).toBe(0);
  });

  // —— clearUnacknowledgedChars（对齐 VS Code clearUnacknowledgedChars 的强制 resume 语义）——

  it('clearUnacknowledgedChars forces resume when paused (对齐 VS Code terminalProcess.ts:590-595)', () => {
    bp.onData(FlowControlConstants.HighWatermarkChars + 1);
    expect(bp.isPaused()).toBe(true);
    expect(pauseCalls).toBe(1);
    bp.clearUnacknowledgedChars();
    expect(bp.isPaused()).toBe(false);
    expect(resumeCalls).toBe(1);
    expect(bp.isWriteSyncMode()).toBe(false);
  });

  it('clearUnacknowledgedChars does not resume when not paused', () => {
    bp.onData(100);
    expect(bp.isPaused()).toBe(false);
    bp.clearUnacknowledgedChars();
    expect(resumeCalls).toBe(0);
  });

  it('clearUnacknowledgedChars preserves writeSync mode', () => {
    bp.enterWriteSync();
    bp.onData(FlowControlConstants.HighWatermarkChars + 1);
    expect(bp.isPaused()).toBe(false); // writeSync 不计数
    bp.clearUnacknowledgedChars();
    expect(bp.isWriteSyncMode()).toBe(true); // 保留 writeSync 状态
    bp.exitWriteSync();
    expect(bp.isWriteSyncMode()).toBe(false);
  });

  it('clearUnacknowledgedChars clears inflight regardless of pause state', () => {
    bp.onData(FlowControlConstants.HighWatermarkChars + 1);
    expect(bp.isPaused()).toBe(true);
    bp.clearUnacknowledgedChars();
    // 再发数据应从零开始计数
    bp.onData(100);
    expect(bp.isPaused()).toBe(false);
    // 累积到高水位应再次 pause
    bp.onData(FlowControlConstants.HighWatermarkChars);
    expect(bp.isPaused()).toBe(true);
    expect(pauseCalls).toBe(2);
  });

  // —— writeSync 模式（@internal 自创功能，非 VS Code 对齐项）——

  it('enterWriteSync: onData does not count toward inflight', () => {
    bp.enterWriteSync();
    bp.onData(FlowControlConstants.HighWatermarkChars + 1);
    expect(bp.isPaused()).toBe(false);
    expect(pauseCalls).toBe(0);
    expect(bp.isWriteSyncMode()).toBe(true);
  });

  it('exitWriteSync: restores normal backpressure accounting', () => {
    bp.enterWriteSync();
    bp.onData(FlowControlConstants.HighWatermarkChars + 1);
    expect(bp.isPaused()).toBe(false);

    bp.exitWriteSync();
    expect(bp.isWriteSyncMode()).toBe(false);
    // 退出后 onData 正常计数
    bp.onData(FlowControlConstants.HighWatermarkChars + 1);
    expect(bp.isPaused()).toBe(true);
    expect(pauseCalls).toBe(1);
  });

  it('enterWriteSync/exitWriteSync pairs are idempotent', () => {
    bp.enterWriteSync();
    bp.enterWriteSync(); // 两次 enter 幂等
    expect(bp.isWriteSyncMode()).toBe(true);
    bp.exitWriteSync();
    expect(bp.isWriteSyncMode()).toBe(false);
    bp.exitWriteSync(); // 两次 exit 幂等
    expect(bp.isWriteSyncMode()).toBe(false);
  });

  it('dispose works correctly in writeSync mode', () => {
    bp.enterWriteSync();
    bp.onData(FlowControlConstants.HighWatermarkChars + 1);
    bp.dispose();
    expect(bp.isPaused()).toBe(false);
    expect(resumeCalls).toBe(0); // 从未 pause
    expect(bp.isWriteSyncMode()).toBe(false); // dispose 退出 writeSync 模式
  });
});
