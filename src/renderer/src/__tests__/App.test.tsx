// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from '../App';

describe('App', () => {
  it('passes only disk sessions to the sidebar (no live merge)', async () => {
    const api = {
      listSessions: vi.fn().mockResolvedValue([]),
      openSession: vi.fn(),
      terminate: vi.fn(),
      input: vi.fn(), resize: vi.fn(),
      onData: vi.fn(), onStatus: vi.fn(), onExit: vi.fn(), onIndex: vi.fn(), onRelink: vi.fn(),
      pickDirectory: vi.fn(), debug: vi.fn(),
    };
    (window as any).pi = api;
    render(<App />);
    // onIndex 被订阅（用于后续晋升），初始 listSessions 被调用
    expect(api.onIndex).toHaveBeenCalled();
    expect(api.listSessions).toHaveBeenCalled();
    // 侧边栏存在，但空列表时不渲染任何 session-item
    expect(await screen.findByText('会话', { exact: true })).toBeInTheDocument();
    expect(screen.queryByText('live-xyz')).toBeNull();
  });
});
