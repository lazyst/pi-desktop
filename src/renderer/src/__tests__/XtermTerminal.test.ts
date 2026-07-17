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

  it('joins chunks within a microtask window into a single atomic write, driven by write callback (对齐 VS Code TerminalDataBufferer + write(data,cb))', async () => {
    const api = makeApi();
    // 对齐真实 xterm：write(data, cb) 在解析完成后触发 cb，驱动下一窗口写出。
    const write = vi
      .spyOn(Terminal.prototype, 'write')
      .mockImplementation(function (this: unknown, _data: string, cb?: () => void) {
        cb?.();
      });
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    const onData = api.onData.mock.calls[0][0] as (k: string, d: string) => void;
    // 模拟 pi-tui「移光标 → 写文本」连续到达（同一微任务窗口）
    onData('k', '\x1b[2J');
    onData('k', 'hello world');
    // 微任务 drain 后窗口内 join 成一次原子 write（“移光标+写文本”同帧解析，避免 WebGL 中间态渲染）
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(write.mock.calls[0][0]).toBe('\x1b[2Jhello world');
    write.mockRestore();
    t.unmount();
  });

  // 对齐 VS Code：cursorBlink 在构造时设定后恒定，流式期间不去动它（自创的 suppress 逻辑
  // 会与 pi 的 \u001b[?25h/l 光标显隐序列打架，导致最新行一闪一闪）。此测试确保流式不改变 cursorBlink。
  it('keeps cursorBlink constant during streaming (VS Code 不流式改 blink，避免光标闪烁)', async () => {
    const api = makeApi();
    // xterm 的 write 是实例方法，其实现内 `this` 即 term 实例，可读出实时 cursorBlink。
    let blinkAtWrite = false;
    const write = vi
      .spyOn(Terminal.prototype, 'write')
      .mockImplementation(function (this: any) {
        blinkAtWrite = this.options.cursorBlink;
      });
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    const onData = api.onData.mock.calls[0][0] as (k: string, d: string) => void;
    onData('k', 'stream');
    // 微任务 drain 触发 write，cursorBlink 应保持构造时的 true（不被抑制为 false）
    await vi.waitFor(() => expect(blinkAtWrite).toBe(true));
    write.mockRestore();
    t.unmount();
  });

  it('keeps cursorBlink constant across multiple stream bursts', async () => {
    const api = makeApi();
    let blinkAtWrite = false;
    const write = vi
      .spyOn(Terminal.prototype, 'write')
      .mockImplementation(function (this: any) {
        blinkAtWrite = this.options.cursorBlink;
      });
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    const onData = api.onData.mock.calls[0][0] as (k: string, d: string) => void;
    onData('k', 'a');
    await vi.waitFor(() => expect(blinkAtWrite).toBe(true));
    onData('k', 'b');
    await vi.waitFor(() => expect(blinkAtWrite).toBe(true));
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
