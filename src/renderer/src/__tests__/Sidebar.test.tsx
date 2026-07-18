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
  const onClearDirectory = vi.fn();
  const onEnterSelect = vi.fn();
  const onExitSelect = vi.fn();
  const onBatchDelete = vi.fn();
  const onToggleSelect = vi.fn();
  const onRemoveDir = vi.fn();
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
      selectionMode={overrides.selectionMode}
      selectedKeys={overrides.selectedKeys ?? new Set<string>()}
      onToggleSelect={overrides.onToggleSelect ?? onToggleSelect}
      onClearDirectory={overrides.onClearDirectory ?? onClearDirectory}
      onEnterSelect={overrides.onEnterSelect ?? onEnterSelect}
      onExitSelect={overrides.onExitSelect ?? onExitSelect}
      onBatchDelete={overrides.onBatchDelete ?? onBatchDelete}
      onRemoveDir={overrides.onRemoveDir ?? onRemoveDir}
      addedDirs={overrides.addedDirs ?? []}
    />,
  );
  return { onOpen, onTerminate, onPickDirectory, onTogglePin, onDeleteSession, onClearDirectory, onEnterSelect, onExitSelect, onBatchDelete, onToggleSelect, onRemoveDir, ...utils };
}

it('group “移除目录” action calls onRemoveDir with that cwd', () => {
  const { onRemoveDir } = renderSidebar();
  fireEvent.click(screen.getByLabelText('移除目录 C:\\Users\\hcz\\project'));
  expect(onRemoveDir).toHaveBeenCalledWith('C:\\Users\\hcz\\project');
});

it('renders a group for an added directory even when it has no sessions', () => {
  const { onOpen } = renderSidebar({ addedDirs: ['C:\\Users\\hcz\\empty-dir'] });
  const title = screen.getByText(/C:\\Users\\hcz\\empty-dir/);
  expect(title).toBeInTheDocument();
  const newBtn = screen.getByLabelText('在 C:\\Users\\hcz\\empty-dir 新建会话');
  fireEvent.click(newBtn);
  expect(onOpen).toHaveBeenCalledWith({ cwd: 'C:\\Users\\hcz\\empty-dir' });
});

it('group “清空” action calls onClearDirectory with that cwd', () => {
  const { onClearDirectory } = renderSidebar();
  fireEvent.click(screen.getByLabelText('清空 C:\\Users\\hcz\\project'));
  expect(onClearDirectory).toHaveBeenCalledWith('C:\\Users\\hcz\\project');
});

it('“管理” enters selection mode via onEnterSelect', () => {
  const { onEnterSelect } = renderSidebar();
  fireEvent.click(screen.getByText('管理'));
  expect(onEnterSelect).toHaveBeenCalled();
});

it('selection mode shows a checkbox per session and toggles selection', () => {
  const { onToggleSelect } = renderSidebar({ selectionMode: true, selectedKeys: new Set<string>(['k1']) });
  // header action bar appears
  expect(screen.getByText('已选 1 项')).toBeInTheDocument();
  expect(screen.queryByText('管理')).toBeNull(); // 常态“管理”按钮隐藏
  // 选中项渲染 checkbox 且为 checked
  const item = screen.getByText('e2e-session').closest('.session-item')!;
  expect(item).toHaveClass('selectable', 'selected');
  const box = item.querySelector('input.select-box') as HTMLInputElement;
  expect(box.checked).toBe(true);
  // 点击条目切换选择
  fireEvent.click(item);
  expect(onToggleSelect).toHaveBeenCalledWith('k1');
});

it('selection mode action bar: 删除 calls onBatchDelete, 取消 calls onExitSelect', () => {
  const { onBatchDelete, onExitSelect } = renderSidebar({ selectionMode: true, selectedKeys: new Set<string>(['k1']) });
  fireEvent.click(screen.getByText('删除'));
  expect(onBatchDelete).toHaveBeenCalled();
  fireEvent.click(screen.getByText('取消'));
  expect(onExitSelect).toHaveBeenCalledWith(true);
});

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

  it('unsaved (live, not yet promoted) session shows 未保存 badge and .unsaved class', async () => {
    renderSidebar({
      sessions: [
        { key: 'live-1', cwd: 'C:\\Users\\hcz\\live-dir', name: 'new-session', unsaved: true },
      ],
      statusMap: { 'live-1': 'running' },
    });
    const item = screen.getByText('new-session').closest('.session-item')!;
    expect(item).toHaveClass('unsaved');
    expect(item.querySelector('.unsaved-badge')).toHaveTextContent('未保存');
    // 仍按 cwd 分组显示
    expect(screen.getByText(/C:\\Users\\hcz\\live-dir/)).toBeInTheDocument();
  });

  it('unsaved session has no right-click 删除会话 menu (only terminate allowed)', async () => {
    const { onDeleteSession } = renderSidebar({
      sessions: [
        { key: 'live-1', cwd: 'C:\\Users\\hcz\\live-dir', name: 'new-session', unsaved: true },
      ],
      statusMap: { 'live-1': 'running' },
    });
    const item = screen.getByText('new-session').closest('.session-item')!;
    fireEvent.contextMenu(item);
    // 右键菜单被抑制：不出现“删除会话”，且未调用删除回调
    expect(screen.queryByText('删除会话')).toBeNull();
    expect(onDeleteSession).not.toHaveBeenCalled();
    // 终止按钮仍然可用
    expect(item.querySelector('.terminate')).toBeInTheDocument();
  });
});
