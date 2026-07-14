// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Sidebar } from '../components/Sidebar';
import type { SessionStatus } from '../types';

const sessions = [
  { key: 'k1', cwd: 'C:\\Users\\hcz\\.pi-agent', name: 'e2e-session' },
  { key: 'k2', cwd: 'C:\\Users\\hcz\\project', name: 'other-session' },
];

function renderSidebar(overrides: any = {}) {
  const onOpen = vi.fn();
  const onTerminate = vi.fn();
  const onPickDirectory = vi.fn();
  const onTogglePin = vi.fn();
  const onDeleteSession = vi.fn();
  (window as any).pi = {
    listSessions: vi.fn(), openSession: vi.fn(), terminate: vi.fn(),
    input: vi.fn(), resize: vi.fn(), onData: vi.fn(), onStatus: vi.fn(), onExit: vi.fn(),
  };
  const utils = render(
    <Sidebar
      sessions={overrides.sessions ?? sessions}
      statusMap={overrides.statusMap ?? {}}
      activeKey={overrides.activeKey}
      pinned={overrides.pinned ?? []}
      onOpen={onOpen}
      onTerminate={onTerminate}
      onPickDirectory={onPickDirectory}
      onTogglePin={onTogglePin}
      onDeleteSession={overrides.onDeleteSession ?? onDeleteSession}
    />,
  );
  return { onOpen, onTerminate, onPickDirectory, onTogglePin, onDeleteSession, ...utils };
}

describe('Sidebar', () => {
  it('no longer renders a top-level "+ 会话" button', () => {
    renderSidebar();
    expect(screen.queryByText('+ 会话')).toBeNull();
  });

  it('"+ 目录" triggers onPickDirectory (native picker)', () => {
    const { onPickDirectory } = renderSidebar();
    fireEvent.click(screen.getByText('+ 目录'));
    expect(onPickDirectory).toHaveBeenCalled();
  });

  it('renders cwd groups and sessions from the sessions prop', async () => {
    renderSidebar();
    expect(await screen.findByText(/C:\\Users\\hcz\\.pi-agent/)).toBeInTheDocument();
    expect(screen.getByText('e2e-session')).toBeInTheDocument();
    expect(screen.getByText('other-session')).toBeInTheDocument();
  });

  it('clicking new-session action opens a session in that cwd', () => {
    const { onOpen } = renderSidebar();
    fireEvent.click(screen.getByLabelText('在 C:\\Users\\hcz\\project 新建会话'));
    expect(onOpen).toHaveBeenCalledWith({ cwd: 'C:\\Users\\hcz\\project' });
  });

  it('clicking pin action toggles pin for that cwd', () => {
    const { onTogglePin } = renderSidebar();
    fireEvent.click(screen.getByLabelText('置顶 C:\\Users\\hcz\\project'));
    expect(onTogglePin).toHaveBeenCalledWith('C:\\Users\\hcz\\project');
  });

  it('pins a group: adds pinned class and sorts it first', () => {
    const { container } = renderSidebar({ pinned: ['C:\\Users\\hcz\\project'] });
    const groups = container.querySelectorAll('.group');
    expect(groups.length).toBe(2);
    expect(groups[0]).toHaveClass('pinned');
    expect(groups[0].textContent).toContain('C:\\Users\\hcz\\project');
    expect(groups[1].textContent).toContain('C:\\Users\\hcz\\.pi-agent');
  });

  it('clicking a session opens it by key', async () => {
    const { onOpen } = renderSidebar({ statusMap: { k1: 'running' } });
    fireEvent.click(await screen.findByText('e2e-session'));
    expect(onOpen).toHaveBeenCalledWith({ key: 'k1' });
  });

  it('hover terminate calls onTerminate', async () => {
    const { onTerminate } = renderSidebar({ statusMap: { k1: 'running' } });
    const item = (await screen.findByText('e2e-session')).closest('.session-item')!;
    fireEvent.click(item.querySelector('.terminate')!);
    expect(onTerminate).toHaveBeenCalledWith('k1');
  });

  it('marks the active session item with .active class', () => {
    const { container } = renderSidebar({ statusMap: { k1: 'running' }, activeKey: 'k1' });
    const active = screen.getByText('e2e-session').closest('.session-item')!;
    expect(active).toHaveClass('active');
    expect(container.querySelector('.session-item:not(.active)')).not.toHaveClass('active');
  });

  it('right-click a session opens a context menu with 删除会话', async () => {
    const { onDeleteSession } = renderSidebar({ statusMap: { k1: 'running' } });
    const item = screen.getByText('e2e-session').closest('.session-item')!;
    fireEvent.contextMenu(item);
    const menuItem = await screen.findByText('删除会话');
    expect(menuItem).toBeInTheDocument();
    fireEvent.click(menuItem);
    expect(onDeleteSession).toHaveBeenCalledWith('k1', 'e2e-session');
  });
});
