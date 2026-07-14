import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionPool, decodeCwd, formatTimestamp } from '../sessionPool';

function mockPty() {
  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    on: vi.fn((_e: string, _cb: (d: string) => void) => { /* capture not needed for unit test */ }),
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
