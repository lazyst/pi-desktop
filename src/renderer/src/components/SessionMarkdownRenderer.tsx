// 会话内容 markdown 渲染组件（轻量版 MarkdownPreview）。
// 复用 MarkdownPreview 的插件链（react-markdown + remark-gfm/breaks/frontmatter/math
// + rehype-raw/sanitize/slug/highlight/katex），但去掉文件路径解析和 TOC 侧边栏。
// 专用于 SessionContentView 中 assistant 消息的 finalText 渲染。

import { useCallback, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';

import { MermaidBlock } from './MermaidBlock';
import { pi } from '../ipc';
import { ContextMenu } from './ContextMenu';
import { useMarkdownContextMenu, buildPreviewContextMenu, findLinkHref } from './editor/useMarkdownContextMenu';

// 与 MarkdownPreview 一致的 sanitize schema
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'details', 'summary', 'kbd', 'sub', 'sup', 'ins'],
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), 'file'],
    src: [...(defaultSchema.protocols?.src ?? []), 'file'],
  },
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*'] ?? []), 'id'],
    a: [...(defaultSchema.attributes?.a ?? []), 'href', 'title'],
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      ['className', /^language-[\w-]+$/],
      ['className', 'hljs'],
    ],
    div: [...(defaultSchema.attributes?.div ?? []), ['className', /^language-[\w-]+$/], 'align'],
    h1: [...(defaultSchema.attributes?.h1 ?? []), 'id'],
    h2: [...(defaultSchema.attributes?.h2 ?? []), 'id'],
    h3: [...(defaultSchema.attributes?.h3 ?? []), 'id'],
    h4: [...(defaultSchema.attributes?.h4 ?? []), 'id'],
    h5: [...(defaultSchema.attributes?.h5 ?? []), 'id'],
    h6: [...(defaultSchema.attributes?.h6 ?? []), 'id'],
    img: [...(defaultSchema.attributes?.img ?? []), 'src', 'alt', 'title', 'width', 'height'],
    input: [...(defaultSchema.attributes?.input ?? []), 'type', 'checked', 'disabled'],
    pre: [...(defaultSchema.attributes?.pre ?? []), ['className', /^language-[\w-]+$/]],
    span: [...(defaultSchema.attributes?.span ?? []), ['className', /^hljs(?:-[\w-]+)?$/]],
    td: [...(defaultSchema.attributes?.td ?? []), 'align'],
    th: [...(defaultSchema.attributes?.th ?? []), 'align'],
  },
};

const remarkPlugins = [remarkGfm, remarkBreaks, remarkFrontmatter, remarkMath];

function nodeText(node: ReactNode): string {
  if (node == null || node === false || node === true) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (typeof node === 'object' && 'props' in node) {
    return nodeText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return '';
}

interface Props {
  content: string;
}

export function SessionMarkdownRenderer({ content }: Props) {
  const { menuState, setMenuState, closeMenu } = useMarkdownContextMenu();

  const components: Components = {
    // 代码块：mermaid 走专用渲染；其余加复制按钮。
    pre: ({ children }) => {
      const codeEl = Array.isArray(children)
        ? children.find((c) => typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'code')
        : typeof children === 'object' && children !== null && (children as { type?: unknown }).type === 'code'
          ? children
          : null;
      const codeProps =
        codeEl && typeof codeEl === 'object' ? (codeEl as { props?: { className?: string; children?: ReactNode } }).props : null;
      const lang = codeProps?.className ? /language-(\w+)/.exec(codeProps.className)?.[1] : undefined;
      const text = codeProps ? nodeText(codeProps.children) : '';
      if (lang === 'mermaid') return <MermaidBlock code={text} />;
      return (
        <div className="md-codeblock">
          <button
            type="button"
            className="md-copy"
            onClick={() => {
              navigator.clipboard?.writeText(text).catch(() => {});
            }}
          >
            复制
          </button>
          <pre>{children}</pre>
        </div>
      );
    },
    // 链接：外部 → openExternal；#anchor → 默认滚动行为；其余 fallback 到 openExternal。
    a: ({ href, children, node, ...rest }) => {
      const handle = (e: React.MouseEvent) => {
        if (!href) return;
        // 外部协议（http/https/mailto 等）走系统默认程序
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('file:')) {
          e.preventDefault();
          void pi.openExternal(href).catch(() => {});
          return;
        }
        // #anchor 由浏览器默认滚动行为处理
        if (href.startsWith('#')) return;
        // 其余链接（相对路径、file:// 等）尝试用系统默认程序打开
        e.preventDefault();
        void pi.openExternal(href).catch(() => {});
      };
      return (
        <a href={href} onClick={handle} {...rest}>
          {children}
        </a>
      );
    },
    // 图片：不做路径解析，直接渲染
    img: ({ src, alt, node, ...rest }) => {
      return <img src={src} alt={alt} {...rest} />;
    },
  };

  // 右键菜单
  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const target = e.target instanceof HTMLElement ? e.target : null;
    const linkHref = target ? findLinkHref(target) : null;
    const items = buildPreviewContextMenu(linkHref);
    setMenuState({ x: e.clientX, y: e.clientY, items });
  }, [setMenuState]);

  return (
    <div className="session-markdown-renderer" onContextMenu={onContextMenu}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={[
          rehypeRaw,
          [rehypeSanitize, sanitizeSchema],
          rehypeSlug,
          rehypeHighlight,
          rehypeKatex,
        ]}
        components={components}
        urlTransform={(url: string) => url}
      >
        {content}
      </ReactMarkdown>
      {menuState && (
        <ContextMenu x={menuState.x} y={menuState.y} items={menuState.items} onClose={closeMenu} />
      )}
    </div>
  );
}