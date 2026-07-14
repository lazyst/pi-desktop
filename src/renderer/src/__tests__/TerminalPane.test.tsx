// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { Terminal } from '@xterm/xterm';
import { TerminalPane } from '../components/TerminalPane';

function makeApi() {
  return {
    listSessions: vi.fn(), openSession: vi.fn(), terminate: vi.fn(),
    input: vi.fn(), resize: vi.fn(), onData: vi.fn(), onStatus: vi.fn(), onExit: vi.fn(),
    pickDirectory: vi.fn(), debug: vi.fn(),
  };
}

describe('TerminalPane', () => {
  it('forwards keystrokes to pi.input when active', () => {
    const api = makeApi();
    (window as any).pi = api;
    render(<TerminalPane sessionKey="k" active={true} />);
    expect(api.onData).toHaveBeenCalled();
  });

  it('shows jump-to-bottom button only when scrolled up, and clicks scrollToBottom', () => {
    const api = makeApi();
    (window as any).pi = api;
    const scrollToBottom = vi.spyOn(Terminal.prototype, 'scrollToBottom').mockImplementation(() => {});
    const { container } = render(<TerminalPane sessionKey="k" active={true} />);

    const btn = container.querySelector('.jump-bottom') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    // 初始贴底：无 visible
    expect(btn.className).not.toContain('visible');

    // 模拟滚动到顶部（未贴底）。优先驱动真实 viewport；
    // jsdom 下 xterm 不创建 .xterm-viewport，则用 host 兜底滚动几何。
    const vp = document.querySelector('.xterm-viewport') as HTMLElement | null;
    const host = container.querySelector('.terminal-host') as HTMLElement | null;
    const target = vp ?? host;
    if (target) {
      Object.defineProperty(target, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(target, 'clientHeight', { value: 400, configurable: true });
      Object.defineProperty(target, 'scrollTop', { value: 0, configurable: true });
      fireEvent.scroll(target);
    }
    expect(container.querySelector('.jump-bottom')!.className).toContain('visible');

    fireEvent.click(container.querySelector('.jump-bottom')!);
    expect(scrollToBottom).toHaveBeenCalled();
  });

  it('right-click with a selection copies it to the clipboard', () => {
    const api = makeApi();
    (window as any).pi = api;
    const hasSelection = vi.spyOn(Terminal.prototype, 'hasSelection').mockReturnValue(true);
    const getSelection = vi.spyOn(Terminal.prototype, 'getSelection').mockReturnValue('hello');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText, readText: vi.fn() },
    });
    const { container } = render(<TerminalPane sessionKey="k" active={true} />);
    const host = container.querySelector('.terminal-host') as HTMLElement;
    fireEvent.contextMenu(host);
    expect(writeText).toHaveBeenCalledWith('hello');
    hasSelection.mockRestore();
    getSelection.mockRestore();
  });

  it('right-click without a selection pastes from the clipboard', async () => {
    const api = makeApi();
    (window as any).pi = api;
    const hasSelection = vi.spyOn(Terminal.prototype, 'hasSelection').mockReturnValue(false);
    const paste = vi.spyOn(Terminal.prototype, 'paste').mockImplementation(() => {});
    const readText = vi.fn().mockResolvedValue('world');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(), readText },
    });
    const { container } = render(<TerminalPane sessionKey="k" active={true} />);
    const host = container.querySelector('.terminal-host') as HTMLElement;
    fireEvent.contextMenu(host);
    await vi.waitFor(() => expect(paste).toHaveBeenCalledWith('world'));
    hasSelection.mockRestore();
    paste.mockRestore();
  });
});
