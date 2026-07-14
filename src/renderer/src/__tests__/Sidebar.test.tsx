// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Sidebar } from '../components/Sidebar';
import type { SessionStatus } from '../types';

const sessions = [
  { key: 'k1', cwd: 'C:\\Users\\hcz\\.pi-agent', name: 'e2e-session', status: 'running' as SessionStatus },
  { key: 'k2', cwd: 'C:\\Users\\hcz\\project', name: 'other-session', status: 'running' as SessionStatus },
];

function renderSidebar(statusMap: Record<string, SessionStatus> = {}) {
  const api = {
    listSessions: vi.fn(),
    openSession: vi.fn(),
    terminate: vi.fn(),
  };
  (window as any).pi = api;
  const onOpen = vi.fn(), onTerminate = vi.fn();
  render(<Sidebar sessions={sessions} statusMap={statusMap} onOpen={onOpen} onTerminate={onTerminate} />);
  return { api, onOpen, onTerminate };
}

describe('Sidebar', () => {
  it('renders cwd groups', () => {
    renderSidebar();
    expect(screen.getByText(/C:\\Users\\hcz\\.pi-agent/)).toBeInTheDocument();
    expect(screen.getByText(/C:\\Users\\hcz\\project/)).toBeInTheDocument();
  });
  it('shows green dot when status running (and defaults to running)', () => {
    renderSidebar({ k1: 'running' });
    const item = screen.getByText('e2e-session').closest('.session-item')!;
    expect(item.querySelector('.dot.running')).toBeInTheDocument();
    // k2 has no statusMap entry → defaults to running
    const item2 = screen.getByText('other-session').closest('.session-item')!;
    expect(item2.querySelector('.dot.running')).toBeInTheDocument();
  });
  it('clicking a session opens it by key', () => {
    const { onOpen } = renderSidebar({ k1: 'running' });
    fireEvent.click(screen.getByText('e2e-session'));
    expect(onOpen).toHaveBeenCalledWith({ key: 'k1' });
  });
  it('hover terminate calls onTerminate', () => {
    const { onTerminate } = renderSidebar({ k1: 'running' });
    const item = screen.getByText('e2e-session').closest('.session-item')!;
    fireEvent.click(item.querySelector('.terminate')!);
    expect(onTerminate).toHaveBeenCalledWith('k1');
  });
});
