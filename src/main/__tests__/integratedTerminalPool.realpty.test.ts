import { describe, it, expect, vi } from 'vitest';
import * as nodePty from 'node-pty';
import { IntegratedTerminalPool } from '../integratedTerminalPool';
import type { TerminalProfile } from '../../renderer/src/types';

// 跨平台选择真实 shell：win32 用 cmd.exe，darwin/linux 用 /bin/sh。
const shellPath =
  process.platform === 'win32'
    ? process.env.windir
      ? `${process.env.windir}\\System32\\cmd.exe`
      : 'cmd.exe'
    : '/bin/sh';

// pty 接受 \r 作为回车；cmd 与 sh 都兼容。
const newline = '\r';

function makeProfile(): TerminalProfile {
  return {
    id: 'default',
    label: 'Default Shell',
    path: shellPath,
    args: [],
    platform: 'all',
  };
}

describe('IntegratedTerminalPool real PTY', () => {
  it('spawns a real shell, echoes input, and reports exit on destroy', async () => {
    const onData = vi.fn();
    const onExit = vi.fn();
    const pool = new IntegratedTerminalPool({ cols: 80, rows: 24, onData, onExit });

    const info = pool.create(makeProfile(), process.cwd());
    expect(info.id).toMatch(/^term-/);
    expect(pool.has(info.id)).toBe(true);

    const got: string[] = [];
    const pty = (pool as any).entries.get(info.id).pty as nodePty.IPty;
    pty.onData((d: string) => got.push(d));

    // 给 shell 一点启动时间，再写入回显命令。
    await new Promise((r) => setTimeout(r, 300));
    pty.write(`echo hello${newline}`);
    await new Promise((r) => setTimeout(r, 600));

    expect(got.join('')).toContain('hello');

    pool.destroy(info.id);
    expect(pool.has(info.id)).toBe(false);
    // exit 事件在 kill 后异步派发，稍等再断言。
    await new Promise((r) => setTimeout(r, 200));
    expect(onExit).toHaveBeenCalledWith(info.id);
  }, 5000);
});
