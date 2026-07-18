// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { XtermTerminal } from '../components/XtermTerminal';
import { DecorationAddon } from '../components/decorationAddon';
import type { PiApi } from '../ipc';

// 用可控的 mock 替换 addons，验证加载/回退，不触发真实 GPU / 剪贴板 / unicode 解析。
const hoist = vi.hoisted(() => ({
  webglThrow: false,
  webglActivateCalls: 0,
  webglContextLossHandler: null as (() => void) | null,
  webglClearAtlasCalls: 0,
  clipboardActivateCalls: 0,
  unicodeActivateCalls: 0,
  registerDecorationCalls: 0,
}));
vi.mock('@xterm/addon-webgl', () => {
  class WebglAddon {
    disposed = false;
    // 捕获 onContextLoss 回调，供测试手动触发上下文丢失（对齐 VS Code _enableWebglRenderer）。
    onContextLoss(cb: () => void) {
      hoist.webglContextLossHandler = cb;
    }
    clearTextureAtlas() {
      hoist.webglClearAtlasCalls++;
    }
    activate() {
      hoist.webglActivateCalls++;
      if (hoist.webglThrow) throw new Error('WebGL unavailable');
    }
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
    // 背压回传（对齐 VS Code acknowledgeDataEvent）：记录渲染端消费的字节数。
    acknowledgeDataEvent: vi.fn(),
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
    // jsdom 无布局引擎，proposeDimensions 默认返回 undefined；mock 出有效目标维度，
    // 对齐真实浏览器里 mount 后首帧用宿主尺寸校准终端、通知 PTY 的路径。
    const propose = vi
      .spyOn(FitAddon.prototype, 'proposeDimensions')
      .mockReturnValue({ cols: 100, rows: 30 });
    const fit = vi.spyOn(FitAddon.prototype, 'fit').mockImplementation(() => {});
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    const host = mountHost();
    Object.defineProperty(host, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 600, configurable: true });
    t.mount(host);
    expect(fit).toHaveBeenCalled();
    expect(api.resize).toHaveBeenCalled();
    propose.mockRestore();
    fit.mockRestore();
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

  // WebGL 上下文丢失恢复（对齐 VS Code _webglAddon.onContextLoss）：GPU 上下文丢失后整会话
  // 降级 DOM 渲染器，不重建 WebGL、不崩溃，并触发一次尺寸重测。
  it('degrades to DOM renderer on WebGL context loss without throwing', () => {
    const api = makeApi();
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    expect(hoist.webglActivateCalls).toBeGreaterThanOrEqual(1);
    // 触发上下文丢失（模拟驱动崩溃 / 资源回收）。
    expect(typeof hoist.webglContextLossHandler).toBe('function');
    expect(() => hoist.webglContextLossHandler!()).not.toThrow();
    // 上下文丢失后实例仍可用：后续写入不应抛错。
    const onData = (api.onData as any).mock.calls[0][0] as (k: string, d: string) => void;
    expect(() => onData('k', 'after-loss')).not.toThrow();
    t.unmount();
  });

  // forceRedraw()：清纹理图集（对齐 VS Code forceRedraw/clearTextureAtlas），换主题不残留旧纹理。
  it('forceRedraw() clears the WebGL texture atlas', () => {
    const api = makeApi();
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    hoist.webglClearAtlasCalls = 0;
    t.forceRedraw();
    expect(hoist.webglClearAtlasCalls).toBeGreaterThanOrEqual(1);
    t.unmount();
  });

  // Shell Integration 流分割（对齐 VS Code _onProcessData）：含 OSC 633 序列的数据应被切成
  // 多段、各段独立 write，命令边界不丢。无 OSC 633 时原样单次 write。
  it('segments data by OSC 633 shell-integration sequences before writing', async () => {
    const api = makeApi();
    const writes: string[] = [];
    vi.spyOn(Terminal.prototype, 'write').mockImplementation(function (this: unknown, data: string | Uint8Array, cb?: () => void) {
      writes.push(data as string);
      cb?.();
    });
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    const onData = (api.onData as any).mock.calls[0][0] as (k: string, d: string) => void;
    const chunk = 'output-before\x1b]633;C\x07middle\x1b]633;D\x07after';
    onData('k', chunk);
    await vi.waitFor(() => expect(writes.length).toBeGreaterThanOrEqual(3));
    // 三段按顺序写入、拼接还原为原始数据，且命令边界标记完整保留。
    expect(writes.join('')).toBe(chunk);
    expect(writes.some((w) => w.includes('\x1b]633;C\x07'))).toBe(true);
    expect(writes.some((w) => w.includes('\x1b]633;D\x07'))).toBe(true);
    t.unmount();
  });

  // 背压回传（对齐 VS Code acknowledgeDataEvent）：每批 write 解析完成后通知主进程消费字节数。
  it('acknowledges consumed bytes via pi.acknowledgeDataEvent after each write', async () => {
    const api = makeApi();
    vi.spyOn(Terminal.prototype, 'write').mockImplementation(function (this: unknown, _d: string | Uint8Array, cb?: () => void) {
      cb?.(); // 立即解析完成
    });
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    const onData = (api.onData as any).mock.calls[0][0] as (k: string, d: string) => void;
    onData('k', 'hello world');
    await vi.waitFor(() => expect(api.acknowledgeDataEvent).toHaveBeenCalled());
    // 回传 key 与本次消费字节数（'hello world'.length === 11）。
    expect((api.acknowledgeDataEvent as any).mock.calls[0]).toEqual(['k', 11]);
    t.unmount();
  });

  // Decoration 覆盖层（对齐 VS Code DecorationAddon 差分 overlay 基座）：registerLineDecoration
  // 经 DecorationAddon.registerCommandDecoration 锚定 marker；clearDecorations 释放全部装饰。
  it('registerLineDecoration / clearDecorations delegate to the DecorationAddon overlay', () => {
    const api = makeApi();
    // marker 是 IMarker 形态的最小桩：DecorationAddon.registerCommandDecoration 需要 marker.id。
    const fakeMarker = { id: 42, dispose: vi.fn() } as any;
    const fakeDeco = { marker: fakeMarker, dispose: vi.fn(), onRender: vi.fn(), onDispose: vi.fn(), element: undefined, isDisposed: false } as any;
    const registerSpy = vi
      .spyOn(DecorationAddon.prototype, 'registerCommandDecoration')
      .mockReturnValue(fakeDeco);
    const clearSpy = vi.spyOn(DecorationAddon.prototype, 'clearDecorations').mockImplementation(() => {});
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    const deco = t.registerLineDecoration(fakeMarker, { marker: fakeMarker });
    expect(registerSpy).toHaveBeenCalled();
    expect(deco).toBe(fakeDeco);
    t.clearDecorations();
    expect(clearSpy).toHaveBeenCalled();
    registerSpy.mockRestore();
    clearSpy.mockRestore();
    t.unmount();
  });

  // 不可见终端的 idle 延迟 resize（对齐 VS Code runWhenWindowIdle）：非 active 时 scheduleResize
  // 不立即执行、推迟到 idle 后再经 TerminalResizeDebouncer 分别触发 _resizeX / _resizeY；
  // 可见时仍走同步/防抖。
  it('defers resize to idle when not active (runWhenWindowIdle semantics)', async () => {
    const api = makeApi();
    const propose = vi
      .spyOn(FitAddon.prototype, 'proposeDimensions')
      .mockReturnValue({ cols: 100, rows: 30 });
    const resizeX = vi
      .spyOn(XtermTerminal.prototype as any, '_resizeX')
      .mockImplementation(() => {});
    const resizeY = vi
      .spyOn(XtermTerminal.prototype as any, '_resizeY')
      .mockImplementation(() => {});
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    const host = mountHost();
    Object.defineProperty(host, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 600, configurable: true });
    t.mount(host);
    // 模拟「大 buffer」（行数 ≥ 200，对齐 VS Code StartDebouncingThreshold），使非 active 时
    // resize 走 idle 延迟而非立即路径。
    Object.defineProperty((t as any).term, 'buffer', {
      configurable: true,
      value: { active: { length: 500, viewportY: 0, baseY: 400 } },
    });
    // mount 内部已调过 doResize(true)（首帧对齐尺寸，走 immediate），清零后再测 idle 延迟语义。
    resizeX.mockClear();
    resizeY.mockClear();
    // 模拟隐藏（keep-alive 非 active）。
    (t as any).active = false;
    t.scheduleResize();
    // 立即不应执行（idle 延迟）。jsdom 无 requestIdleCallback，降级 setTimeout(0)。
    expect(resizeX).not.toHaveBeenCalled();
    expect(resizeY).not.toHaveBeenCalled();
    // 让出事件循环后 idle 回调触发 _resizeX / _resizeY。
    await new Promise((r) => setTimeout(r, 30));
    expect(resizeX).toHaveBeenCalled();
    expect(resizeY).toHaveBeenCalled();
    propose.mockRestore();
    resizeX.mockRestore();
    resizeY.mockRestore();
    t.unmount();
  });
});

  // —— 编辑快捷键：粘贴 / 复制 / 全选（对齐 VS Code 基础编辑交互）——
  describe('编辑快捷键（粘贴 / 复制 / 全选）', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('pasteText() 粘贴文本并归一化换行', () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      const paste = vi.spyOn((t as any).term, 'paste').mockImplementation(() => {});
      t.pasteText('hello\nworld');
      expect(paste).toHaveBeenCalledWith('hello\rworld');
      t.unmount();
    });

    it('pasteText() 粘贴纯文本（不手动包裹 bracketed 序列，由 xterm 内部处理）', () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      // 即便模拟 bracketed 模式开启，pasteText 也必须原样传纯文本给 term.paste，
      // 不能自己拼接 \x1b[200~/\x1b[201~（否则会被 PTY 当字面量打印出 [200~）。
      Object.defineProperty((t as any).term, 'modes', {
        configurable: true,
        value: { bracketedPasteMode: true },
      });
      const paste = vi.spyOn((t as any).term, 'paste').mockImplementation(() => {});
      t.pasteText('ls');
      expect(paste).toHaveBeenCalledWith('ls');
      t.unmount();
    });

    it('copySelection() 把选区写入系统剪贴板', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      const term = (t as any).term;
      vi.spyOn(term, 'hasSelection').mockReturnValue(true);
      vi.spyOn(term, 'getSelection').mockReturnValue('selected text');
      t.copySelection();
      expect(writeText).toHaveBeenCalledWith('selected text');
      t.unmount();
    });

    it('copySelection() 无选区时不写入剪贴板', () => {
      const writeText = vi.fn();
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      vi.spyOn((t as any).term, 'hasSelection').mockReturnValue(false);
      t.copySelection();
      expect(writeText).not.toHaveBeenCalled();
      t.unmount();
    });

    it('selectAll() 聚焦并全选', () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      const term = (t as any).term;
      const focus = vi.spyOn(term, 'focus').mockImplementation(() => {});
      const selectAll = vi.spyOn(term, 'selectAll').mockImplementation(() => {});
      t.selectAll();
      expect(focus).toHaveBeenCalled();
      expect(selectAll).toHaveBeenCalled();
      t.unmount();
    });

    it('clearSelection() 清空选区', () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      const clear = vi.spyOn((t as any).term, 'clearSelection').mockImplementation(() => {});
      t.clearSelection();
      expect(clear).toHaveBeenCalled();
      t.unmount();
    });

    it('pasteFromClipboard() 剪贴板含图片时落临时文件并粘贴路径', async () => {
      const fakePath = '/tmp/pi-paste-xxxx.png';
      const api = makeApi() as any;
      api.saveImage = vi.fn().mockResolvedValue(fakePath);
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      const paste = vi.spyOn((t as any).term, 'paste').mockImplementation(() => {});
      // ClipboardItem + blob
      const read = vi.fn().mockResolvedValue([
        { types: ['image/png'], getType: vi.fn().mockResolvedValue(new Blob(['x'], { type: 'image/png' })) },
      ]);
      const fakeClipboard = {
        read,
        readText: vi.fn(),
      };
      vi.stubGlobal('navigator', { clipboard: fakeClipboard });
      // FileReader 在 jsdom 可用，readAsDataURL 会把 blob 转 base64
      await t.pasteFromClipboard();
      await new Promise((r) => setTimeout(r, 20));
      expect(api.saveImage).toHaveBeenCalled();
      expect(paste).toHaveBeenCalledWith(fakePath);
      t.unmount();
    });

    it('mount() 注册快捷键拦截器（attachCustomKeyEventHandler）', () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      expect((t as any)._keydownHandler).toBeTypeOf('function');
      expect((t as any)._customKeyHandler).toBeTypeOf('function');
      t.unmount();
    });

    it('拦截器命中 Ctrl+V 时返回 false（阻止 xterm 把 Ctrl+V 当 \x16 输入）并触发粘贴', async () => {
      const readText = vi.fn().mockResolvedValue('clipboard-text');
      vi.stubGlobal('navigator', { clipboard: { readText } });
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      const term = (t as any).term as Terminal;
      const paste = vi.spyOn(term, 'paste').mockImplementation(() => {});
      const handler = (t as any)._customKeyHandler as (e: KeyboardEvent) => boolean;
      const ret = handler(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true }));
      expect(ret).toBe(false); // 拦截，阻止默认输入
      await new Promise((r) => setTimeout(r, 20));
      expect(paste).toHaveBeenCalledWith('clipboard-text');
      t.unmount();
    });

    it('拦截器命中 Ctrl+Shift+C 时返回 false 并复制选区', () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      const term = (t as any).term as Terminal;
      vi.spyOn(term, 'hasSelection').mockReturnValue(true);
      vi.spyOn(term, 'getSelection').mockReturnValue('sel');
      const handler = (t as any)._customKeyHandler as (e: KeyboardEvent) => boolean;
      const ret = handler(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, shiftKey: true }));
      expect(ret).toBe(false);
      expect(writeText).toHaveBeenCalledWith('sel');
      t.unmount();
    });

    it('普通按键（非 Ctrl 组合）拦截器返回 true，不拦截', () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      const handler = (t as any)._customKeyHandler as (e: KeyboardEvent) => boolean;
      expect(handler(new KeyboardEvent('keydown', { key: 'a' }))).toBe(true);
      t.unmount();
    });

    it('unmount() 清理快捷键幂等标记', () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      expect((t as any)._keydownHandler).toBeTypeOf('function');
      t.unmount();
      expect((t as any)._keydownHandler).toBeNull();
    });
  });

  describe('粘贴回归（防 [200~ 字面量泄漏）', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('pasteFromClipboard() 即便 bracketed paste 模式开启，发给 term.paste 的也只是纯文本', async () => {
      const readText = vi.fn().mockResolvedValue('echo hello');
      vi.stubGlobal('navigator', { clipboard: { readText } });
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      // 模拟 PTY 已开启 bracketed paste 模式
      Object.defineProperty((t as any).term, 'modes', {
        configurable: true,
        value: { bracketedPasteMode: true },
      });
      const paste = vi.spyOn((t as any).term, 'paste').mockImplementation(() => {});
      await t.pasteFromClipboard();
      await new Promise((r) => setTimeout(r, 20));
      const arg = paste.mock.calls[0]?.[0] as string;
      expect(arg).toBe('echo hello');
      expect(arg).not.toContain('\x1b[200~');
      expect(arg).not.toContain('[200~');
      t.unmount();
    });

    it('handleContextMenu() 无选区时粘贴，PTY 不会收到 [200~ 字面量', async () => {
      const readText = vi.fn().mockResolvedValue('ls -la');
      vi.stubGlobal('navigator', { clipboard: { readText } });
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      Object.defineProperty((t as any).term, 'modes', {
        configurable: true,
        value: { bracketedPasteMode: true },
      });
      vi.spyOn((t as any).term, 'hasSelection').mockReturnValue(false);
      const paste = vi.spyOn((t as any).term, 'paste').mockImplementation(() => {});
      t.handleContextMenu({ preventDefault: () => {} });
      await new Promise((r) => setTimeout(r, 20));
      const arg = paste.mock.calls[0]?.[0] as string;
      expect(arg).toBe('ls -la');
      expect(arg).not.toContain('[200~');
      t.unmount();
    });
  });
