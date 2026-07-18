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
    gitStatus: vi.fn(async () => ({ isGit: true, branch: 'main', dirty: false, ahead: 0, behind: 0, porcelain: '## main' })),
    gitLog: vi.fn(async () => []),
    gitDiff: vi.fn(async () => ''),
    ...overrides,
  };
}

beforeEach(() => {
  seedPi();
});

describe('FilePanel', () => {
  it('renders files tab by default and lists directory entries', async () => {
    render(<FilePanel addedDirs={['C:\\work']} activeCwd={'C:\\work'} onOpenFile={vi.fn()} width={260} onResize={vi.fn()} />);
    // header tabs present
    expect(screen.getByText('📁 文件')).toBeInTheDocument();
    expect(screen.getByText('🌿 Git')).toBeInTheDocument();
    // file tree loads via fsListDir
    expect(await screen.findByText('README.md')).toBeInTheDocument();
    expect(screen.getByText('src')).toBeInTheDocument();
  });

  it('shows an empty-state prompt when there are no directories', () => {
    render(<FilePanel addedDirs={[]} activeCwd={null} onOpenFile={vi.fn()} width={260} onResize={vi.fn()} />);
    expect(screen.getByText(/先用/)).toBeInTheDocument();
    expect(screen.queryByText('README.md')).toBeNull();
  });

  it('switches to the Git tab and shows the branch', async () => {
    render(<FilePanel addedDirs={['C:\\work']} activeCwd={'C:\\work'} onOpenFile={vi.fn()} width={260} onResize={vi.fn()} />);
    fireEvent.click(screen.getByText('🌿 Git'));
    expect(await screen.findByText(/main/)).toBeInTheDocument();
    expect((window as any).pi.gitStatus).toHaveBeenCalledWith('C:\\work');
  });

  it('follows the active session cwd into the root dropdown', async () => {
    const { rerender } = render(
      <FilePanel addedDirs={['C:\\work']} activeCwd={'C:\\work'} onOpenFile={vi.fn()} width={260} onResize={vi.fn()} />,
    );
    // change active cwd → root auto-updates (no manual override yet)
    rerender(<FilePanel addedDirs={['C:\\work', 'C:\\other']} activeCwd={'C:\\other'} onOpenFile={vi.fn()} width={260} onResize={vi.fn()} />);
    const select = screen.getByTitle('根目录') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('C:\\other'));
  });

  it('falls back to the first added dir when root is empty (async addedDirs)', async () => {
    // 模拟 addedDirs 在挂载后才异步到达：先把 addedDirs 传空，再传入真实目录。
    const { rerender } = render(
      <FilePanel addedDirs={[]} activeCwd={null} onOpenFile={vi.fn()} width={260} onResize={vi.fn()} />,
    );
    expect(screen.getByText(/先用/)).toBeInTheDocument();
    rerender(<FilePanel addedDirs={['C:\\added']} activeCwd={null} onOpenFile={vi.fn()} width={260} onResize={vi.fn()} />);
    // 不再显示空提示，且文件树应尝试列出该目录
    await waitFor(() => expect(screen.queryByText(/先用/)).toBeNull());
    expect(screen.getByText('README.md')).toBeInTheDocument();
  });

  it('clicking a file calls onOpenFile with relPath, name, root', async () => {
    const onOpenFile = vi.fn();
    render(<FilePanel addedDirs={['C:\\work']} activeCwd={'C:\\work'} onOpenFile={onOpenFile} width={260} onResize={vi.fn()} />);
    fireEvent.click(await screen.findByText('README.md'));
    expect(onOpenFile).toHaveBeenCalledWith('README.md', 'README.md', 'C:\\work');
  });
});
