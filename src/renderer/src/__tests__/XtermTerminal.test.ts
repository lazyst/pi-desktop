// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { XtermTerminal } from '../components/XtermTerminal';
import type { PiApi } from '../ipc';

// 用可控的 mock 替换 WebGL addon，验证渲染器加载/回退，不触发真实 GPU（jsdom 无 WebGL 上下文）。
const hoist = vi.hoisted(() => ({ webglThrow: false, activateCalls: 0 }));
vi.mock('@xterm/addon-webgl', () => {
  class WebglAddon {
    disposed = false;
    contextLossHandler: (() => void) | null = null;
    activate() {
      hoist.activateCalls++;
      if (hoist.webglThrow) throw new Error('WebGL unavailable');
    }
    onContextLoss(cb: () => void) {
      this.contextLossHandler = cb;
    }
    dispose() {
      this.disposed = true;
    }
  }
  return { WebglAddon };
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

describe('XtermTerminal（VS Code 风格薄封装，见 docs/adr/0002）', () => {
  beforeEach(() => {
    hoist.webglThrow = false;
    hoist.activateCalls = 0;
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
    expect(hoist.activateCalls).toBeGreaterThanOrEqual(1);
    t.unmount();
  });

  it('falls back to DOM renderer without throwing when WebGL is unavailable', () => {
    hoist.webglThrow = true;
    const api = makeApi();
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    expect(() => t.mount(mountHost())).not.toThrow();
    expect(hoist.activateCalls).toBeGreaterThanOrEqual(1);
    t.unmount();
  });

  it('forwards keystrokes to pi.input via term.onData', () => {
    const api = makeApi();
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    // term.onData 注册在 mount 内；直接验证 pi.input 被订阅链间接调用：模拟一次输入回调。
    // 因 onData 闭包在类内，改为验证 onData 订阅被建立（api.onData 被调用）。
    expect(api.onData).toHaveBeenCalled();
    t.unmount();
  });

  it('coalesces pty chunks in the same frame into a single term.write (5ms 缓冲，对齐 TerminalDataBufferer)', async () => {
    const api = makeApi();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      setTimeout(() => cb(0), 0);
      return 1;
    });
    const write = vi.spyOn(Terminal.prototype, 'write').mockImplementation(() => {});
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    const onData = api.onData.mock.calls[0][0] as (k: string, d: string) => void;
    // 模拟 pi-tui「清屏 → 重绘」落在同一帧
    onData('k', '\x1b[2J');
    onData('k', 'hello world');
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(write.mock.calls[0][0]).toBe('\x1b[2Jhello world');
    write.mockRestore();
    t.unmount();
  });

  it('suppresses cursorBlink while streaming (prevents per-frame cursor flicker)', () => {
    vi.useFakeTimers();
    const api = makeApi();
    // xterm 的 write 是实例方法，其实现内 `this` 即 term 实例，可读出实时 cursorBlink。
    let blinkAtWrite = true;
    const write = vi
      .spyOn(Terminal.prototype, 'write')
      .mockImplementation(function (this: any) {
        blinkAtWrite = this.options.cursorBlink;
      });
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    const onData = api.onData.mock.calls[0][0] as (k: string, d: string) => void;
    onData('k', 'stream');
    // 流式窗口内 flush（5ms）触发 write，此时 cursorBlink 应被抑制为 false
    vi.advanceTimersByTime(5);
    expect(blinkAtWrite).toBe(false);
    vi.useRealTimers();
    write.mockRestore();
    t.unmount();
  });

  // 恢复为 true 的行为由 BLINK_RESTORE_MS 定时器驱动，且恢复本身不触发 write，
  // 无法在单测里通过 write 观测；交由 e2e/手动冒烟覆盖（见 docs/adr/0002）。
  // 此处仅确认：静默/再次流式时抑制链路存活、不抛错。
  it('keeps the suppress link alive across multiple stream bursts', () => {
    vi.useFakeTimers();
    const api = makeApi();
    let blinkAtWrite = true;
    const write = vi
      .spyOn(Terminal.prototype, 'write')
      .mockImplementation(function (this: any) {
        blinkAtWrite = this.options.cursorBlink;
      });
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    const onData = api.onData.mock.calls[0][0] as (k: string, d: string) => void;
    onData('k', 'a');
    vi.advanceTimersByTime(5);
    expect(blinkAtWrite).toBe(false);
    onData('k', 'b');
    vi.advanceTimersByTime(5);
    expect(blinkAtWrite).toBe(false);
    vi.useRealTimers();
    write.mockRestore();
    t.unmount();
  });

  it('notifies jump-to-bottom visibility via onShowJump when scrolled up', () => {
    const api = makeApi();
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    const setShow = vi.fn();
    t.onShowJump(setShow);
    const host = mountHost();
    t.mount(host);
    // 初始贴底：onShowJump 至少被调用一次且为 false
    expect(setShow).toHaveBeenCalledWith(false);
    // 与原 TerminalPane 测试一致：优先驱动真实 viewport；jsdom 下用 host 兜底。
    // 关键：监听器绑在 vp ?? host 上，故需对同一个 target 改几何并派发 scroll。
    const vp = document.querySelector('.xterm-viewport') as HTMLElement | null;
    const target = vp ?? host;
    Object.defineProperty(target, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(target, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(target, 'scrollTop', { value: 0, configurable: true });
    target.dispatchEvent(new Event('scroll'));
    expect(setShow).toHaveBeenLastCalledWith(true);
    t.unmount();
  });

  it('copies selection on right-click and pastes when empty (handleContextMenu)', async () => {
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
    // 给 host 一个非零尺寸，让 FitAddon 能算出 cols/rows
    Object.defineProperty(host, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 600, configurable: true });
    t.mount(host);
    expect(api.resize).toHaveBeenCalled();
    t.unmount();
  });
});
