// Code editor + syntax-highlighted preview built on CodeMirror 6.
// Language is loaded on demand by extension. Editing is enabled; the parent
// tracks the dirty state by comparing against the initial content via the
// `onChange` callback.
//
// Markdown files get an extra twist: a Preview/Edit toggle. In Preview mode the
// rendered HTML is shown (read-only); in Edit mode the CodeMirror editor is
// active so the user can make changes and save them (Ctrl/Cmd+S in the drawer).
import { useEffect, useRef, useState } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { markdown as markdownLang } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import { pi } from '../ipc';

function themeIsDark(): boolean {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light') return false;
  if (attr === 'dark') return true;
  return true; // no attribute → default dark palette
}

function langExtension(language: string) {
  switch (language) {
    case 'typescript': return javascript({ typescript: true });
    case 'javascript': return javascript();
    case 'python': return python();
    case 'json': return json();
    case 'markdown': return markdownLang();
    case 'yaml': return yaml();
    default: return [];
  }
}

// Permissive sanitize schema: allow GFM tables, task lists, and KaTeX spans.
const markdownSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [['className', /^language-./, 'math-inline', 'math-display']],
  },
  strip: [...(defaultSchema.strip || []), 'iframe', 'object', 'style', 'form'],
};

interface Props {
  root: string;
  path: string; // relative path within root
  onChange?: (content: string) => void;
  /** 点击预览内相对链接时，在应用内切到目标文件（与文件树 onOpenFile 同语义）。
   *  不传则相对链接退化为"系统默认程序打开"（经 pi.openExternal）。 */
  onOpenFile?: (relPath: string, fileName: string, root: string) => void;
}

// 渲染 markdown 锚点：
//  - 相对链接（./x.md、../y.md、x.md）→ 以当前文件所在目录为基准解析出目标
//    relPath，在应用内切到该文件预览（onOpenFile）；未提供 onOpenFile 时退化为系统打开。
//  - 绝对外链（http(s)/mailto）→ 经受控通道 pi.openExternal 用系统默认程序打开
//    （will-navigate 兜底锁也会拦截，但此处显式拦截避免窗口闪烁/导航尝试）。
//  - 其他（绝对 file://、奇怪协议）→ 一律经 pi.openExternal，绝不触发窗口导航。
// 判定一个 href 是否为「绝对外部协议」（需走系统默认程序打开）。
// 带协议scheme（http(s)/mailto/等）视为外部；file: 视为本地（不在此列，由 webview 隔离处理）。
export function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('file:');
}

// 以当前文件目录（相对 root）为基准，把 markdown 相对链接解析为相对 root 的目标路径。
// 例：baseDir='docs'、href='./api.md' → 'docs/api.md'；href='../README.md' → 'docs/../README.md'。
// 仅剥掉 ./ 前缀与多余分隔符；.. 回退不做字符串级 parent-walk，而是原样保留，
// 交给主进程 fsBridge 用 nodePath.resolve + 越界校验做权威解析。
export function resolveRelativeLink(baseDir: string, href: string): string {
  const cleanBase = baseDir.replace(/[\\/]+$/, '');
  const cleanHref = href.replace(/^[\\/]+/, '').replace(/^\.\//, '');
  return cleanBase ? `${cleanBase}/${cleanHref}` : cleanHref;
}

function makeLinkRenderer(onOpenFile?: Props['onOpenFile'], baseDir = '', root = '') {
  return function LinkRenderer(props: { href?: string; children?: React.ReactNode }) {
    const { href, children, ...rest } = props as any;
    const handleClick = (e: React.MouseEvent) => {
      if (!href) return;
      if (isExternalHref(href)) {
        e.preventDefault();
        void pi.openExternal(href);
        return;
      }
      // 相对路径：以当前文件目录为基准解析出相对 root 的目标 relPath。
      const target = baseDir ? `${baseDir.replace(/[\\/]+$/, '')}/${href.replace(/^[\\/]+/, '')}` : href;
      const name = target.split(/[\\/]/).pop() ?? target;
      e.preventDefault();
      if (onOpenFile) onOpenFile(target, name, root);
      else void pi.openExternal(href);
    };
    const external = isExternalHref(href);
    return (
      <a
        href={href}
        onClick={handleClick}
        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        {...rest}
      >
        {children}
      </a>
    );
  };
}

export function CodePreview({ root, path, onChange, onOpenFile }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeCompartment = useRef(new Compartment());
  const langCompartment = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // 当前文件的目录（相对 root），用于解析 markdown 相对链接的基准。
  const baseDir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

  const [language, setLanguage] = useState('');
  const [content, setContent] = useState('');
  const [previewMode, setPreviewMode] = useState(false);
  // Tracks the content the editor was last built from, so toggling preview
  // mode back to edit re-creates the editor with the current text.
  const editorContentRef = useRef('');

  const isMarkdown = language === 'markdown';

  // Load content from disk when the file path changes.
  useEffect(() => {
    let cancelled = false;
    setPreviewMode(false);
    setLanguage('');
    setContent('');
    editorContentRef.current = '';

    (async () => {
      let fileContent = '';
      let fileLanguage = '';
      try {
        const res = await pi.fsReadFile(root, path);
        fileContent = res.content;
        fileLanguage = res.language;
      } catch {
        fileContent = '';
        fileLanguage = '';
      }
      if (cancelled) return;

      setLanguage(fileLanguage);
      setContent(fileContent);
      // Markdown files open in preview mode by default (rendered HTML).
      setPreviewMode(fileLanguage === 'markdown');
    })();

    return () => { cancelled = true; };
  }, [root, path]);

  // Create / destroy the CodeMirror editor based on the current mode.
  // The editor is only mounted when we are NOT in markdown-preview mode.
  const showEditor = !isMarkdown || !previewMode;
  useEffect(() => {
    if (!showEditor) {
      viewRef.current?.destroy();
      viewRef.current = null;
      return;
    }
    if (!hostRef.current) return;

    const doc = editorContentRef.current || content;
    const updateListener = EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        const next = u.state.doc.toString();
        setContent(next);
        onChangeRef.current?.(next);
      }
    });

    const extensions = [
      lineNumbers(),
      history(),
      highlightActiveLine(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      langCompartment.current.of(langExtension(language)),
      themeCompartment.current.of(themeIsDark() ? oneDark : []),
      EditorView.theme({
        '&': { height: '100%', fontSize: 'calc(13px * var(--font-scale))' },
        '.cm-scroller': { fontFamily: 'var(--font-mono)', overflow: 'auto' },
      }),
      updateListener,
    ];

    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({ doc, extensions }),
    });
    viewRef.current = view;

    return () => {
      // Remember the latest text so re-entering edit mode preserves edits.
      editorContentRef.current = view.state.doc.toString();
      view.destroy();
      viewRef.current = null;
    };
  }, [showEditor, root, path, language]);

  // React to theme switches while open.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      viewRef.current?.dispatch({
        effects: themeCompartment.current.reconfigure(themeIsDark() ? oneDark : []),
      });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return (
    <div className="code-preview-wrap">
      {isMarkdown && (
        <div className="code-preview-toolbar">
          <div className="code-preview-toggle">
            <button
              type="button"
              className={previewMode ? '' : 'is-active'}
              onClick={() => setPreviewMode(false)}
            >
              编辑
            </button>
            <button
              type="button"
              className={previewMode ? 'is-active' : ''}
              onClick={() => setPreviewMode(true)}
            >
              预览
            </button>
          </div>
        </div>
      )}
      {isMarkdown && previewMode ? (
        <div className="markdown-body markdown-file-preview">
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeRaw, [rehypeSanitize, markdownSanitizeSchema], [rehypeKatex, { throwOnError: false, strict: false }]]}
            components={{ a: makeLinkRenderer(onOpenFile, baseDir, root) as any }}
          >
            {content}
          </ReactMarkdown>
        </div>
      ) : (
        <div className="code-preview" ref={hostRef} />
      )}
    </div>
  );
}
