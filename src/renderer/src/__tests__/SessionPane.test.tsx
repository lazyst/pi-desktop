// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { SessionPane } from '../components/SessionPane';
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

describe('SessionPane (React 壳，经 PaneManager 驱动)', () => {
  it('renders a terminal-host div with session key and active class', () => {
    const api = makeApi();
    (window as any).pi = api;
    const { container } = render(<SessionPane sessionKey="k" active={true} />);
    const host = container.querySelector('.terminal-host') as HTMLElement;
    expect(host).toBeTruthy();
    expect(host.getAttribute('data-session')).toBe('k');
    expect(host.className).toContain('active');
  });

  it('does not throw on right-click (forwards to XtermTerminal.handleContextMenu via PaneManager)', () => {
    const api = makeApi();
    (window as any).pi = api;
    const { container } = render(<SessionPane sessionKey="k" active={true} />);
    const host = container.querySelector('.terminal-host') as HTMLElement;
    expect(() => fireEvent.contextMenu(host)).not.toThrow();
  });

  // keep-alive（对齐 VS Code setVisible 不析构语义）：active 切到 false 再切回 true，
  // 终端实例不应被销毁重建（即 term.open 不重复触发、实例存活）。
  it('keeps the terminal instance alive across active toggles (no remount)', () => {
    const api = makeApi();
    (window as any).pi = api;
    const { container, rerender } = render(<SessionPane sessionKey="k" active={true} />);
    const host = container.querySelector('.terminal-host') as HTMLElement;
    expect(host.className).toContain('active');
    // 切到非 active：不应抛错，实例保留（display:none 由 CSS 控制）。
    rerender(<SessionPane sessionKey="k" active={false} />);
    expect(host.className).not.toContain('active');
    // 切回 active：实例仍在、未重建（不抛错）。
    expect(() => rerender(<SessionPane sessionKey="k" active={true} />)).not.toThrow();
    expect(host.className).toContain('active');
  });
});
