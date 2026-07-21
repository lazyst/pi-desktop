// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { IntegratedPane } from '../components/IntegratedPane';
import { XtermTerminal } from '../components/XtermTerminal';
import { IntegratedChannel } from '../components/terminalChannel';
import type { PiApi } from '../ipc';

// 无头 jsdom 无 WebGL 上下文，用轻量 mock 替换真实 WebglAddon。
vi.mock('@xterm/addon-webgl', () => {
  class WebglAddon {
    activate() {}
    onContextLoss() {}
    dispose() {}
  }
  return { WebglAddon };
});

function makeApi() {
  return {
    listSessions: vi.fn(), openSession: vi.fn(), terminate: vi.fn(),
    input: vi.fn(), resize: vi.fn(), onData: vi.fn(() => () => {}), onStatus: vi.fn(() => () => {}),
    onExit: vi.fn(), pickDirectory: vi.fn(), debug: vi.fn(),
    destroyTerminal: vi.fn(async () => {}),
    terminalInput: vi.fn(), terminalResize: vi.fn(),
    onTerminalData: vi.fn(() => () => {}), onTerminalExit: vi.fn(() => () => {}),
  } as unknown as PiApi;
}

describe('IntegratedPane constructs XtermTerminal with IntegratedChannel', () => {
  beforeEach(() => {
    (window as any).pi = makeApi();
  });

  it('constructs an XtermTerminal whose channel is an IntegratedChannel instance', () => {
    // 拦截 mount 以捕获实例，并避免真实 xterm open（jsdom 无真实 DOM 测量）。
    let capturedChannel: unknown = undefined;
    const mountSpy = vi.spyOn(XtermTerminal.prototype, 'mount').mockImplementation(function (this: any) {
      capturedChannel = this.channel;
      this.mounted = true;
    });

    const { container } = render(
      <IntegratedPane terminalId="term-42" active={true} />,
    );

    // host div 渲染且带 data-terminal（标识该集成终端实例）。
    const host = container.querySelector('.integrated-terminal-host') as HTMLElement;
    expect(host).toBeTruthy();
    expect(host.getAttribute('data-terminal')).toBe('term-42');

    // XtermTerminal 被构造（mount 被调用），且注入的 channel 是 IntegratedChannel 实例。
    expect(mountSpy).toHaveBeenCalled();
    expect(capturedChannel).toBeInstanceOf(IntegratedChannel);

    mountSpy.mockRestore();
  });
});
