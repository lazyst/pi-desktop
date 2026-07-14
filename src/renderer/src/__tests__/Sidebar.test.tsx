// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Sidebar } from '../components/Sidebar';
import type { SessionStatus } from '../types';

const sessions = [
  { key: 'k1', cwd: 'C:\\Users\\hcz\\.pi-agent', name: 'e2e-session' },
  { key: 'k2', cwd: 'C:\\Users\\hcz\\project', name: 'other-session' },
];

function renderSidebar(statusMap: Record<string, SessionStatus> = {}) {
  const api = {
    listSessions: vi.fn(),
    openSession: vi.fn(),
    terminate: vi.fn(),
    input: vi.fn(), resize: vi.fn(), onData: vi.fn(), onStatus: vi.fn(), onExit: vi.fn(),
  };
  (window as any).pi = api;
  const onOpen = vi.fn(), onTerminate = vi.fn();
  render(<Sidebar sessions={sessions} statusMap={statusMap} onOpen={onOpen} onTerminate={onTerminate} />);
  return { api, onOpen, onTerminate };
}

describe('Sidebar', () => {
  it('renders cwd groups and sessions from disk + live', async () => {
    renderSidebar();
    expect(await screen.findByText(/C:\\Users\\hcz\\.pi-agent/)).toBeInTheDocument();
    expect(screen.getByText('e2e-session')).toBeInTheDocument();
    expect(screen.getByText('other-session')).toBeInTheDocument();
  });
  it('shows green dot only when status running', async () => {
    renderSidebar({ k1: 'running' });
    const item = (await screen.findByText('e2e-session')).closest('.session-item')!;
    expect(item.querySelector('.dot.running')).toBeInTheDocument();
    // k2 is not running -> no green dot
    const item2 = (await screen.findByText('other-session')).closest('.session-item')!;
    expect(item2.querySelector('.dot.running')).toBeNull();
  });
  it('clicking a session opens it by key', async () => {
    const { onOpen } = renderSidebar({ k1: 'running' });
    fireEvent.click(await screen.findByText('e2e-session'));
    expect(onOpen).toHaveBeenCalledWith({ key: 'k1' });
  });
  it('hover terminate calls onTerminate', async () => {
    const { onTerminate } = renderSidebar({ k1: 'running' });
    const item = (await screen.findByText('e2e-session')).closest('.session-item')!;
    fireEvent.click(item.querySelector('.terminate')!);
    expect(onTerminate).toHaveBeenCalledWith('k1');
  });
});
