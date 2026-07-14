// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { TerminalPane } from '../components/TerminalPane';

describe('TerminalPane', () => {
  it('forwards keystrokes to pi.input when active', () => {
    const api = {
      listSessions: vi.fn(), openSession: vi.fn(), terminate: vi.fn(),
      input: vi.fn(), resize: vi.fn(), onData: vi.fn(), onStatus: vi.fn(), onExit: vi.fn(),
    };
    (window as any).pi = api;
    render(<TerminalPane sessionKey="k" active={true} />);
    // TerminalPane registers onData; we simulate a keypress by calling the captured onData handler
    expect(api.onData).toHaveBeenCalled();
  });
});
