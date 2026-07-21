// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { SessionChannel, IntegratedChannel, UnifiedChannel } from '../components/terminalChannel';
import type { PiApi } from '../ipc';

// 构造一个可观测的 mock PiApi：记录各 IPC 调用，并允许手动触发事件回调。
function makeMockPi() {
  const handlers = {
    onData: [] as Array<(key: string, data: string) => void>,
    onExit: [] as Array<(key: string) => void>,
    onStatus: [] as Array<(key: string, status: string) => void>,
    onTerminalData: [] as Array<(id: string, data: string) => void>,
    onTerminalExit: [] as Array<(id: string) => void>,
  };
  const pi = {
    input: vi.fn(),
    resize: vi.fn(),
    terminalInput: vi.fn(),
    terminalResize: vi.fn(),
    onData: vi.fn((cb: (key: string, data: string) => void) => {
      handlers.onData.push(cb);
      return () => {
        const i = handlers.onData.indexOf(cb);
        if (i >= 0) handlers.onData.splice(i, 1);
      };
    }),
    onExit: vi.fn((cb: (key: string) => void) => {
      handlers.onExit.push(cb);
      return () => {
        const i = handlers.onExit.indexOf(cb);
        if (i >= 0) handlers.onExit.splice(i, 1);
      };
    }),
    onStatus: vi.fn((cb: (key: string, status: string) => void) => {
      handlers.onStatus.push(cb);
      return () => {
        const i = handlers.onStatus.indexOf(cb);
        if (i >= 0) handlers.onStatus.splice(i, 1);
      };
    }),
    onTerminalData: vi.fn((cb: (id: string, data: string) => void) => {
      handlers.onTerminalData.push(cb);
      return () => {
        const i = handlers.onTerminalData.indexOf(cb);
        if (i >= 0) handlers.onTerminalData.splice(i, 1);
      };
    }),
    onTerminalExit: vi.fn((cb: (id: string) => void) => {
      handlers.onTerminalExit.push(cb);
      return () => {
        const i = handlers.onTerminalExit.indexOf(cb);
        if (i >= 0) handlers.onTerminalExit.splice(i, 1);
      };
    }),
  } as unknown as PiApi & {
    _fire: (type: keyof typeof handlers, ...args: any[]) => void;
  };
  (pi as any)._fire = (type: keyof typeof handlers, ...args: any[]) => {
    for (const cb of handlers[type]) (cb as any)(...args);
  };
  return pi as PiApi & { _fire: (type: keyof typeof handlers, ...args: any[]) => void };
}

describe('SessionChannel', () => {
  it('onData 只回调匹配 sessionKey 的数据，忽略其它 key', () => {
    const pi = makeMockPi();
    const ch = new SessionChannel(pi, 'live-1');
    const cb = vi.fn();
    ch.onData(cb);

    pi._fire('onData', 'live-1', 'hello');
    pi._fire('onData', 'live-2', 'noise');
    pi._fire('onData', 'live-1', 'world');

    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenNthCalledWith(1, 'hello');
    expect(cb).toHaveBeenNthCalledWith(2, 'world');
  });

  it('onExit 只回调匹配 sessionKey 的退出', () => {
    const pi = makeMockPi();
    const ch = new SessionChannel(pi, 'live-1');
    const cb = vi.fn();
    ch.onExit(cb);

    pi._fire('onExit', 'live-2');
    pi._fire('onExit', 'live-1');

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('send 转发到 pi.input(key, data)', () => {
    const pi = makeMockPi();
    const ch = new SessionChannel(pi, 'live-9');
    ch.send('abc');
    expect(pi.input).toHaveBeenCalledTimes(1);
    expect(pi.input).toHaveBeenCalledWith('live-9', 'abc');
  });

  it('resize 转发到 pi.resize(key, cols, rows)', () => {
    const pi = makeMockPi();
    const ch = new SessionChannel(pi, 'live-9');
    ch.resize(80, 24);
    expect(pi.resize).toHaveBeenCalledTimes(1);
    expect(pi.resize).toHaveBeenCalledWith('live-9', 80, 24);
  });

  it('onData / onExit 取消订阅后不再回调', () => {
    const pi = makeMockPi();
    const ch = new SessionChannel(pi, 'live-1');
    const cbData = vi.fn();
    const cbExit = vi.fn();
    const offData = ch.onData(cbData);
    const offExit = ch.onExit(cbExit);

    offData();
    offExit();
    pi._fire('onData', 'live-1', 'x');
    pi._fire('onExit', 'live-1');

    expect(cbData).not.toHaveBeenCalled();
    expect(cbExit).not.toHaveBeenCalled();
  });
});

describe('IntegratedChannel', () => {
  it('onData 只回调匹配 terminalId 的数据', () => {
    const pi = makeMockPi();
    const ch = new IntegratedChannel(pi, 'term-1');
    const cb = vi.fn();
    ch.onData(cb);

    pi._fire('onTerminalData', 'term-2', 'noise');
    pi._fire('onTerminalData', 'term-1', 'hi');

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('hi');
  });

  it('onExit 只回调匹配 terminalId 的退出', () => {
    const pi = makeMockPi();
    const ch = new IntegratedChannel(pi, 'term-1');
    const cb = vi.fn();
    ch.onExit(cb);

    pi._fire('onTerminalExit', 'term-2');
    pi._fire('onTerminalExit', 'term-1');

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('send 转发到 pi.terminalInput(id, data)', () => {
    const pi = makeMockPi();
    const ch = new IntegratedChannel(pi, 'term-7');
    ch.send('xyz');
    expect(pi.terminalInput).toHaveBeenCalledTimes(1);
    expect(pi.terminalInput).toHaveBeenCalledWith('term-7', 'xyz');
  });

  it('resize 转发到 pi.terminalResize(id, cols, rows)', () => {
    const pi = makeMockPi();
    const ch = new IntegratedChannel(pi, 'term-7');
    ch.resize(120, 40);
    expect(pi.terminalResize).toHaveBeenCalledTimes(1);
    expect(pi.terminalResize).toHaveBeenCalledWith('term-7', 120, 40);
  });

  it('onData / onExit 取消订阅后不再回调', () => {
    const pi = makeMockPi();
    const ch = new IntegratedChannel(pi, 'term-1');
    const cbData = vi.fn();
    const cbExit = vi.fn();
    const offData = ch.onData(cbData);
    const offExit = ch.onExit(cbExit);

    offData();
    offExit();
    pi._fire('onTerminalData', 'term-1', 'x');
    pi._fire('onTerminalExit', 'term-1');

    expect(cbData).not.toHaveBeenCalled();
    expect(cbExit).not.toHaveBeenCalled();
  });
});

describe('UnifiedChannel', () => {
  // UnifiedChannel 与 IntegratedChannel 共享相同的 term:* IPC 方法
  // （onTerminalData / onTerminalExit / terminalInput / terminalResize），
  // 但语义上 UnifiedChannel 收编了 SessionChannel + IntegratedChannel，
  // 是未来新代码的首选渠道。测试覆盖确保两者行为一致。

  it('onData 只回调匹配 id 的数据，忽略其它 id', () => {
    const pi = makeMockPi();
    const ch = new UnifiedChannel(pi, 'unified-1');
    const cb = vi.fn();
    ch.onData(cb);

    pi._fire('onTerminalData', 'unified-2', 'noise');
    pi._fire('onTerminalData', 'unified-1', 'hello');
    pi._fire('onTerminalData', 'unified-1', 'world');

    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenNthCalledWith(1, 'hello');
    expect(cb).toHaveBeenNthCalledWith(2, 'world');
  });

  it('onExit 只回调匹配 id 的退出', () => {
    const pi = makeMockPi();
    const ch = new UnifiedChannel(pi, 'unified-1');
    const cb = vi.fn();
    ch.onExit(cb);

    pi._fire('onTerminalExit', 'unified-2');
    pi._fire('onTerminalExit', 'unified-1');

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('send 转发到 pi.terminalInput(id, data)', () => {
    const pi = makeMockPi();
    const ch = new UnifiedChannel(pi, 'unified-7');
    ch.send('xyz');
    expect(pi.terminalInput).toHaveBeenCalledTimes(1);
    expect(pi.terminalInput).toHaveBeenCalledWith('unified-7', 'xyz');
  });

  it('resize 转发到 pi.terminalResize(id, cols, rows)', () => {
    const pi = makeMockPi();
    const ch = new UnifiedChannel(pi, 'unified-7');
    ch.resize(120, 40);
    expect(pi.terminalResize).toHaveBeenCalledTimes(1);
    expect(pi.terminalResize).toHaveBeenCalledWith('unified-7', 120, 40);
  });

  it('onData / onExit 取消订阅后不再回调', () => {
    const pi = makeMockPi();
    const ch = new UnifiedChannel(pi, 'unified-1');
    const cbData = vi.fn();
    const cbExit = vi.fn();
    const offData = ch.onData(cbData);
    const offExit = ch.onExit(cbExit);

    offData();
    offExit();
    pi._fire('onTerminalData', 'unified-1', 'x');
    pi._fire('onTerminalExit', 'unified-1');

    expect(cbData).not.toHaveBeenCalled();
    expect(cbExit).not.toHaveBeenCalled();
  });
});
