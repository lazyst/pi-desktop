import { describe, it, expect, vi } from 'vitest';
import {
  CommandDetectionCapability,
  CwdDetectionCapability,
} from '../components/terminalCapabilities';

// 对齐 VS Code CommandDetectionCapability / CwdDetectionCapability 的核心语义：
// 消费注入脚本发的 OSC 633 序列，维护命令生命周期与可信 cwd。

describe('CommandDetectionCapability (OSC 633 命令生命周期)', () => {
  const fakeMarker = {} as any;
  it('parses A→B→D as a finished command with marker + exit code', () => {
    const cap = new CommandDetectionCapability(() => fakeMarker);
    const finished: any[] = [];
    cap.onCommandFinished((c) => finished.push(c));

    expect(cap.handleSequence('A')).toBe(true); // prompt 完成
    expect(cap.handleSequence('B')).toBe(true); // 命令开始
    expect(cap.handleSequence('D;0')).toBe(true); // 命令结束（退出码 0）

    expect(finished).toHaveLength(1);
    expect(finished[0].marker).toBe(fakeMarker);
    expect(finished[0].exitCode).toBe(0);
  });

  it('captures explicit command line from OSC 633;E (high confidence)', () => {
    const cap = new CommandDetectionCapability(() => fakeMarker);
    const finished: any[] = [];
    cap.onCommandFinished((c) => finished.push(c));

    cap.handleSequence('A');
    cap.handleSequence('E;ls%20-la'); // 反序列化应为 "ls -la"
    cap.handleSequence('B');
    cap.handleSequence('D');

    expect(finished[0].command).toBe('ls -la');
  });

  it('ignores unknown sequence and returns false', () => {
    const cap = new CommandDetectionCapability(() => fakeMarker);
    expect(cap.handleSequence('Z')).toBe(false);
  });

  it('tracks in-progress command via currentCommand before finish', () => {
    const cap = new CommandDetectionCapability(() => fakeMarker);
    cap.handleSequence('A');
    cap.handleSequence('B');
    cap.setCommandLine('npm test');
    expect(cap.currentCommand?.command).toBe('npm test');
    expect(cap.commands).toHaveLength(0);
  });
});

describe('CwdDetectionCapability (OSC 633;P;Cwd=)', () => {
  it('extracts trusted cwd from OSC 633;P;Cwd=', () => {
    const cap = new CwdDetectionCapability();
    const cb = vi.fn();
    cap.onDidChangeCwd(cb);

    expect(cap.handleProperty('P;Cwd=/home/user/project')).toBe(true);
    expect(cap.cwd).toBe('/home/user/project');
    expect(cb).toHaveBeenCalledWith('/home/user/project');
  });

  it('decodes percent-escaped cwd', () => {
    const cap = new CwdDetectionCapability();
    cap.handleProperty('P;Cwd=/home%2Fuser');
    expect(cap.cwd).toBe('/home/user');
  });

  it('ignores non-Cwd properties', () => {
    const cap = new CwdDetectionCapability();
    expect(cap.handleProperty('P;IsWindows=True')).toBe(false);
    expect(cap.cwd).toBeUndefined();
  });

  it('does not fire when cwd is unchanged', () => {
    const cap = new CwdDetectionCapability();
    const cb = vi.fn();
    cap.onDidChangeCwd(cb);
    cap.handleProperty('P;Cwd=/same');
    cap.handleProperty('P;Cwd=/same');
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
