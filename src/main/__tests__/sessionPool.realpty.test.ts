import { describe, it, expect, vi } from 'vitest';
import * as nodePty from 'node-pty';
import { SessionPool } from '../sessionPool';

const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';

describe('SessionPool real PTY', () => {
  it('spawns a real shell, echoes input, and reports exit on kill', async () => {
    const onData = vi.fn();
    const onStatus = vi.fn();
    const onExit = vi.fn();
    const pool = new SessionPool(
      (_file, _args, opts) => nodePty.spawn(shell, [], { ...opts }) as any,
      { cols: 80, rows: 24, sessionsDir: '/tmp/sessions', onData, onStatus, onExit },
    );
    const info = pool.openNew('C:\\', 'realshell');
    const pty = (pool as any).entries.get(info.key).pty as nodePty.IPty;
    const got: string[] = [];
    pty.onData((d: string) => got.push(d));
    await new Promise((r) => setTimeout(r, 300));
    pty.write('echo HELLO_PTY\r\n');
    await new Promise((r) => setTimeout(r, 600));
    expect(got.join('')).toContain('HELLO_PTY');
    pool.terminate(info.key);
    expect(pool.get(info.key)).toBeUndefined();
  });
});
