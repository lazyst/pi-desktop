// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FileTree } from '../components/FileTree';

// 可变目录清单：模拟文件树在新建后重新拉取能看到新文件。
function makePi() {
  const files = [
    { name: 'src', isDir: true, size: 0, mtime: 0 },
    { name: 'README.md', isDir: false, size: 10, mtime: 0 },
  ];
  const api = {
    fsListDir: vi.fn(async (_root: string, dirPath: string) => {
      if (dirPath === '') return files.map((f) => ({ ...f }));
      if (dirPath === 'src') return [
        { name: 'index.ts', isDir: false, size: 5, mtime: 0 },
        { name: 'components', isDir: true, size: 0, mtime: 0 },
      ];
      if (dirPath === 'src/components') return [
        { name: 'App.tsx', isDir: false, size: 10, mtime: 0 },
      ];
      return [];
    }),
    fsListNames: vi.fn(async () => files.map((f) => f.name)),
    fsUniqueName: vi.fn(async (base: string) => base),
    fsCreateFile: vi.fn(async (_root: string, relPath: string) => {
      const name = relPath.includes('/') ? relPath.slice(relPath.lastIndexOf('/') + 1) : relPath;
      files.push({ name, isDir: false, size: 0, mtime: 0 });
    }),
    fsMkdir: vi.fn(async (_root: string, relPath: string) => {
      const name = relPath.includes('/') ? relPath.slice(relPath.lastIndexOf('/') + 1) : relPath;
      files.push({ name, isDir: true, size: 0, mtime: 0 });
    }),
    gitStatus: vi.fn(async () => ({ isGit: true, branch: 'main', dirty: false, ahead: 0, behind: 0, porcelain: '## main' })),
    gitLog: vi.fn(async () => []),
    gitDiff: vi.fn(async () => ''),
    gitFileStatusMap: vi.fn(async () => ({})),
    gitIgnoredPaths: vi.fn(async () => []),
    fsWatch: vi.fn(() => vi.fn()),
  } as any;
  return api;
}

describe('FileTree 文件管理：根目录新建', () => {
  let api: ReturnType<typeof makePi>;
  beforeEach(() => {
    api = makePi();
    (window as any).pi = api;
  });

  it('右键空白区 → 新建文件 → 输入回车 → fsCreateFile 被调用且树刷新显示新文件', async () => {
    render(<FileTree root={'C:\\work'} onOpenFile={vi.fn()} />);

    // 初始树渲染
    expect(await screen.findByText('README.md')).toBeInTheDocument();

    // 右键文件树空白处（用 file-tree 容器）
    const tree = screen.getByText('README.md').closest('.file-tree') as HTMLElement;
    fireEvent.contextMenu(tree);

    // 菜单出现「新建文件」
    const newFileItem = await screen.findByText('新建文件');
    fireEvent.click(newFileItem);

    // 根目录 inline input 出现（独立输入行）
    const input = await screen.findByDisplayValue('新建文件') as HTMLInputElement;
    expect(input).toBeInTheDocument();

    // 清空并输入新名
    fireEvent.change(input, { target: { value: 'hello.txt' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // 断言落盘调用
    await waitFor(() => expect(api.fsCreateFile).toHaveBeenCalledWith('C:\\work', 'hello.txt', ''));

    // 断言树刷新后出现新文件（bumpDir('') 重新拉取 roots）
    expect(await screen.findByText('hello.txt')).toBeInTheDocument();
  });
});

describe('FileTree 虚拟滚动：目录展开', () => {
  let api: ReturnType<typeof makePi>;
  beforeEach(() => {
    api = makePi();
    (window as any).pi = api;
  });

  it('点击目录展开 → 子文件可见', async () => {
    render(<FileTree root={'C:\\work'} onOpenFile={vi.fn()} />);

    // 等待根目录渲染
    expect(await screen.findByText('src')).toBeInTheDocument();
    expect(await screen.findByText('README.md')).toBeInTheDocument();

    // 点击 src 目录展开
    const srcEl = screen.getByText('src');
    const srcRow = srcEl.closest('.file-row') as HTMLElement;
    fireEvent.click(srcRow);

    // 等待子文件加载并渲染
    await waitFor(() => {
      expect(screen.getByText('index.ts')).toBeInTheDocument();
    });
    expect(screen.getByText('components')).toBeInTheDocument();
  });

  it('展开目录后再点击折叠 → 子文件隐藏', async () => {
    render(<FileTree root={'C:\\work'} onOpenFile={vi.fn()} />);

    // 展开 src
    const srcEl = await screen.findByText('src');
    const srcRow = srcEl.closest('.file-row') as HTMLElement;
    fireEvent.click(srcRow);
    await waitFor(() => {
      expect(screen.getByText('index.ts')).toBeInTheDocument();
    });

    // 折叠 src
    fireEvent.click(srcRow);

    // 子文件不再可见
    await waitFor(() => {
      expect(screen.queryByText('index.ts')).not.toBeInTheDocument();
    });
  });

  it('嵌套目录：展开 src/components 可见 App.tsx', async () => {
    render(<FileTree root={'C:\\work'} onOpenFile={vi.fn()} />);

    // 展开 src
    const srcEl = await screen.findByText('src');
    const srcRow = srcEl.closest('.file-row') as HTMLElement;
    fireEvent.click(srcRow);
    await waitFor(() => {
      expect(screen.getByText('components')).toBeInTheDocument();
    });

    // 展开 src/components
    const componentsEl = screen.getByText('components');
    const componentsRow = componentsEl.closest('.file-row') as HTMLElement;
    fireEvent.click(componentsRow);
    await waitFor(() => {
      expect(screen.getByText('App.tsx')).toBeInTheDocument();
    });
  });
});