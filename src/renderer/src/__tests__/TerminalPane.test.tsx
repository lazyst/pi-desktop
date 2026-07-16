// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { TerminalPane } from '../components/TerminalPane';
import type { PiApi } from '../ipc';

// 无头 jsdom 无 WebGL 上下文，真实 WebglAddon 在 mount() 激活时会抛错并污染测试输出。
// 用轻量 mock 替换，只验证渲染器加载调用、不触发真实 GPU。
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
  } as unknown as PiApi;
}

describe('TerminalPane (React 壳)', () => {
  it('renders a terminal-host div with session key and active class', () => {
    const api = makeApi();
    (window as any).pi = api;
    const { container } = render(<TerminalPane sessionKey="k" active={true} />);
    const host = container.querySelector('.terminal-host') as HTMLElement;
    expect(host).toBeTruthy();
    expect(host.getAttribute('data-session')).toBe('k');
    expect(host.className).toContain('active');
  });

  it('does not show jump-bottom button when inactive', () => {
    const api = makeApi();
    (window as any).pi = api;
    const { container } = render(<TerminalPane sessionKey="k" active={false} />);
    expect(container.querySelector('.jump-bottom')).toBeNull();
  });

  it('shows jump-bottom button when active and wires click to scrollToBottom', () => {
    const api = makeApi();
    (window as any).pi = api;
    const { container } = render(<TerminalPane sessionKey="k" active={true} />);
    const btn = container.querySelector('.jump-bottom') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    // 点击不应抛错（壳转发到 XtermTerminal.scrollToBottom，已 mock WebGL）。
    expect(() => fireEvent.click(btn)).not.toThrow();
  });

  it('does not throw on right-click (forwards to XtermTerminal.handleContextMenu)', () => {
    const api = makeApi();
    (window as any).pi = api;
    const { container } = render(<TerminalPane sessionKey="k" active={true} />);
    const host = container.querySelector('.terminal-host') as HTMLElement;
    expect(() => fireEvent.contextMenu(host)).not.toThrow();
  });
});
