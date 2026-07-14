// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Sidebar } from '../components/Sidebar';

const groups = [
  { cwd: 'C:\\Users\\hcz\\.pi-agent', sessions: [
    { key: '/a/s1.jsonl', name: '2026-07-03 19:07', time: '2026-07-03 19:07' },
  ]},
];

function renderSidebar(statusMap = {}) {
  const api = {
    listSessions: vi.fn().mockResolvedValue(groups),
    openSession: vi.fn().mockResolvedValue({ key: 'k', cwd: 'x', name: 'n', status: 'running' }),
    terminate: vi.fn().mockResolvedValue(undefined),
    input: vi.fn(), resize: vi.fn(), onData: vi.fn(), onStatus: vi.fn(), onExit: vi.fn(),
  };
  (window as any).pi = api;
  const onOpen = vi.fn(), onTerminate = vi.fn();
  render(<Sidebar statusMap={statusMap} onOpen={onOpen} onTerminate={onTerminate} />);
  return { api, onOpen, onTerminate };
}

describe('Sidebar', () => {
  it('renders groups and sessions', async () => {
    renderSidebar();
    expect(await screen.findByText(/C:\\Users\\hcz/)).toBeInTheDocument();
    expect(screen.getByText('2026-07-03 19:07')).toBeInTheDocument();
  });
  it('shows green dot when status running', async () => {
    renderSidebar({ '/a/s1.jsonl': 'running' });
    const dot = await screen.findByText('2026-07-03 19:07');
    const item = dot.closest('.session-item')!;
    expect(item.querySelector('.dot.running')).toBeInTheDocument();
  });
  it('clicking a session opens it', async () => {
    const { onOpen } = renderSidebar();
    fireEvent.click(await screen.findByText('2026-07-03 19:07'));
    expect(onOpen).toHaveBeenCalledWith({ key: '/a/s1.jsonl' });
  });
  it('hover terminate calls onTerminate', async () => {
    const { onTerminate } = renderSidebar({ '/a/s1.jsonl': 'running' });
    const item = (await screen.findByText('2026-07-03 19:07')).closest('.session-item')!;
    fireEvent.click(item.querySelector('.terminate')!);
    expect(onTerminate).toHaveBeenCalledWith('/a/s1.jsonl');
  });
});
