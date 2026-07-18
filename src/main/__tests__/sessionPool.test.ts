import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionPool, decodeCwd, formatTimestamp } from '../sessionPool';

function mockPty() {
  const cbs: Record<string, (d?: any) => void> = {};
  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    on: vi.fn((e: string, cb: (d?: any) => void) => { cbs[e] = cb; }),
    emit: (e: string, d?: any) => cbs[e]?.(d),
    pid: 999,
  };
}
function makePool() {
  const factory = vi.fn(() => mockPty());
  const onData = vi.fn(), onStatus = vi.fn(), onExit = vi.fn();
  const pool = new SessionPool(factory, {
    cols: 80, rows: 24, sessionsDir: '/tmp/sessions', onData, onStatus, onExit,
  });
  return { pool, factory, onData, onStatus, onExit };
}

describe('SessionPool', () => {
  it('openExisting spawns pi --session and reports running', () => {
    const { pool, factory, onStatus } = makePool();
    const info = pool.openExisting('/tmp/sessions/x/session.jsonl');
    expect(factory).toHaveBeenCalledWith('pi', ['--session', '/tmp/sessions/x/session.jsonl'], expect.objectContaining({ cwd: 'x', name: 'pi' }));
    expect(info.status).toBe('running');
    expect(onStatus).toHaveBeenCalledWith('/tmp/sessions/x/session.jsonl', 'running');
  });

  it('write forwards to pty.write', () => {
    const { pool, factory } = makePool();
    const key = '/tmp/sessions/x/session.jsonl';
    pool.openExisting(key);
    const pty = factory.mock.results[0].value as ReturnType<typeof mockPty>;
    pool.write(key, 'ls\n');
    expect(pty.write).toHaveBeenCalledWith('ls\n');
  });

  it('terminate kills pty and reports dead', () => {
    const { pool, onStatus } = makePool();
    const key = '/tmp/sessions/x/session.jsonl';
    pool.openExisting(key);
    pool.terminate(key);
    expect(onStatus).toHaveBeenCalledWith(key, 'dead');
    expect(pool.get(key)).toBeUndefined();
  });

  it('openExisting reuses the running process for the same session file (no duplicate spawn)', () => {
    const { pool, factory } = makePool();
    const key = '/tmp/sessions/x/session.jsonl';
    const first = pool.openExisting(key);
    const second = pool.openExisting(key);
    // Same key returned and the pty factory was called only once → no new process.
    expect(second.key).toBe(first.key);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(pool.debugInfo().count).toBe(1);
  });

  it('openExisting respawns when the existing process is dead', () => {
    const { pool, factory } = makePool();
    const key = '/tmp/sessions/x/session.jsonl';
    pool.openExisting(key);
    pool.terminate(key);
    const again = pool.openExisting(key);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(again.status).toBe('running');
  });

  it('killAll terminates every session', () => {
    const { pool } = makePool();
    pool.openExisting('/a/s.jsonl');
    pool.openNew('/some/cwd', 'n');
    pool.killAll();
    expect(pool.get('/a/s.jsonl')).toBeUndefined();
  });
});

describe('cwd codec', () => {
  it('decodes sanitized cwd best-effort', () => {
    expect(decodeCwd('--C--Users-hcz-.pi-agent--')).toContain('Users');
    expect(decodeCwd('--C--Users-hcz-.pi-agent--')).toContain('pi-agent');
  });
  it('还原 Windows 盘符路径（冒号被编码丢弃，需补回）', () => {
    // 真实目录名 --D--personal-agent_space-pi-tool-- 来自 D:\personal-agent_space-pi-tool
    expect(decodeCwd('--D--personal-agent_space-pi-tool--')).toBe('D:\\personal-agent_space-pi-tool');
  });
  it('还原多层级 Windows 盘符路径', () => {
    expect(decodeCwd('--D--a--b--c--')).toBe('D:\\a\\b\\c');
  });
  it('还原 C: 盘符路径', () => {
    expect(decodeCwd('--C--Users-hcz-.pi-agent--')).toBe('C:\\Users-hcz-.pi-agent');
  });
  it('formatTimestamp parses filename', () => {
    expect(formatTimestamp('2026-07-03T19-07-11-857Z_abc.jsonl')).toBe('2026-07-03 19:07');
  });
});

function makePoolIn(sessionsDir: string) {
  const factory = vi.fn(() => mockPty());
  const onData = vi.fn(), onStatus = vi.fn(), onExit = vi.fn();
  const pool = new SessionPool(factory, {
    cols: 80, rows: 24, sessionsDir, onData, onStatus, onExit,
  });
  return { pool, factory, onData, onStatus, onExit };
}

describe('SessionPool.deleteSession', () => {
  it('terminates the process and removes the .jsonl file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-del-'));
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, '{}');
    const { pool, factory } = makePoolIn(dir);
    pool.openExisting(file);
    pool.deleteSession(file);
    const pty = factory.mock.results[0].value as ReturnType<typeof mockPty>;
    expect(pty.kill).toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(false);
    expect(pool.get(file)).toBeUndefined();
  });

  it('refuses to delete files outside sessionsDir (path-traversal guard)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-del-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-out-'));
    const file = path.join(outside, 'evil.jsonl');
    fs.writeFileSync(file, '{}');
    const { pool } = makePoolIn(dir);
    pool.deleteSession(file);
    expect(fs.existsSync(file)).toBe(true); // 未被删除
  });
});

describe('SessionPool.deleteMany', () => {
  it('terminates and deletes each requested session', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-multi-'));
    const f1 = path.join(dir, 'a.jsonl');
    const f2 = path.join(dir, 'b.jsonl');
    fs.writeFileSync(f1, '{}');
    fs.writeFileSync(f2, '{}');
    const { pool, factory } = makePoolIn(dir);
    pool.openExisting(f1);
    pool.openExisting(f2);
    pool.deleteMany([f1, f2]);
    const pty1 = factory.mock.results[0].value as ReturnType<typeof mockPty>;
    const pty2 = factory.mock.results[1].value as ReturnType<typeof mockPty>;
    expect(pty1.kill).toHaveBeenCalledTimes(1);
    expect(pty2.kill).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(f1)).toBe(false);
    expect(fs.existsSync(f2)).toBe(false);
  });

  it('keeps a path-traversal-guarded refusal for out-of-dir keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-multi-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-out-'));
    const evil = path.join(outside, 'evil.jsonl');
    fs.writeFileSync(evil, '{}');
    const { pool } = makePoolIn(dir);
    pool.deleteMany([evil]);
    expect(fs.existsSync(evil)).toBe(true);
  });
});

describe('SessionPool.clearDirectory', () => {
  it('deletes all .jsonl in the cwd folder and removes the empty folder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-clr-'));
    const groupDir = path.join(dir, 'grp');
    fs.mkdirSync(groupDir);
    const f1 = path.join(groupDir, 'a.jsonl');
    const f2 = path.join(groupDir, 'b.jsonl');
    fs.writeFileSync(f1, JSON.stringify({ cwd: '/my/cwd' }) + '\n');
    fs.writeFileSync(f2, JSON.stringify({ cwd: '/my/cwd' }) + '\n');
    const { pool } = makePoolIn(dir);
    pool.clearDirectory('/my/cwd');
    expect(fs.existsSync(f1)).toBe(false);
    expect(fs.existsSync(f2)).toBe(false);
    expect(fs.existsSync(groupDir)).toBe(false); // 空文件夹已移除
  });

  it('terminates running processes in the cwd before deleting files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-clr-'));
    const groupDir = path.join(dir, 'grp');
    fs.mkdirSync(groupDir);
    const f1 = path.join(groupDir, 'a.jsonl');
    fs.writeFileSync(f1, JSON.stringify({ cwd: '/my/cwd' }) + '\n');
    const { pool, factory } = makePoolIn(dir);
    pool.openNew('/my/cwd', 'n'); // running live entry in that cwd
    pool.clearDirectory('/my/cwd');
    const pty = factory.mock.results[0].value as ReturnType<typeof mockPty>;
    expect(pty.kill).toHaveBeenCalled();
    expect(fs.existsSync(f1)).toBe(false);
    expect(fs.existsSync(groupDir)).toBe(false);
  });
});

describe('SessionPool.deleteSession alias resolution (promoted session)', () => {
  it('resolves the disk key to the live process, kills it, and emits onExit for the live key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-alias-'));
    const { pool, factory, onExit } = makePoolIn(dir);
    const live = pool.openNew('/some/cwd', 'n'); // keyed live-<uuid>，此刻磁盘上尚无文件
    // 模拟 pi 在首条消息后写出 .jsonl（晚于 openNew，故不会被 existingDiskKeys 排除 → 晋升关联）
    const grp = path.join(dir, 'grp');
    fs.mkdirSync(grp);
    const disk = path.join(grp, 'abc.jsonl');
    fs.writeFileSync(disk, JSON.stringify({ cwd: '/some/cwd' }) + '\n');
    pool.reconcile([{ cwd: '/some/cwd', sessions: [{ key: disk, name: 'hi', time: 't' }] }]);
    // 删除是通过磁盘 key 触发的（侧边栏点的是磁盘条目）
    pool.deleteSession(disk);
    const pty = factory.mock.results[0].value as ReturnType<typeof mockPty>;
    expect(pty.kill).toHaveBeenCalled(); // 进程被杀（此前会因 alias 漏杀 → 孤儿进程）
    expect(onExit).toHaveBeenCalledWith(live.key); // 终端面板以 live key 关闭
    expect(fs.existsSync(disk)).toBe(false);
  });
});

describe('SessionPool.terminate via disk key (sidebar promote path)', () => {
  it('kills the live process when terminated by the on-disk .jsonl key', () => {
    // 复现 bug：侧边栏渲染的是磁盘 key，点击「终止进程」传入磁盘 key；
    // 进程实际以 live-<uuid> 为 key 存在 entries，需经 alias 反查命中。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-term-aliased-'));
    const { pool, factory, onExit } = makePoolIn(dir);
    const live = pool.openNew('/some/cwd', 'n'); // 进程以 live-<uuid> 为 key
    const grp = path.join(dir, 'grp');
    fs.mkdirSync(grp);
    const disk = path.join(grp, 'abc.jsonl');
    fs.writeFileSync(disk, JSON.stringify({ cwd: '/some/cwd' }) + '\n');
    pool.reconcile([{ cwd: '/some/cwd', sessions: [{ key: disk, name: 'hi', time: 't' }] }]);
    // 侧边栏点「终止进程」传的是磁盘 key
    pool.terminate(disk);
    const pty = factory.mock.results[0].value as ReturnType<typeof mockPty>;
    expect(pty.kill).toHaveBeenCalledTimes(1); // 进程被真正杀掉（此前静默失败 → 杀不掉）
    expect(onExit).toHaveBeenCalledWith(live.key);
    expect(pool.get(live.key)).toBeUndefined();
  });
});
describe('SessionPool data buffering (对齐 VS Code TerminalDataBufferer)', () => {
  it('aggregates rapid pty chunks within the 5ms window into a single onData emit', async () => {
    vi.useFakeTimers();
    try {
      const { pool, factory, onData } = makePool();
      const key = '/tmp/sessions/x/session.jsonl';
      pool.openExisting(key);
      const pty = factory.mock.results[0].value as ReturnType<typeof mockPty>;
      // 同一 tick 内到达的三块数据应被聚合成一次 onData（含 5ms 窗口）。
      pty.emit('data', 'chunk-1');
      pty.emit('data', 'chunk-2');
      pty.emit('data', 'chunk-3');
      expect(onData).not.toHaveBeenCalled(); // 窗口未结束，尚未 emit
      await vi.advanceTimersByTimeAsync(10);
      expect(onData).toHaveBeenCalledTimes(1);
      expect(onData).toHaveBeenCalledWith(key, 'chunk-1chunk-2chunk-3');
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits separate windows independently across the 5ms boundary', async () => {
    vi.useFakeTimers();
    try {
      const { pool, factory, onData } = makePool();
      const key = '/tmp/sessions/x/session.jsonl';
      pool.openExisting(key);
      const pty = factory.mock.results[0].value as ReturnType<typeof mockPty>;
      pty.emit('data', 'frame-a');
      await vi.advanceTimersByTimeAsync(10);
      pty.emit('data', 'frame-b');
      await vi.advanceTimersByTimeAsync(10);
      expect(onData).toHaveBeenCalledTimes(2);
      expect(onData).toHaveBeenNthCalledWith(1, key, 'frame-a');
      expect(onData).toHaveBeenNthCalledWith(2, key, 'frame-b');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears pending buffer on terminate (no late emit after kill)', async () => {
    vi.useFakeTimers();
    try {
      const { pool, factory, onData } = makePool();
      const key = '/tmp/sessions/x/session.jsonl';
      pool.openExisting(key);
      const pty = factory.mock.results[0].value as ReturnType<typeof mockPty>;
      pty.emit('data', 'late');
      pool.terminate(key); // 立即 terminate，未到 5ms 时间窗
      await vi.advanceTimersByTimeAsync(10);
      expect(onData).not.toHaveBeenCalled(); // 终止后清空缓冲，不迟到 emit
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SessionPool promotion linking (live -> disk)', () => {
  it('links a new live session to its written .jsonl and reuses it on openExisting', () => {
    const { pool, factory, onStatus } = makePool();
    const live = pool.openNew('/some/cwd', 'n'); // keyed live-<uuid>
    expect(factory).toHaveBeenCalledTimes(1);
    // pi writes the .jsonl; the filesystem watcher reports it
    pool.reconcile([{ cwd: '/some/cwd', sessions: [{ key: '/tmp/sessions/some/abc.jsonl', name: 'hi', time: 't' }] }]);
    // status is also emitted under the on-disk key so the sidebar dot is correct
    expect(onStatus).toHaveBeenCalledWith('/tmp/sessions/some/abc.jsonl', 'running');
    // clicking the promoted sidebar entry reuses the live process (no duplicate spawn)
    const reopened = pool.openExisting('/tmp/sessions/some/abc.jsonl');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(reopened.key).toBe(live.key); // reports live key → same terminal pane
    expect(pool.debugInfo().count).toBe(1);
  });

  it('does not link when the cwd differs', () => {
    const { pool, factory } = makePool();
    pool.openNew('/cwdA', 'n');
    pool.reconcile([{ cwd: '/cwdB', sessions: [{ key: '/tmp/sessions/cwdB/x.jsonl', name: 'hi', time: 't' }] }]);
    pool.openExisting('/tmp/sessions/cwdB/x.jsonl');
    expect(factory).toHaveBeenCalledTimes(2); // spawned fresh, not reused
  });

  it('resize on an exited pty does not throw', () => {
    const { pool, factory } = makePool();
    const key = pool.openNew('/cwd', 'n').key;
    pool.terminate(key); // exits + removes entry
    expect(() => pool.resize(key, 80, 24)).not.toThrow();
    const pty = factory.mock.results[0].value as ReturnType<typeof mockPty>;
    expect(pty.resize).not.toHaveBeenCalled(); // skipped for dead/removed pty
  });

  it('resize after the pty quits (Ctrl+C) does not throw or call pty.resize', () => {
    const { pool, factory } = makePool();
    const key = pool.openNew('/cwd', 'n').key;
    // simulate pi quitting via Ctrl+C: the pty emits 'exit' (entry stays until terminated)
    const pty = factory.mock.results[0].value as ReturnType<typeof mockPty>;
    pty.emit('exit');
    expect(() => pool.resize(key, 80, 24)).not.toThrow();
    expect(pty.resize).not.toHaveBeenCalled(); // dead pty is skipped
  });
});
