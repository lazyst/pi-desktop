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
  const onNewTerminalInAppWorkDir = vi.fn();
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
      appWorkDir={overrides.appWorkDir ?? ''}
      terminalsByCwd={overrides.terminalsByCwd ?? new Map<string, number>()}
      onNewTerminalInAppWorkDir={overrides.onNewTerminalInAppWorkDir ?? onNewTerminalInAppWorkDir}
    />,
  );
  return { onOpen, onTerminate, onPickDirectory, onTogglePin, onDeleteSession, onClearDirectory, onEnterSelect, onExitSelect, onBatchDelete, onToggleSelect, onRemoveDir, onNewTerminalInAppWorkDir, ...utils };
}

it('group “移除目录” action calls onRemoveDir with that cwd', () => {
  const { onRemoveDir } = renderSidebar();
  fireEvent.click(screen.getByLabelText('移除目录 C:\\Users\\hcz\\project'));
  expect(onRemoveDir).toHaveBeenCalledWith('C:\\Users\\hcz\\project');
});

it('renders a group for an added directory even when it has no sessions', () => {
  const { onOpen } = renderSidebar({ addedDirs: ['C:\\Users\\hcz\\empty-dir'] });
  // 分组标题只显示目录名（完整绝对路径见 title 悬停提示，见 ce6f7c5）
  const title = screen.getByText(/empty-dir/);
  expect(title).toBeInTheDocument();
  expect(title.closest('.group-name')).toHaveAttribute('title', 'C:\\Users\\hcz\\empty-dir');
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
    // 分组标题只显示目录名（完整绝对路径见 title 悬停提示，见 ce6f7c5）
    expect(await screen.findByText(/\.pi-agent/)).toBeInTheDocument();
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
    // 分组标题只显示目录名；完整路径在 title 上（见 ce6f7c5）
    expect(groups[0].querySelector('.group-name')).toHaveAttribute('title', 'C:\\Users\\hcz\\project');
    expect(groups[0].textContent).toContain('project');
    expect(groups[1].querySelector('.group-name')).toHaveAttribute('title', 'C:\\Users\\hcz\\.pi-agent');
    expect(groups[1].textContent).toContain('.pi-agent');
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

  it('does NOT show 终止进程 for a session with no status record (not started)', async () => {
    // 回归：磁盘历史/未启动会话在 statusMap 中无记录时不应误显「终止进程」。
    renderSidebar({ statusMap: {} });
    const item = (await screen.findByText('e2e-session')).closest('.session-item')!;
    expect(item.querySelector('.terminate')).toBeNull();
  });

  it('does NOT show 终止进程 for a dead session', async () => {
    // 回归：已退出（'dead'）的会话不应显示「终止进程」。
    renderSidebar({ statusMap: { k1: 'dead' } });
    const item = (await screen.findByText('e2e-session')).closest('.session-item')!;
    expect(item.querySelector('.terminate')).toBeNull();
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
    // 仍按 cwd 分组显示（标题只显示目录名，完整路径见 title，见 ce6f7c5）
    const name = screen.getByText(/live-dir/);
    expect(name).toBeInTheDocument();
    expect(name.closest('.group-name')).toHaveAttribute('title', 'C:\\Users\\hcz\\live-dir');
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
  it('renders the "应用工作目录" group when appWorkDir is provided', () => {
    renderSidebar({ appWorkDir: 'C:\\Users\\hcz\\piDesktop' });
    const title = screen.getByText('📁 应用工作目录');
    expect(title).toBeInTheDocument();
  });

  it('app work dir group shows a terminal count badge from terminalsByCwd', () => {
    const map = new Map<string, number>([['C:\\Users\\hcz\\piDesktop', 3]]);
    renderSidebar({ appWorkDir: 'C:\\Users\\hcz\\piDesktop', terminalsByCwd: map });
    const badge = screen.getByText('3 Terminal');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('terminal-count');
  });

  it('app work dir group "+“ calls onNewTerminalInAppWorkDir', () => {
    const { onNewTerminalInAppWorkDir } = renderSidebar({ appWorkDir: 'C:\\Users\\hcz\\piDesktop' });
    fireEvent.click(screen.getByLabelText('在应用工作目录新建集成终端'));
    expect(onNewTerminalInAppWorkDir).toHaveBeenCalled();
  });

  it('app work dir group does NOT show pin/remove/clear actions', () => {
    renderSidebar({ appWorkDir: 'C:\\Users\\hcz\\piDesktop' });
    expect(screen.queryByLabelText('置顶 C:\\Users\\hcz\\piDesktop')).toBeNull();
    expect(screen.queryByLabelText('移除目录 C:\\Users\\hcz\\piDesktop')).toBeNull();
    expect(screen.queryByLabelText('清空 C:\\Users\\hcz\\piDesktop')).toBeNull();
  });

  it('project group shows terminal count badge and keeps its session actions', () => {
    const map = new Map<string, number>([['C:\\Users\\hcz\\project', 2]]);
    const { onTogglePin } = renderSidebar({ terminalsByCwd: map });
    expect(screen.getByText('2 Terminal')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('置顶 C:\\Users\\hcz\\project'));
    expect(onTogglePin).toHaveBeenCalledWith('C:\\Users\\hcz\\project');
  });

});
