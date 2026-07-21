// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MarkdownPreview } from '../components/MarkdownPreview';

const ROOT = 'C:/work';

beforeEach(() => {
  (window as any).pi = {
    openExternal: vi.fn().mockResolvedValue(true),
  };
});

const MD = `# 标题一
## 章节 A
正文段落，含[内部链接](./docs/intro.md)与[外部站点](https://example.com/page)。

\`\`\`js
const x = 1;
console.log(x);
\`\`\`

## 章节 B
结尾段落。
`;

describe('MarkdownPreview 渲染', () => {
  it('渲染标题并生成目录侧栏（>1 个标题）', async () => {
    render(<MarkdownPreview content={MD} filePath="readme.md" root={ROOT} />);
    expect(document.querySelector('h1')?.textContent).toBe('标题一');
    expect(document.querySelector('h2')?.textContent).toBe('章节 A');
    await waitFor(() => expect(document.querySelector('.md-toc')).toBeInTheDocument());
    // 目录项包含各级标题文本
    const tocItems = document.querySelectorAll('.md-toc-item');
    expect(tocItems.length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText('目录')).toBeInTheDocument();
  });

  it('代码块带复制按钮', async () => {
    render(<MarkdownPreview content={MD} filePath="readme.md" root={ROOT} />);
    await waitFor(() => expect(document.querySelector('.md-codeblock')).toBeInTheDocument());
    expect(screen.getByText('复制')).toBeInTheDocument();
  });

  it('相对链接点击 → 应用内切到目标文件', async () => {
    const onOpenFile = vi.fn();
    render(<MarkdownPreview content={MD} filePath="readme.md" root={ROOT} onOpenFile={onOpenFile} />);
    const link = await screen.findByText('内部链接');
    fireEvent.click(link);
    expect(onOpenFile).toHaveBeenCalledWith('docs/intro.md', 'intro.md', ROOT);
    expect((window as any).pi.openExternal).not.toHaveBeenCalled();
  });

  it('外部链接点击 → 走 openExternal（不在应用内跳转）', async () => {
    const onOpenFile = vi.fn();
    render(<MarkdownPreview content={MD} filePath="readme.md" root={ROOT} onOpenFile={onOpenFile} />);
    const link = await screen.findByText('外部站点');
    fireEvent.click(link);
    expect((window as any).pi.openExternal).toHaveBeenCalledWith('https://example.com/page');
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it('mermaid 代码块渲染为 MermaidBlock 容器', async () => {
    const mermaidMd = '```mermaid\nflowchart TD\n  A-->B\n```';
    render(<MarkdownPreview content={mermaidMd} filePath="readme.md" root={ROOT} />);
    await waitFor(() => expect(document.querySelector('.md-mermaid')).toBeInTheDocument());
    expect(document.querySelector('.md-codeblock')).toBeNull();
  });
});
