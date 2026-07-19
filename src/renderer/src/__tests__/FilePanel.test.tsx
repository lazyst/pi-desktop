// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FilePanel } from '../components/FilePanel';

function seedPi(overrides: Record<string, any> = {}) {
  (window as any).pi = {
    fsListDir: vi.fn(async (_root: string, _dir: string) => [
      { name: 'src', isDir: true, size: 0, mtime: 0 },
      { name: 'README.md', isDir: false, size: 10, mtime: 0 },
    ]),
    gitStatus: vi.fn(async () => ({ isGit: true, branch: 'main', additions: 0, deletions: 0, ahead: 0, behind: 0, porcelain: '## main' })),
    gitLog: vi.fn(async () => []),
    gitDiff: vi.fn(async () => ''),
    // GitView 挂载时订阅工作区实时变更（事件驱动刷新）；测试无需真实监听。
    gitWatch: vi.fn(() => () => {}),
    ...overrides,
  };
}

// Git 面板点击「工作区改动」/某次提交 → 在右侧抽屉打开 diff（由 App 接管）。
// 这两个回调不在此测试内断言，仅作为必填 props 提供 mock。
const baseProps = {
  onOpenWorkDiff: vi.fn(),
  onOpenCommit: vi.fn(),
  onOpenFile: vi.fn(),
  width: 260,
  onResize: vi.fn(),
};

beforeEach(() => {
  seedPi();
});

describe('FilePanel', () => {
  it('renders files tab by default and lists directory entries', async () => {
    render(<FilePanel addedDirs={['C:\\work']} activeCwd={'C:\\work'} {...baseProps} />);
    // header tabs present
    expect(screen.getByText('📁 文件')).toBeInTheDocument();
    expect(screen.getByText('🌿 Git')).toBeInTheDocument();
    // file tree loads via fsListDir
    expect(await screen.findByText('README.md')).toBeInTheDocument();
    expect(screen.getByText('src')).toBeInTheDocument();
  });

  it('shows an empty-state prompt when there are no directories', () => {
    render(<FilePanel addedDirs={[]} activeCwd={null} {...baseProps} />);
    expect(screen.getByText(/先用/)).toBeInTheDocument();
    expect(screen.queryByText('README.md')).toBeNull();
  });

  it('switches to the Git tab and shows the branch', async () => {
    render(<FilePanel addedDirs={['C:\\work']} activeCwd={'C:\\work'} {...baseProps} />);
    fireEvent.click(screen.getByText('🌿 Git'));
    expect(await screen.findByText(/main/)).toBeInTheDocument();
    expect((window as any).pi.gitStatus).toHaveBeenCalledWith('C:\\work');
  });

  it('stays in auto-follow mode (dropdown shows __auto__) when active session changes', async () => {
    const { rerender } = render(
      <FilePanel addedDirs={['C:\\work']} activeCwd={'C:\\work'} {...baseProps} />,
    );
    // change active cwd → root auto-updates, but the dropdown stays on the
    // “auto” option (not locked to a concrete dir, since we never overrode).
    rerender(<FilePanel addedDirs={['C:\\work', 'C:\\other']} activeCwd={'C:\\other'} {...baseProps} />);
    const select = screen.getByTitle('根目录') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('__auto__'));
    // 文件树根目录实际跟随到了新会话 cwd（Git 视图会被传入新 cwd）。
    fireEvent.click(screen.getByText('🌿 Git'));
    expect(await screen.findByText(/main/)).toBeInTheDocument();
    expect((window as any).pi.gitStatus).toHaveBeenCalledWith('C:\\other');
  });

  it('uses auto-follow mode by default when addedDirs exist but no session is open', async () => {
    // 产品逻辑：未打开会话时，即使 addedDirs 已存在，文件树也保持空
    // （显示“未选择工作目录”），但下拉框处于“自动·跟随会话”模式（高亮 __auto__），
    // 待用户打开会话后会自动跟随。
    render(<FilePanel addedDirs={['C:\\added']} activeCwd={null} {...baseProps} />);
    expect(screen.getByText('未选择工作目录')).toBeInTheDocument();
    const select = screen.getByTitle('根目录') as HTMLSelectElement;
    expect(select.value).toBe('__auto__');
  });

  it('shows files after the user manually picks an added dir', async () => {
    render(<FilePanel addedDirs={['C:\\added']} activeCwd={null} {...baseProps} />);
    const select = screen.getByTitle('根目录') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'C:\\added' } });
    expect(await screen.findByText('README.md')).toBeInTheDocument();
  });

  it('does not follow active session after a manual pick, but recovers via auto option', async () => {
    const { rerender } = render(
      <FilePanel addedDirs={['C:\\work', 'C:\\other']} activeCwd={'C:\\work'} {...baseProps} />,
    );
    const select = screen.getByTitle('根目录') as HTMLSelectElement;
    // 手动选一个具体目录 → 退出自动模式
    fireEvent.change(select, { target: { value: 'C:\\work' } });
    expect(select.value).toBe('C:\\work');
    // 切换活动会话 → 文件树根目录不应被抢回（保持手动选择）
    rerender(<FilePanel addedDirs={['C:\\work', 'C:\\other']} activeCwd={'C:\\other'} {...baseProps} />);
    expect((screen.getByTitle('根目录') as HTMLSelectElement).value).toBe('C:\\work');
    // 选回“自动·跟随会话” → 恢复跟随新活动会话 cwd
    fireEvent.change(screen.getByTitle('根目录'), { target: { value: '__auto__' } });
    expect((screen.getByTitle('根目录') as HTMLSelectElement).value).toBe('__auto__');
    rerender(<FilePanel addedDirs={['C:\\work', 'C:\\other']} activeCwd={'C:\\other'} {...baseProps} />);
    fireEvent.click(screen.getByText('🌿 Git'));
    expect(await screen.findByText(/main/)).toBeInTheDocument();
    expect((window as any).pi.gitStatus).toHaveBeenCalledWith('C:\\other');
  });

  it('clicking a file calls onOpenFile with relPath, name, root', async () => {
    const onOpenFile = vi.fn();
    render(<FilePanel addedDirs={['C:\\work']} activeCwd={'C:\\work'} onOpenWorkDiff={vi.fn()} onOpenCommit={vi.fn()} onOpenFile={onOpenFile} width={260} onResize={vi.fn()} />);
    fireEvent.click(await screen.findByText('README.md'));
    expect(onOpenFile).toHaveBeenCalledWith('README.md', 'README.md', 'C:\\work');
  });
});
