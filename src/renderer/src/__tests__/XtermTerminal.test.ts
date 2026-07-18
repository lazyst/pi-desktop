// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { XtermTerminal } from '../components/XtermTerminal';
import type { PiApi } from '../ipc';

// 用可控的 mock 替换 addons，验证加载/回退，不触发真实 GPU / 剪贴板 / unicode 解析。
const hoist = vi.hoisted(() => ({
  webglThrow: false,
  webglActivateCalls: 0,
  clipboardActivateCalls: 0,
  unicodeActivateCalls: 0,
}));
vi.mock('@xterm/addon-webgl', () => {
  class WebglAddon {
    disposed = false;
    activate() {
      hoist.webglActivateCalls++;
      if (hoist.webglThrow) throw new Error('WebGL unavailable');
    }
    onContextLoss() {}
    dispose() {
      this.disposed = true;
    }
  }
  return { WebglAddon };
});
vi.mock('@xterm/addon-clipboard', () => {
  class ClipboardAddon {
    activate() {
      hoist.clipboardActivateCalls++;
    }
    dispose() {}
  }
  return { ClipboardAddon };
});
vi.mock('@xterm/addon-unicode11', () => {
  class Unicode11Addon {
    activate() {
      hoist.unicodeActivateCalls++;
    }
    dispose() {}
  }
  return { Unicode11Addon };
});

function makeApi() {
  return {
    listSessions: vi.fn(),
    openSession: vi.fn(),
    terminate: vi.fn(),
    input: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(() => () => {}),
    onStatus: vi.fn(() => () => {}),
    onExit: vi.fn(),
    pickDirectory: vi.fn(),
    debug: vi.fn(),
  } as unknown as PiApi;
}

function mountHost(): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return host;
}

describe('XtermTerminal（VS Code 集成终端同款装配，见 docs/adr/0002 / 0003）', () => {
  beforeEach(() => {
    hoist.webglThrow = false;
    hoist.webglActivateCalls = 0;
    hoist.clipboardActivateCalls = 0;
    hoist.unicodeActivateCalls = 0;
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('attempts to enable the WebGL (GPU) renderer on mount (S1: open 前锁定)', () => {
    const api = makeApi();
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    expect(hoist.webglActivateCalls).toBeGreaterThanOrEqual(1);
    t.unmount();
  });

  it('falls back to DOM renderer without throwing when WebGL is unavailable', () => {
    hoist.webglThrow = true;
    const api = makeApi();
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    expect(() => t.mount(mountHost())).not.toThrow();
    expect(hoist.webglActivateCalls).toBeGreaterThanOrEqual(1);
    t.unmount();
  });

  it('loads the ClipboardAddon (对齐 VS Code 的 ClipboardAddon 装配)', () => {
    const api = makeApi();
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    expect(hoist.clipboardActivateCalls).toBeGreaterThanOrEqual(1);
    t.unmount();
  });

  it('loads the Unicode11Addon for CJK / wide-char metrics (对齐 VS Code _updateUnicodeVersion)', () => {
    const api = makeApi();
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    expect(hoist.unicodeActivateCalls).toBeGreaterThanOrEqual(1);
    t.unmount();
  });

  it('forwards keystrokes to pi.input via term.onData', () => {
    const api = makeApi();
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    expect(api.onData).toHaveBeenCalled();
    t.unmount();
  });

  // 对齐 VS Code TerminalDataBufferer：5ms 时间窗聚合到达的数据块，窗口结束一次性 term.write。
  // 不再按同步帧切分——xterm 原生处理 ?2026 序列，整段缓冲原样写出。
  it('aggregates rapid onData chunks in a 5ms window and writes once (对齐 TerminalDataBufferer)', async () => {
    const api = makeApi();
    const writes: string[] = [];
    const write = vi
      .spyOn(Terminal.prototype, 'write')
      .mockImplementation(function (this: unknown, data: string | Uint8Array, cb?: () => void) {
        writes.push(data as string);
        cb?.();
      });
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    const onData = (api.onData as any).mock.calls[0][0] as (k: string, d: string) => void;
    // 同一 tick 内到达的多块数据应被聚合为一次 write
    onData('k', 'chunk-1');
    onData('k', 'chunk-2');
    onData('k', 'chunk-3');
    await vi.waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0]).toBe('chunk-1chunk-2chunk-3');
    write.mockRestore();
    t.unmount();
  });

  // 超过 5ms 时间窗的两次到达应分别 write（对齐时间窗边界语义）。
  it('flushes separate windows independently across the 5ms boundary', async () => {
    const api = makeApi();
    const writes: string[] = [];
    vi.spyOn(Terminal.prototype, 'write').mockImplementation(function (this: unknown, data: string | Uint8Array, cb?: () => void) {
      writes.push(data as string);
      cb?.();
    });
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    const onData = (api.onData as any).mock.calls[0][0] as (k: string, d: string) => void;
    onData('k', 'frame-a');
    await new Promise((r) => setTimeout(r, 20));
    onData('k', 'frame-b');
    await vi.waitFor(() => expect(writes).toEqual(['frame-a', 'frame-b']));
    t.unmount();
  });

  // 回归（同步帧不再切分）：含 ?2026 序列的整段数据应作为一次 write 原样写出，不被切分/丢弃。
  it('writes a full synchronized-output chunk verbatim in a single write', async () => {
    const api = makeApi();
    const writes: string[] = [];
    vi.spyOn(Terminal.prototype, 'write').mockImplementation(function (this: unknown, data: string | Uint8Array, cb?: () => void) {
      writes.push(data as string);
      cb?.();
    });
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    const onData = (api.onData as any).mock.calls[0][0] as (k: string, d: string) => void;
    const chunk = '\x1b[?2026h\x1b[2Jhello world\x1b[?2026l';
    onData('k', chunk);
    await vi.waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0]).toBe(chunk);
    t.unmount();
  });

  it('copies selection on right-click and pastes (via addon-clipboard) when empty (handleContextMenu)', async () => {
    const api = makeApi();
    const hasSelection = vi.spyOn(Terminal.prototype, 'hasSelection').mockReturnValue(true);
    const getSelection = vi.spyOn(Terminal.prototype, 'getSelection').mockReturnValue('hello');
    const clearSelection = vi.spyOn(Terminal.prototype, 'clearSelection').mockImplementation(() => {});
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText, readText: vi.fn() },
    });
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    const ev = new Event('contextmenu') as unknown as MouseEvent;
    ev.preventDefault = () => {};
    t.handleContextMenu(ev);
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(clearSelection).toHaveBeenCalled();
    hasSelection.mockRestore();
    getSelection.mockRestore();
    clearSelection.mockRestore();
    t.unmount();
  });

  it('calls pi.resize with fitted dims after mount', () => {
    const api = makeApi();
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    const host = mountHost();
    Object.defineProperty(host, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 600, configurable: true });
    t.mount(host);
    expect(api.resize).toHaveBeenCalled();
    t.unmount();
  });

  it('clears the pending write timer on unmount (no late write after dispose)', async () => {
    const api = makeApi();
    const write = vi.spyOn(Terminal.prototype, 'write').mockImplementation(function (this: unknown, _d: string | Uint8Array, cb?: () => void) {
      cb?.();
    });
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    const onData = (api.onData as any).mock.calls[0][0] as (k: string, d: string) => void;
    onData('k', 'late');
    t.unmount(); // 立即卸载，未到 5ms 时间窗
    await new Promise((r) => setTimeout(r, 20));
    expect(write).not.toHaveBeenCalled(); // 卸载后应清空待写缓冲、不触发迟到 write
    write.mockRestore();
  });

  // flush()：写完成确认闸门（对齐 VS Code _flushXtermData）。无待写时应立即 resolve。
  it('flush() resolves immediately when there is no pending write', async () => {
    const api = makeApi();
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    await expect(t.flush()).resolves.toBeUndefined();
    t.unmount();
  });

  // flush()：有数据写出后，onWriteParsed 推进解析序号，flush 应能在写完成后 resolve。
  it('flush() resolves after pending write is parsed', async () => {
    const api = makeApi();
    const write = vi
      .spyOn(Terminal.prototype, 'write')
      .mockImplementation(function (this: unknown, _d: string | Uint8Array, cb?: () => void) {
        cb?.(); // 立即解析完成
      });
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    const onData = (api.onData as any).mock.calls[0][0] as (k: string, d: string) => void;
    onData('k', 'hello');
    await vi.waitFor(() => expect(t.flush()).resolves.toBeUndefined());
    write.mockRestore();
    t.unmount();
  });

  // resetSameFrame()：发全清序列 \x1bc（对齐 VS Code SeamlessRelaunch 同帧 RIS 重置）。
  it('resetSameFrame() writes the RIS full-reset sequence', async () => {
    const api = makeApi();
    const writes: string[] = [];
    vi.spyOn(Terminal.prototype, 'write').mockImplementation(function (this: unknown, data: string | Uint8Array, cb?: () => void) {
      writes.push(data as string);
      cb?.();
    });
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    t.resetSameFrame();
    expect(writes).toContain('\x1bc');
    t.unmount();
  });

  // 滚动状态回调（驱动「跳到底部」浮钮）：视口离底时通知壳 atBottom=false，贴底时 true。
  it('notifies onScrollState(false) when scrolled up and (true) when back at bottom', async () => {
    const api = makeApi();
    const states: boolean[] = [];
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.onScrollState = (bottom) => states.push(bottom);
    t.mount(mountHost());
    // 模拟 xterm buffer：viewportY < baseY 表示上滚离底。buffer 是 getter-only，用 defineProperty 覆盖。
    Object.defineProperty((t as any).term, 'buffer', {
      configurable: true,
      value: { active: { viewportY: 0, baseY: 10 } },
    });
    // 视口上滚离底 → 通知 atBottom=false（对齐运行时 term.onScroll 触发的 notifyScrollState 路径）。
    (t as any).notifyScrollState();
    expect(states).toEqual([false]);
    // 滚回贴底：viewportY 追平 baseY → 通知 atBottom=true。
    (t as any).term.buffer.active.viewportY = 10;
    (t as any).notifyScrollState();
    expect(states).toEqual([false, true]);
    t.unmount();
  });

  // scrollToBottom()：调用 xterm.scrollToBottom 把视口带到底部。
  it('scrollToBottom() calls term.scrollToBottom', async () => {
    const api = makeApi();
    const scrollMock = vi.spyOn(Terminal.prototype, 'scrollToBottom').mockImplementation(() => {});
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    t.scrollToBottom();
    expect(scrollMock).toHaveBeenCalled();
    t.unmount();
  });
});
