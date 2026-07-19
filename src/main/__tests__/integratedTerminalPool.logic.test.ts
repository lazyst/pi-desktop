import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';

// 纯逻辑测试：用 vi.mock 替换 'node-pty'，不 spawn 真实 shell。
// 覆盖 CI 无 PTY / 慢环境的场景，且与真实 PTY 测试相互印证行为。

// 每个 pty 实例独立持有自己的回调表，便于按实例 emit 事件。
interface MockPty {
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  pid: number;
  _cbs: Record<string, (d?: any) => void>;
  emit: (e: string, d?: any) => void;
}

const mockPtys: MockPty[] = [];

vi.mock('node-pty', () => {
  const make = (): MockPty => {
    const cbs: Record<string, (d?: any) => void> = {};
    const pty = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      on: vi.fn((e: string, cb: (d?: any) => void) => { cbs[e] = cb; }),
      pid: 1234,
      _cbs: cbs,
      emit: (e: string, d?: any) => cbs[e]?.(d),
    };
    mockPtys.push(pty);
    return pty;
  };
  return {
    spawn: vi.fn(() => make()),
  };
});

import * as nodePty from 'node-pty';
import { IntegratedTerminalPool } from '../integratedTerminalPool';
import type { TerminalProfile } from '../../renderer/src/types';

const spawnMock = nodePty.spawn as unknown as ReturnType<typeof vi.fn>;

const profile: TerminalProfile = {
  id: 'pwsh',
  label: 'PowerShell',
  path: '/usr/bin/pwsh',
  args: ['-nologo'],
  platform: 'all',
};

const cwd = path.resolve(__dirname, '..'); // 真实存在的目录，避免回退 process.cwd()
const fakeMissingCwd = path.resolve('/this/does/not/exist/xyz');

function makePool() {
  const onData = vi.fn();
  const onExit = vi.fn();
  const pool = new IntegratedTerminalPool({ cols: 80, rows: 24, onData, onExit });
  return { pool, onData, onExit };
}

beforeEach(() => {
  mockPtys.length = 0;
  spawnMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('IntegratedTerminalPool (logic, mocked node-pty)', () => {
  it('create calls nodePty.spawn with the profile and merges env (TERM/COLORTERM, no TERM_PROGRAM override)', () => {
    const { pool } = makePool();
    const info = pool.create(profile, cwd);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [spawnPath, spawnArgs, spawnOpts] = spawnMock.mock.calls[0];
    expect(spawnPath).toBe(profile.path);
    expect(spawnArgs).toEqual(profile.args);
    expect(spawnOpts.cwd).toBe(cwd);
    expect(spawnOpts.cols).toBe(80);
    expect(spawnOpts.rows).toBe(24);
    expect(spawnOpts.env.TERM).toBe('xterm-256color');
    expect(spawnOpts.env.COLORTERM).toBe('truecolor');
    // 不强制 TERM_PROGRAM='vscode'；若 process.env 已有的原值应保留。
    expect(spawnOpts.env.TERM_PROGRAM).toBe(process.env.TERM_PROGRAM);
    // 关键断言：env 必须保留 process.env 的全部原有键（不丢弃）。
    expect(spawnOpts.env.PATH).toBe(process.env.PATH);

    expect(info.id).toMatch(/^term-/);
    expect(info.profileId).toBe(profile.id);
    expect(info.cwd).toBe(cwd);
    expect(info.title).toBe(profile.label);
    expect(pool.has(info.id)).toBe(true);
  });

  it('create falls back to process.cwd() when the given cwd does not exist', () => {
    const { pool } = makePool();
    const info = pool.create(profile, fakeMissingCwd);
    expect(spawnMock.mock.calls[0][2].cwd).toBe(process.cwd());
    expect(info.cwd).toBe(process.cwd());
  });

  it('write forwards input to pty.write; resize calls pty.resize; both no-op safely when missing', () => {
    const { pool } = makePool();
    const info = pool.create(profile, cwd);
    const pty = mockPtys[0];

    pool.write(info.id, 'echo hi\r');
    expect(pty.write).toHaveBeenCalledWith('echo hi\r');

    expect(() => pool.resize(info.id, 120, 40)).not.toThrow();
    expect(pty.resize).toHaveBeenCalledWith(120, 40);

    // 对不存在的 id 写入/调整应安全跳过、不抛错。
    expect(() => pool.write('term-nope', 'x')).not.toThrow();
    expect(() => pool.resize('term-nope', 1, 1)).not.toThrow();
    expect(pty.write).toHaveBeenCalledTimes(1); // 未对不存在 id 多调用
  });

  it('resize on an exited-but-present pty does not throw (race absorbed)', () => {
    const { pool } = makePool();
    const info = pool.create(profile, cwd);
    const pty = mockPtys[0];
    // 模拟 resize 抛错（pty 已退出）。
    pty.resize.mockImplementation(() => { throw new Error('winpty error'); });
    expect(() => pool.resize(info.id, 100, 30)).not.toThrow();
    expect(pty.resize).toHaveBeenCalledTimes(1);
  });

  it('destroy kills pty, removes entry (has===false) and the exit handler reports onExit', () => {
    const { pool, onExit } = makePool();
    const info = pool.create(profile, cwd);
    const pty = mockPtys[0];

    pool.destroy(info.id);
    expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(pool.has(info.id)).toBe(false);

    // 模拟 pty 在 kill 后异步派发 exit 事件 → 应触发 onExit。
    pty.emit('exit');
    expect(onExit).toHaveBeenCalledWith(info.id);
  });

  it('killAll destroys every terminal', () => {
    const { pool, onExit } = makePool();
    const a = pool.create(profile, cwd);
    const b = pool.create(profile, cwd);
    expect(pool.has(a.id)).toBe(true);
    expect(pool.has(b.id)).toBe(true);

    pool.killAll();
    expect(pool.has(a.id)).toBe(false);
    expect(pool.has(b.id)).toBe(false);
    expect(mockPtys[0].kill).toHaveBeenCalledTimes(1);
    expect(mockPtys[1].kill).toHaveBeenCalledTimes(1);
    mockPtys.forEach((p) => p.emit('exit'));
    expect(onExit).toHaveBeenCalledTimes(2);
  });

  it('list returns info for all live terminals including their cwd', () => {
    const { pool } = makePool();
    const a = pool.create(profile, cwd);
    const b = pool.create(profile, cwd);
    const all = pool.list();
    expect(all.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
    // cwd 透传，供渲染层按目录分组聚合计数
    expect(all[0].cwd).toBe(cwd);
    expect(all.every((t) => t.id.startsWith('term-'))).toBe(true);
  });

  it('list excludes terminals that have exited', () => {
    const { pool } = makePool();
    const a = pool.create(profile, cwd);
    pool.create(profile, cwd);
    pool.destroy(a.id);
    const ids = pool.list().map((t) => t.id);
    expect(ids).not.toContain(a.id);
    expect(ids).toHaveLength(1);
  });

  describe('5ms aggregation window (aligned with SessionPool TerminalDataBufferer)', () => {
    it('merges multiple rapid data chunks into a single onData call', async () => {
      vi.useFakeTimers();
      try {
        const { pool, onData } = makePool();
        const info = pool.create(profile, cwd);
        const pty = mockPtys[0];

        pty.emit('data', 'chunk-1');
        pty.emit('data', 'chunk-2');
        pty.emit('data', 'chunk-3');
        expect(onData).not.toHaveBeenCalled(); // 窗口未结束

        await vi.advanceTimersByTimeAsync(10);
        expect(onData).toHaveBeenCalledTimes(1);
        expect(onData).toHaveBeenCalledWith(info.id, 'chunk-1chunk-2chunk-3');
      } finally {
        vi.useRealTimers();
      }
    });

    it('treats windows separated by >5ms as independent emits', async () => {
      vi.useFakeTimers();
      try {
        const { pool, onData } = makePool();
        const info = pool.create(profile, cwd);
        const pty = mockPtys[0];

        pty.emit('data', 'frame-a');
        await vi.advanceTimersByTimeAsync(10);
        pty.emit('data', 'frame-b');
        await vi.advanceTimersByTimeAsync(10);

        expect(onData).toHaveBeenCalledTimes(2);
        expect(onData).toHaveBeenNthCalledWith(1, info.id, 'frame-a');
        expect(onData).toHaveBeenNthCalledWith(2, info.id, 'frame-b');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not emit late data after destroy clears the pending buffer', async () => {
      vi.useFakeTimers();
      try {
        const { pool, onData, onExit } = makePool();
        const info = pool.create(profile, cwd);
        const pty = mockPtys[0];

        pty.emit('data', 'late');
        pool.destroy(info.id); // 未到 5ms 窗口即销毁
        await vi.advanceTimersByTimeAsync(10);
        expect(onData).not.toHaveBeenCalled(); // 缓冲已清，不迟到 emit
        expect(onExit).not.toHaveBeenCalled(); // 该实例不是 exit 触发的
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
